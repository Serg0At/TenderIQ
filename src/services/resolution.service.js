/**
 * Resolution: which tender a source's observation belongs to, and what status
 * that tender is in. All of ADR 0004's merge logic, and nowhere else.
 *
 * Pure — an observation, the candidate tenders a repository found and a clock
 * reading in, a decision out. No database, no queue, no HTTP, no clock of its
 * own, the shape `relevance.service.js` already has. Adding a source means
 * writing a parser that emits an observation; it never means touching these
 * rules. This is also the seam a test suite would attach to: a re-announcement
 * is two tenders, two surviving candidates is `ambiguous`, never a pick.
 *
 * An observation is one source's view of one tender:
 *
 *   { source, role: 'discovery' | 'detail' | 'results', externalId,
 *     pointer: { source, externalId } | null,   // another source's id it links to
 *     procedureCode, submissionChannel, procedureType, buyerName,
 *     publishedAt, deadlineAt, lotNumbers: number[],
 *     status }                                  // the source's status as a domain value, null if unmapped
 *
 * A candidate is a stored tender:
 *
 *   { id, status, referenceCode, submissionChannel, publishedAt, deadlineAt, lotNumbers }
 */

/**
 * A procedure code as a matching key. The same code arrives as
 * `ՍԱՊ–ԳՀԱՊՁԲ-26/18` (en dash) and `«ՍԱՊ-ԳՀԱՊՁԲ-26/18»` (quoted), and with runs
 * of inner whitespace (`ՀՀ  ՊՆ-…`). Inner spaces are collapsed, not removed:
 * `ՀՀ ՊՆ` is how that buyer actually spells it.
 *
 * `codeKeySql` in tender.repo.js is the SQL twin. It only narrows the
 * candidates; `resolve` re-checks every one with this function, so the two
 * may differ in edge cases without a wrong match getting through.
 */
export const normalizeCode = (code) => {
  if (code === null || code === undefined) return null;
  const key = String(code)
    .replace(/[«»"'“”„‘’]/g, '')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return key || null;
};

/**
 * What `resolve` needs a repository to look up, so that which queries run is
 * decided here too. Only a result is ever matched on its code: a detail or
 * discovery source carries its own identity, and matching it on a code would
 * merge a re-announcement into the run it replaced.
 */
export const lookupsFor = (observation) => {
  const key = normalizeCode(observation.procedureCode);
  return {
    link: { source: observation.source, externalId: String(observation.externalId) },
    pointer: observation.pointer
      ? { source: observation.pointer.source, externalId: String(observation.pointer.externalId) }
      : null,
    code:
      observation.role === 'results' && key
        ? { key, submissionChannel: observation.submissionChannel }
        : null,
  };
};

/** Armenia has kept UTC+4 all year since 2012, so a fixed offset is exact. */
const YEREVAN_OFFSET_MS = 4 * 60 * 60 * 1000;

const yerevanDay = (at) => {
  if (!at) return null;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? new Date(ms + YEREVAN_OFFSET_MS).toISOString().slice(0, 10) : null;
};

/**
 * Dates must positively agree: at least one date both sides carry falls on the
 * same Yerevan day, and none they both carry disagrees. A missing date never
 * counts as agreement — a result with no dates, whose real run Tendra missed,
 * would otherwise link to a re-announced sibling under the same code.
 */
const datesAgree = (observation, tender) => {
  let agreed = 0;
  for (const field of ['publishedAt', 'deadlineAt']) {
    const left = yerevanDay(observation[field]);
    const right = yerevanDay(tender[field]);
    if (left === null || right === null) continue;
    if (left !== right) return false;
    agreed += 1;
  }
  return agreed > 0;
};

/** Every lot the result names exists on the candidate, when both sides list lots. */
const lotsFit = (observed = [], stored = []) => {
  if (!observed.length || !stored.length) return true;
  const have = new Set(stored.map(Number));
  return observed.every((lot) => have.has(Number(lot)));
};

/**
 * Rule 3: same normalized code, same submission channel, dates that agree and
 * lots that do not contradict. Re-announced runs share a code and differ in
 * dates, which is what tells them apart. A result with no comparable date
 * matches nothing (`no_candidate`); two runs on the same day both survive
 * (`ambiguous`).
 */
const codeMatches = (observation, candidates) => {
  const key = normalizeCode(observation.procedureCode);
  return candidates.filter(
    (tender) =>
      normalizeCode(tender.referenceCode) === key &&
      tender.submissionChannel === observation.submissionChannel &&
      datesAgree(observation, tender) &&
      lotsFit(observation.lotNumbers, tender.lotNumbers)
  );
};

const unique = (tenders) => [...new Map(tenders.map((t) => [t.id, t])).values()];

/** `tender` is the candidate itself: its stored status is what `deriveStatus` moves forward from. */
const link = (tender, rule) => ({ action: 'link', tenderId: tender.id, tender, rule });
const unmatched = (reason, tenders = []) => ({
  action: 'unmatched',
  reason,
  candidateIds: tenders.map((t) => t.id),
});

/**
 * One observation → link to a tender, create a new one, or unmatched with a
 * reason. ADR 0004's order, and the first decisive rule wins:
 *
 *   1. the `(source, external_id)` pair is already linked;
 *   2. the source points at another source's id that is linked;
 *   3. a result is matched on normalized code + submission channel + dates and lots;
 *   4. anything else is unmatched — never guessed onto a tender.
 *
 * A detail or discovery source that is not linked creates its tender. A
 * result source never does, the same rule as the listing writing no domain
 * rows. ADR 0004's one exception, a PPCM history backfill whose tenders are
 * never biddable, is its own decision and adds its own mode when it is built.
 *
 * `candidates` is `{ linked, pointed, byCode }`, the answers to `lookupsFor`.
 */
export const resolve = (observation, { linked = [], pointed = [], byCode = [] } = {}) => {
  const byLink = unique(linked);
  if (byLink.length === 1) return link(byLink[0], 'link');
  // The unique key makes this impossible; if it ever happens, it is not ours to pick.
  if (byLink.length > 1) return unmatched('ambiguous', byLink);

  const byPointer = unique(pointed);
  if (byPointer.length === 1) return link(byPointer[0], 'pointer');
  if (byPointer.length > 1) return unmatched('ambiguous', byPointer);

  if (observation.role !== 'results') return { action: 'create' };

  if (!normalizeCode(observation.procedureCode)) return unmatched('no_code');
  const fits = unique(codeMatches(observation, byCode));
  if (fits.length === 1) return link(fits[0], 'code');
  if (fits.length > 1) return unmatched('ambiguous', fits);
  return unmatched('no_candidate');
};

/**
 * Which source decides which status, per submission channel (ADR 0004). `open`
 * covers everything short of a terminal state: planned, active, amended, closed.
 */
export const STATUS_OWNERS = {
  eauction: { open: ['eauction'], awarded: ['eauction'], cancelled: ['eauction'] },
  armeps: { open: ['armeps'], awarded: ['ppcm'], cancelled: ['ppcm', 'gnumner'] },
  paper: { open: ['gnumner'], awarded: ['gnumner'], cancelled: ['gnumner'] },
};

/**
 * Forward order. `active` and `amended` share a step, as do the two terminal
 * states: a terminal tender stays as it is, so a stale page from any source
 * cannot reopen it, nor turn an award into a cancellation.
 */
const STEP = { planned: 0, active: 1, amended: 1, closed: 2, awarded: 3, cancelled: 3 };
const TERMINAL = new Set(['awarded', 'cancelled']);

/**
 * A tender's links → one `tenders.status`.
 *
 * `links` is `[{ source, status }]`, each status already a domain value (or
 * null when the source used a label its adapter does not know). Only the
 * owning source's word counts for each state. An award outranks a
 * cancellation when both owners have spoken: a contract exists.
 *
 * With no usable word from the open owner, status comes from the deadline —
 * "can a supplier still bid?" is the only question `status` is load-bearing
 * for downstream, and it is answerable from the deadline alone. Degrade, do
 * not discard: a tender lost over one unrecognised label is a missed tender.
 *
 * Status only moves forward from `current`.
 */
export const deriveStatus = ({ submissionChannel, links = [], current = null, deadlineAt = null }, now) => {
  const owners = STATUS_OWNERS[submissionChannel];
  if (!owners) throw new Error(`no status owners for submission channel "${submissionChannel}"`);

  const said = (state) =>
    links.some((l) => l.status === state && owners[state].includes(l.source));

  let next;
  if (said('awarded')) next = 'awarded';
  else if (said('cancelled')) next = 'cancelled';
  else {
    const open = links.find(
      (l) => owners.open.includes(l.source) && l.status && !TERMINAL.has(l.status)
    );
    next = open?.status ?? (deadlineAt && new Date(deadlineAt).getTime() < now.getTime() ? 'closed' : 'active');
  }

  if (!current || !(current in STEP)) return next;
  if (TERMINAL.has(current)) return current;
  return STEP[next] < STEP[current] ? current : next;
};

export default { normalizeCode, lookupsFor, resolve, deriveStatus, STATUS_OWNERS };
