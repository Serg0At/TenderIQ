import { getSourceConfig } from '../../../../configs/sources.config.js';
import { fetchPage, postJson } from '../../../../utils/http.js';
import { acquire, RateLimitedError } from '../../../../utils/rateLimiter.js';

/**
 * PPCM's public reports (armeps.am/ppcm/public/reports): an AngularJS page
 * whose JSON endpoints answer behind a session cookie, which loading the page
 * hands out. Both URLs are built here from the configured base, never taken
 * from a response.
 *
 * The request shape is research.md's (*Verification against our e-auction
 * ledger*): `values` is a list of `{ paramId, value }` whose value is a
 * **plain string** — an array answers HTTP 400 — and `page` is
 * `{ index, size }`, since any other paging shape silently caps at 15 rows.
 */
const SOURCE = 'ppcm';

export const reportsPageUrl = () => `${getSourceConfig(SOURCE).baseUrl}/ppcm/public/reports`;
export const reportUrl = () => `${getSourceConfig(SOURCE).baseUrl}/ppcm/public/reports/get-report`;

/** Politeness gate, in order: rate limit, then HTTP — armeps.am's budget, which PPCM shares. */
const gate = async () => {
  const budget = getSourceConfig(SOURCE).rateLimitSource;
  const waitMs = await acquire(budget, getSourceConfig(budget).rateLimit);
  if (waitMs > 0) throw new RateLimitedError(SOURCE, waitMs);
};

/**
 * This process's session. Held in memory: a worker that restarts opens a new
 * one with one page load, and replicas holding one each cost nothing more.
 */
let session = null;

const openSession = async () => {
  await gate();
  const page = await fetchPage(reportsPageUrl());
  const cookie = page.cookies.find((c) => /^JSESSIONID=/i.test(c));
  if (!cookie) throw new Error(`[${SOURCE}] the reports page set no session cookie`);
  session = { cookie };
  return session;
};

/** PPCM answers `{ status: 0, data }` when it served the request; anything else did not. */
const served = (response) => Boolean(response.json) && response.json.status === 0;

const refusal = (response) =>
  response.httpStatus
    ? `HTTP ${response.httpStatus}`
    : response.json
      ? `status ${response.json.status}`
      : `a ${response.contentType || 'non-JSON'} body`;

/** PPCM refused a request it should have served: a broken endpoint, not a broken network. */
export class RefusedError extends Error {}

/**
 * One POST to PPCM, answered or thrown.
 *
 * A refused answer — an HTTP error, a non-zero `status`, or a body that is
 * not JSON (a login or error page) — is what an expired session looks like,
 * so the session is renewed and the request asked once more. Only a session
 * that was already in use is renewed: if a fresh one is refused too, the
 * failure is PPCM's, and it is thrown for the job's retry and backoff rather
 * than answered by another page load — and the session is dropped, so the
 * retry starts from a fresh one instead of the cookie that was refused.
 *
 * Returns the body as received, for storage, and the parsed `data`.
 */
const askJson = async (url, payload, what) => {
  const ask = async (current) => {
    await gate();
    try {
      return await postJson(url, payload, { cookie: current.cookie });
    } catch (error) {
      // An HTTP error status is a refusal like any other; no answer at all
      // (a timeout, a reset) is not about the session, and is thrown as is.
      if (error.response) return { httpStatus: error.response.status, json: null };
      throw error;
    }
  };

  const reused = Boolean(session);
  let response = await ask(session ?? (await openSession()));
  if (!served(response) && reused) response = await ask(await openSession());
  if (!served(response)) {
    session = null;
    throw new RefusedError(`[${SOURCE}] ${what} refused: ${refusal(response)}`);
  }
  if (!Array.isArray(response.json.data)) {
    throw new Error(`[${SOURCE}] ${what}: \`data\` is not a list`);
  }
  return { body: response.body, data: response.json.data };
};

/** One page of one report: the body as received, and its rows. */
export const fetchReportPage = async ({ reportId, values, index, size }) => {
  const payload = {
    reportId,
    values: values.map(({ paramId, value }) => ({ paramId, value: String(value) })),
    page: { index, size },
    order: null,
  };
  const { body, data } = await askJson(reportUrl(), payload, `report ${reportId} page ${index}`);
  return { body, rows: data };
};

/** Every page of one query, until a short page; more than `maxPages` is refused, not truncated. */
const fetchAllPages = async ({ reportId, values, pageSize, maxPages, what }) => {
  const bodies = [];
  const rows = [];
  for (let index = 0; index < maxPages; index += 1) {
    const page = await fetchReportPage({ reportId, values, index, size: pageSize });
    bodies.push(page.body);
    rows.push(...page.rows);
    if (page.rows.length < pageSize) return { bodies, rows };
  }
  throw new Error(`[${SOURCE}] ${what}: more than ${maxPages} pages of ${pageSize} rows`);
};

/**
 * Every row of the organized-procedures report for one procedure code. Returns
 * the raw bodies — what is stored — and the rows. More pages than `maxPages`
 * is refused: a ledger cut short would read as a complete one.
 */
export const fetchProcedureRows = async (code) => {
  const { reportId, codeParamId, pageSize, maxPages } = getSourceConfig(SOURCE).organizedProcedures;
  return fetchAllPages({ reportId, values: [{ paramId: codeParamId, value: code }], pageSize, maxPages, what: code });
};

/**
 * Every row of one procedure form announced on one day (`YYYY-MM-DD`), for
 * the missed-tender sweep (ticket 12). Both ends of PPCM's date range are
 * inclusive, so the day is asked as itself twice.
 */
export const fetchDayRows = async ({ form, day }) => {
  const { reportId, formParamId, announcedParamId } = getSourceConfig(SOURCE).organizedProcedures;
  const { pageSize, maxPages } = getSourceConfig(SOURCE).missedSweep;
  const values = [
    { paramId: formParamId, value: form },
    { paramId: announcedParamId, value: `${day},${day}` },
  ];
  return fetchAllPages({ reportId, values, pageSize, maxPages, what: `${form} on ${day}` });
};

export const bidReportUrl = () => `${getSourceConfig(SOURCE).baseUrl}/ppcm/public/bid-report/list-tender`;

/**
 * bid-report's tenders of one procedure code: each with its `armepsId` (the
 * armeps.am `resourceId`), `paperBased` and `datePublished`. The filter is
 * exact on the code. It must be sent whole, every field present and an
 * `order` given, as the page itself sends it: anything less answers
 * `{"status":500}` (sources.config.js#ppcm.bidReport). A refusal is a
 * `RefusedError`, which the sweep reads as "bid-report is unavailable".
 */
export const fetchBidReportTenders = async (code) => {
  const { pageSize } = getSourceConfig(SOURCE).bidReport;
  const payload = {
    filter: {
      code,
      publicationDate: { min: null, max: null },
      tenderSubmissionDeadline: { min: null, max: null },
    },
    order: { field: 'tender_submission_deadline', ascending: false },
    page: { index: 0, size: pageSize },
  };
  const { body, data } = await askJson(bidReportUrl(), payload, `bid-report for ${code}`);
  return { body, tenders: data };
};

export default {
  reportsPageUrl,
  reportUrl,
  bidReportUrl,
  fetchReportPage,
  fetchProcedureRows,
  fetchDayRows,
  fetchBidReportTenders,
  RefusedError,
};
