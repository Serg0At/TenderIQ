import { sha256 } from '../../../../utils/hash.js';
import { reportsPageUrl } from './client.js';

/**
 * A stored PPCM organized-procedures report → results observations for the
 * resolution module (services/resolution.service.js), one per procedure, each
 * carrying its ledger in the shape `tenders.recordResults` writes. The
 * counterpart of armeps/observation.js for the ARMEPS channel's results
 * (ADR 0004: PPCM owns `awarded` there).
 *
 * No network, no database and no clock: a replay from storage decides what
 * the first read decided.
 */
export const SOURCE = 'ppcm';

/**
 * The stored payload: the report pages exactly as received, inside the query
 * that produced them, so a replay knows the code and every page of it. Built
 * by string so each body is kept byte for byte, and two identical answers
 * hash the same and write nothing.
 */
export const storedPayload = ({ reportId, code, bodies }) =>
  `{"reportId":${JSON.stringify(reportId)},"code":${JSON.stringify(code)},"responses":[${bodies.join(',')}]}`;

/**
 * The stored payload of one sweep query (ticket 12): one form, one
 * announcement day, its pages as received. `parseStored` reads it like an
 * answer by code, with no code.
 */
export const storedDayPayload = ({ reportId, form, day, bodies }) =>
  `{"reportId":${JSON.stringify(reportId)},"form":${JSON.stringify(form)},"day":${JSON.stringify(day)},` +
  `"responses":[${bodies.join(',')}]}`;

/** A bid-report answer for one code, stored as received inside the code it was asked for. */
export const storedBidReport = ({ code, body }) => `{"code":${JSON.stringify(code)},"response":${body}}`;

/** A stored bid-report answer → its tenders. One PPCM did not serve is refused, as a report page is. */
export const parseBidReport = (stored) => {
  const doc = JSON.parse(stored);
  if (doc.response?.status !== 0 || !Array.isArray(doc.response.data)) {
    throw new Error(`[${SOURCE}] a stored bid-report answer that PPCM did not serve (status ${doc.response?.status})`);
  }
  return { code: doc.code, tenders: doc.response.data };
};

/**
 * A stored payload → `{ reportId, code, rows }`, each row an object keyed by
 * `columns`. A row of any other length is refused: the report's columns moved,
 * and reading it by position would put a price in the wrong field.
 */
export const parseStored = (text, { columns }) => {
  const doc = JSON.parse(text);
  const rows = [];
  for (const response of doc.responses ?? []) {
    if (response?.status !== 0 || !Array.isArray(response.data)) {
      throw new Error(`[${SOURCE}] a stored page that PPCM did not serve (status ${response?.status})`);
    }
    for (const values of response.data) {
      if (!Array.isArray(values) || values.length !== columns.length) {
        throw new Error(
          `[${SOURCE}] a row of ${Array.isArray(values) ? values.length : typeof values} columns, the config names ` +
            `${columns.length} — the report's outputFormats changed (sources.config.js#ppcm.organizedProcedures)`
        );
      }
      rows.push(Object.fromEntries(columns.map((column, i) => [column, values[i]])));
    }
  }
  return { reportId: doc.reportId, code: doc.code, rows };
};

const time = (ms) => (Number.isFinite(ms) ? new Date(ms) : null);

/**
 * PPCM states an e-auction's announcement and opening as Yerevan wall-clock
 * time written as if it were UTC: 4 hours later than eauction.armeps.am's own
 * page says, on every e-auction compared (ticket 11), while its ARMEPS times
 * equal armeps.am's to the minute. Read as given, an e-auction announced after
 * 20:00 Yerevan falls on the next day and rule 3's dates disagree — 34 of 673
 * awarded e-auctions. Armenia has kept UTC+4 all year since 2012, so the
 * offset is exact.
 */
const EAUCTION_CLOCK_SKEW_MS = 4 * 60 * 60 * 1000;
const eauctionTime = (ms) => (Number.isFinite(ms) ? new Date(ms - EAUCTION_CLOCK_SKEW_MS) : null);

/** Amounts arrive as floats (`1.0308E7`, `74166.7`); a cent is the stored precision. */
const amount = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

const text = (value) => {
  const clean = String(value ?? '').trim().replace(/\s+/g, ' ');
  return clean || null;
};

/**
 * The procedure form, as PPCM names it (`p_form`), → a procedure type. The
 * forms are `POST /ppcm/public/reports/get-form-list`'s, read 2026-10-23. The
 * negotiated procedures are single source, as armeps.am's are
 * (cft.parser.js). A form not listed — simplified, framework, two-stage,
 * competitive dialogue, exchange, grant — is null. The type is counted with
 * an unmatched result, and a single-source procedure never attaches to a
 * competitive tender, nor the reverse (resolution.service.js, rule 3).
 */
const FORMS = [
  [/աճուրդ/iu, 'e_auction'], // «Էլեկտրոնային աճուրդ»
  [/գնանշման/iu, 'quotation'], // «Գնանշման հարցում»
  [/մեկ\s+անձ|բանակց/iu, 'single_source'], // «Մեկ անձ», «Հրատապ մեկ անձ», «Բանակց. ընթացակարգ …»
  [/բաց\s+(մրցույթ|ընթացակարգ)/iu, 'open'], // «Բաց մրցույթ», «Հրատապ բաց մրցույթ», «Բաց ընթացակարգ»
];

export const procedureTypeOf = (form) => FORMS.find(([pattern]) => pattern.test(form ?? ''))?.[1] ?? null;

/**
 * A bidder's per-source id: its ՀՎՀՀ, which PPCM states for every bidder, and
 * the name only for one that has none (a foreign bidder) — a renamed company
 * becomes a second party, far better than two companies becoming one.
 */
const bidderKey = ({ taxId, name }) => taxId ?? `name:${sha256(String(name).toLowerCase()).slice(0, 16)}`;

/**
 * One lot's rows → its ledger lot: every bidder at its net offer, and the
 * award the report names.
 *
 * - `participant_total_price` is the offer **without VAT** (95 of 95 equal
 *   to the e-auction ledger's net, research.md), so it is the net price and
 *   nothing is invented for the gross: PPCM states no bidder's VAT.
 * - `contract_price` is the **gross** award — what the buyer pays, per lot
 *   (28 of 29 equal to the e-auction award, the 29th by 1.50 AMD) — and the
 *   winner's net is its own offer. A lot joined to several contracts keeps
 *   only the one priced at its winner's offer (`pricedAsOffer`), or is not
 *   read at all.
 * - `bid_rejected` is not read. It is mostly null for e-auctions and wrong
 *   where set (28 of 95), and on ARMEPS rows it is `true` on the winning
 *   bid itself (ԱՄԱՀ-ԲՄԽԾՁԲ-26/09: all 15 rows, both winners included).
 *   Read as a rejection it would drop every winner from every price range;
 *   the award is named explicitly instead, so a win never rests on it.
 * - `est_total_price` is 0 on almost every row; a budget of 0 is no budget.
 */
const ledgerLot = (lotNumber, rows, warnings) => {
  const bids = new Map();
  for (const row of rows) {
    const name = text(row.participant_name);
    const net = amount(row.participant_total_price);
    if (!name || net === null) {
      warnings.push(`lot ${lotNumber}: a row with no bidder or no price was not read`);
      continue;
    }
    const taxId = text(row.participant_taxpayer);
    const key = bidderKey({ taxId, name });
    const held = bids.get(key);
    // The same offer once per contract the report joins to the lot (below)
    // is one bid; two different offers from one bidder are worth a word.
    if (held) {
      if (net !== held.finalValue) warnings.push(`lot ${lotNumber}: ${name} listed at ${held.finalValue} and ${net} — the lower kept`);
      if (net >= held.finalValue) continue;
    }
    bids.set(key, {
      supplierSourceId: key,
      supplierName: name,
      supplierTaxId: taxId,
      rank: null,
      initialPrice: null,
      initialValue: null,
      finalPrice: null,
      finalValue: net,
      finalVatPercent: null,
      participantStatus: null,
      applicationUrl: null,
    });
  }

  const contracts = namedContracts(rows).map((row) => {
    const winner = { taxId: text(row.taxpayer_id), name: text(row.winner_name) };
    const winning =
      [...bids.values()].find((bid) => winner.taxId && bid.supplierTaxId === winner.taxId) ??
      [...bids.values()].find((bid) => winner.name && bid.supplierName === winner.name) ??
      null;
    return { row, winner, winning };
  });
  let contract = contracts.length === 1 ? contracts[0] : null;
  if (contracts.length > 1) {
    const own = contracts.filter(({ row, winning }) => pricedAsOffer(amount(row.contract_price), winning?.finalValue));
    contract = own.length === 1 ? own[0] : null;
    warnings.push(
      `lot ${lotNumber}: ${contracts.length} contracts named (${contracts.map(({ row }) => row.contract_id).join(', ')}) — ` +
        (contract ? `${contract.row.contract_id} kept, the one priced at its winner's own offer` : 'none priced at its winner\'s own offer, lot not read')
    );
    // A lot that has a winner nobody can place is not written at all: its
    // bids without an award would read as every bidder's defeat
    // (`bids.reconcile`), the winner's included. Unwritten, a bid on it stays
    // `not_found` and is asked about again.
    if (!contract) return { lotNumber, estimatedValue: null, bids: [], award: null };
  }

  let award = null;
  if (contract) {
    const { row, winner, winning } = contract;
    award = {
      supplierSourceId: winning?.supplierSourceId ?? bidderKey({ taxId: winner.taxId, name: winner.name ?? '' }),
      supplierName: winning?.supplierName ?? winner.name ?? winner.taxId,
      supplierTaxId: winner.taxId,
      amount: amount(row.contract_price),
      netAmount: winning?.finalValue ?? null,
      awardedAt: time(row.contract_sign_date) ?? time(row.award_date),
    };
  }

  const budget = amount(rows[0].est_total_price);
  return { lotNumber, estimatedValue: budget > 0 ? budget : null, bids: [...bids.values()], award };
};

/** A lot's rows that name a winner, one per contract (winner and contract id). */
const namedContracts = (rows) => {
  const seen = new Map();
  for (const row of rows) {
    if (!text(row.winner_name) && !text(row.taxpayer_id)) continue;
    const key = `${text(row.taxpayer_id) ?? text(row.winner_name)}|${text(row.contract_id)}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
};

/**
 * Every bidder of one procedure as PPCM lists it — lot, ՀՎՀՀ, name and net
 * offer, once per distinct row — read straight off the rows, before any
 * contract is placed. What an e-auction's bidders gain their ՀՎՀՀ from
 * (ticket 11): a lot `ledgerLot` leaves unread because its contracts cannot
 * be told apart still names its bidders and their offers correctly, and the
 * ՀՎՀՀ join needs only those.
 */
const biddersOf = (rows) => {
  const seen = new Map();
  for (const row of rows) {
    const lotNumber = Number(row.lot_number);
    const name = text(row.participant_name);
    const net = amount(row.participant_total_price);
    if (!Number.isInteger(lotNumber) || lotNumber < 1 || !name || net === null) continue;
    const taxId = text(row.participant_taxpayer);
    const key = `${lotNumber}|${taxId ?? name}|${net}`;
    if (!seen.has(key)) seen.set(key, { lotNumber, taxId, name, net });
  }
  return [...seen.values()];
};

/**
 * Is a contract's price the winner's own offer on this lot — net for a
 * non-VAT payer, net plus 20% for a payer — within the 1.50 AMD of rounding
 * research.md saw?
 *
 * The report joins every contract of a procedure whose winner bid on a lot to
 * that lot: on ԱՄԱՀ-ԲՄԽԾՁԲ-26/09, lot 1 lists each bidder twice, once against
 * contract /1 at 649 200 — 00813453's own 541 000 × 1.2 — and once against
 * /3 at 2 040 000, which is 04225682's 1 700 000 on lots 15 and 16. The
 * contract whose price is the winner's offer on this lot is this lot's; when
 * not exactly one is, the lot is not read rather than guessed.
 *
 * Its SQL twin is tender.repo.js#awardOfferSql, which asks the same of a
 * stored award to decide whether its contract may stand for the winner's
 * offer in a discount — change one, change both.
 */
const pricedAsOffer = (contractPrice, net) =>
  contractPrice !== null &&
  Number.isFinite(net) &&
  (Math.abs(contractPrice - net) <= 2 || Math.abs(contractPrice - net * 1.2) <= 2);

/**
 * The id of one procedure's results on PPCM: its code and the moment it was
 * announced. The report has no id of its own, and a code alone is not a
 * procedure — a buyer re-announces under the same code (research.md:
 * ԵՔ-ԲՄԽԾՁԲ-26/3 has 11 rows across runs) — while the announcement never
 * moves.
 */
export const procedureId = (code, announcedAt) =>
  `${text(code)}@${announcedAt ? announcedAt.toISOString() : 'undated'}`;

/**
 * The rows of one code → one observation per procedure, the procedures told
 * apart by their announcement. Each is a `results` observation in the ARMEPS
 * submission channel — PPCM states no channel; it is ARMEPS's results source,
 * and an e-auction's form says so (`eauction`, from which the caller takes
 * only the bidders' ՀՎՀՀ, ticket 11) — matched by resolution on its code and
 * the announcement and opening dates (rule 3).
 *
 * Every row must be of the code asked for, exactly: the filter is exact and
 * case-sensitive, so another code means it stopped applying, and the rows
 * are someone else's. The code is the one PPCM was asked for, as spelled —
 * no normalizing, since another spelling is another query.
 */
export const observeProcedures = ({ reportId, code, rows }) => {
  const key = text(code);
  const foreign = rows.filter((row) => text(row.tender_reference) !== key);
  if (foreign.length) {
    throw new Error(
      `[${SOURCE}] ${code}: ${foreign.length} of ${rows.length} rows are of another code ` +
        `(${JSON.stringify(foreign[0].tender_reference)}) — the code filter did not apply`
    );
  }

  const runs = new Map();
  for (const row of rows) {
    // PPCM's own clock, uncorrected even for an e-auction: an id only has to
    // name the procedure the same way on every read.
    const id = procedureId(code, time(row.announcement_date));
    if (!runs.has(id)) runs.set(id, []);
    runs.get(id).push(row);
  }

  return [...runs.entries()].map(([externalId, run]) => {
    const warnings = [];
    const byLot = new Map();
    for (const row of run) {
      const lot = Number(row.lot_number);
      if (!Number.isInteger(lot) || lot < 1) {
        warnings.push(`a row with no lot number (${JSON.stringify(row.lot_number)}) was not read`);
        continue;
      }
      if (!byLot.has(lot)) byLot.set(lot, []);
      byLot.get(lot).push(row);
    }
    const ledger = [...byLot.entries()]
      .sort(([a], [b]) => a - b)
      .map(([lot, lotRows]) => ledgerLot(lot, lotRows, warnings))
      .filter((lot) => lot.bids.length || lot.award);

    const first = run[0];
    const procedureType = procedureTypeOf(first.p_form);
    const timeOf = procedureType === 'e_auction' ? eauctionTime : time;
    const opening = run.map((row) => timeOf(row.t_opening_date)).find(Boolean) ?? null;
    return {
      source: SOURCE,
      role: 'results',
      externalId,
      url: `${reportsPageUrl()}#/report/${reportId}`,
      pointer: null,
      procedureCode: text(first.tender_reference),
      submissionChannel: procedureType === 'e_auction' ? 'eauction' : 'armeps',
      // PPCM lists paper procedures beside ARMEPS ones and says which only in
      // bid-report (`paperBased`): a code Tendra holds only as a paper (or
      // e-auction) tender is that tender's, not an ARMEPS tender it missed
      // (resolution.service.js, `channelUnstated`). An auction's form is its
      // channel.
      channelUnstated: procedureType !== 'e_auction',
      procedureType,
      form: text(first.p_form),
      buyerName: text(first.authority_name),
      publishedAt: timeOf(first.announcement_date),
      deadlineAt: opening,
      lotNumbers: ledger.map((lot) => lot.lotNumber),
      // A winner named on any lot is an award; none named leaves the status
      // to the deadline (`deriveStatus`) and the tender to the next ask.
      status: ledger.some((lot) => lot.award) ? 'awarded' : null,
      observedStatus: null,
      ledger,
      bidders: biddersOf(run),
      warnings,
    };
  });
};

/**
 * The rows of one sweep query — one form, one day, many codes — → one
 * observation per procedure, as `observeProcedures` reads one code's. Every
 * row of a procedure shares its announcement, so the day holds the whole
 * procedure. A row with no code names no procedure anything could be matched
 * to, and is counted rather than read.
 */
export const observeDay = ({ reportId, rows }) => {
  const byCode = new Map();
  let uncoded = 0;
  for (const row of rows) {
    const code = text(row.tender_reference);
    if (!code) {
      uncoded += 1;
      continue;
    }
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(row);
  }
  const observations = [...byCode.entries()].flatMap(([code, codeRows]) =>
    observeProcedures({ reportId, code, rows: codeRows })
  );
  return { observations, uncoded };
};

/** Armenia has kept UTC+4 all year since 2012, so a fixed offset is exact. */
const YEREVAN_OFFSET_MS = 4 * 60 * 60 * 1000;
const yerevanDay = (at) => (at ? new Date(new Date(at).getTime() + YEREVAN_OFFSET_MS).toISOString().slice(0, 10) : null);

/**
 * bid-report's tenders of a code → the armeps.am CfT of one procedure, or why
 * there is none. Pure.
 *
 * The procedure is the one entry of its exact code whose bids opened on the
 * procedure's opening day (`cftTendersOpeningDate` against the report's
 * `t_opening_date`): 86 of 86 entries checked on 2026-10-27 agreed, while
 * `datePublished` — despite its name — equalled the announcement on only 29,
 * the rest being a later re-publication. A re-announcement opens on another
 * day, which tells two runs of one code apart. A procedure stating no opening
 * is matched on its announcement against `contractNoticeDate` (85 of 86; the
 * miss was an announcement PPCM keeps as a bare date).
 *
 *   { resourceId }            — an armeps.am page to fetch
 *   { none: 'paper' }         — a paper procedure: it has no armeps.am page
 *   { none: 'not_listed' }    — bid-report has no entry of that code and day
 *   { none: 'ambiguous' }     — two entries of that code on that day
 *   { none: 'no_resource' }   — an entry with no `armepsId`
 */
export const cftOf = (tenders, observation) => {
  const key = text(observation.procedureCode);
  const opening = yerevanDay(observation.deadlineAt);
  const announced = yerevanDay(observation.publishedAt);
  const fits = (tender) =>
    opening !== null
      ? yerevanDay(tender.cftTendersOpeningDate ?? tender.tenderSubmissionDeadline) === opening
      : announced !== null && yerevanDay(tender.contractNoticeDate) === announced;
  const same = (tenders ?? []).filter((tender) => text(tender?.code) === key && fits(tender));
  if (!same.length) return { none: 'not_listed' };
  if (same.length > 1) return { none: 'ambiguous' };
  const [tender] = same;
  if (tender.paperBased === true) return { none: 'paper' };
  const resourceId = Number(tender.armepsId);
  return Number.isInteger(resourceId) && resourceId > 0 ? { resourceId } : { none: 'no_resource' };
};

export default {
  SOURCE,
  storedPayload,
  storedDayPayload,
  storedBidReport,
  parseBidReport,
  parseStored,
  procedureTypeOf,
  procedureId,
  observeProcedures,
  observeDay,
  cftOf,
};
