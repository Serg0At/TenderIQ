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
 *     supersedes: [{ externalId, url }],        // earlier runs of this source it replaced
 *     superseded: boolean,                      // this run was itself replaced
 *     procedureCode, submissionChannel, procedureType, buyerName,
 *     publishedAt, deadlineAt, lotNumbers: number[],
 *     status,                                   // the source's status as a domain value, null if unmapped
 *     unreadable: { format } | undefined,       // a file its parser could not read (a paper .rar)
 *     amendment: boolean | undefined }          // a notice amending a tender it does not name (gnumner)
 *
 * A candidate is a stored tender:
 *
 *   { id, status, referenceCode, submissionChannel, buyerName, publishedAt, deadlineAt, lotNumbers,
 *     replacedRuns,                             // it holds a superseded run: publishedAt is its newest
 *     linkSuperseded }                          // linked candidates only: that link is a dead run
 *
 * **An e-auction amendment** is a new tid whose page names the runs it
 * replaced (ticket 29). It joins their tender — rule 2, the pointer being the
 * page's own word that it is the same procurement — and is that tender's
 * *current* link from then on; the runs it names are `superseded` links. A
 * same-code tender that names no predecessor is a re-announcement and a new
 * run: the pointer decides, never the code.
 *
 * **A paper invitation re-posted while its run is open** joins that run
 * (ticket 07). Paper has no pointer: a buyer who changes an invitation
 * uploads a new file, under the same code, and nothing in it names the old
 * one. So for the channels in `JOINS_ON_CODE` the code and the buyer are the
 * join key — but only while the earlier run was still open when the later
 * file was published. Once it has closed or been cancelled, the same code is
 * a new run, a re-announcement, exactly as for e-auction.
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
 * Submission channels whose re-issued invitation names no predecessor, so a
 * new detail joins the open run of its code and buyer (ticket 07). e-auction
 * names its predecessors (ticket 29) and armeps.am keeps one page per tender,
 * so neither is here: for them the code is never a join key for a detail.
 */
export const JOINS_ON_CODE = new Set(['paper']);

/**
 * A buyer's name as a join key: quotes, the `<<…>>` of a keyboard without «,
 * case and runs of whitespace do not make two buyers. Anything more is a
 * different spelling, and a different spelling stays a different buyer — a
 * missed join is a second tender, a wrong one merges two procurements.
 */
export const normalizeBuyer = (name) => {
  if (name === null || name === undefined) return null;
  const key = String(name)
    .replace(/[«»"'“”„‘’<>]/g, '')
    .replace(/[.,:;։]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return key || null;
};

/**
 * What `resolve` needs a repository to look up, so that which queries run is
 * decided here too. A result is matched on its code within its channel. A
 * detail or discovery source carries its own identity, and matching it on a
 * code would merge a re-announcement into the run it replaced — except a
 * paper invitation, which has no other way to name its run (`codeRuns`), and an
 * amendment notice, which is matched on its code in any channel so that one
 * for an e-auction is told apart from one for a tender Tendra missed.
 */
const codeLookup = (observation, key) => {
  if (!key) return null;
  if (observation.role === 'results') return { key, submissionChannel: observation.submissionChannel };
  if (observation.amendment) return { key, submissionChannel: null };
  return null;
};

export const lookupsFor = (observation) => {
  const key = normalizeCode(observation.procedureCode);
  const joinsOnCode =
    observation.role === 'detail' && !observation.amendment && JOINS_ON_CODE.has(observation.submissionChannel);
  return {
    link: { source: observation.source, externalId: String(observation.externalId) },
    pointer: observation.pointer
      ? { source: observation.pointer.source, externalId: String(observation.pointer.externalId) }
      : null,
    predecessors: (observation.supersedes ?? []).map((run) => ({
      source: observation.source,
      externalId: String(run.externalId),
    })),
    code: codeLookup(observation, key),
    codeRuns: key && joinsOnCode && !observation.unreadable ? { key, submissionChannel: observation.submissionChannel } : null,
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

const time = (at) => {
  if (!at) return null;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Whether a run was provably still open at a moment: its deadline was after
 * it. Dates rather than the stored status, so a replay a month later decides
 * what the first run decided. A run with no deadline proves nothing — it
 * would stay "open" for ever and swallow a re-announcement months later — and
 * joins nothing: a missed join is a second tender, which shows; a wrong one
 * merges two procurements, which does not.
 */
const openAt = (run, at) => {
  const deadline = time(run.deadlineAt);
  return deadline !== null && deadline > at;
};

/** The same normalized code, on the same submission channel. */
const sameProcedure = (observation, tender) =>
  normalizeCode(tender.referenceCode) === normalizeCode(observation.procedureCode) &&
  tender.submissionChannel === observation.submissionChannel;

/**
 * A paper invitation and a stored run of the same code and buyer: are they
 * one procurement, and which of the two is the newer? They are when the
 * earlier was still open as the later was published, and the earlier was not
 * cancelled or awarded. Only the stored run has a status worth reading; the
 * observation is a file, and its run's status is whatever the stored one says.
 */
const repostOf = (observation, tender) => {
  if (!sameProcedure(observation, tender)) return null;
  const buyer = normalizeBuyer(observation.buyerName);
  if (!buyer || buyer !== normalizeBuyer(tender.buyerName)) return null;

  const published = time(observation.publishedAt);
  const storedPublished = time(tender.publishedAt);
  if (published === null || storedPublished === null) return null;
  // Equal to the second is not an order, and an order is what decides which
  // file the tender is now.
  if (published === storedPublished) return null;

  if (published > storedPublished) {
    return !TERMINAL.has(tender.status) && openAt(tender, published) ? 'newer' : null;
  }
  return openAt(observation, storedPublished) ? 'older' : null;
};

/**
 * An amendment notice and a stored tender of its channel: the notice was
 * published while the tender was announced and still open. Status is not
 * read — a notice published before a tender was cancelled is still that
 * tender's notice, and the addendum it raises simply alerts nobody.
 *
 * A tender a re-post joined (`replacedRuns`) carries its newest file's
 * publication, not its first, so "announced before the notice" cannot be
 * asked of it: a notice published between its two files and read after the
 * second would otherwise find nothing.
 */
const amendedBy = (observation, tender) => {
  if (!sameProcedure(observation, tender)) return false;
  const published = time(observation.publishedAt);
  const storedPublished = time(tender.publishedAt);
  if (published === null || storedPublished === null) return false;
  return (tender.replacedRuns || storedPublished <= published) && openAt(tender, published);
};

/** `tender` is the candidate itself: its stored status is what `deriveStatus` moves forward from. */
const link = (tender, rule) => ({ action: 'link', tenderId: tender.id, tender, rule });
/**
 * A dead run's page: it updates its own link, as superseded, and nothing else.
 * Its deadline and documents are the old run's, and writing them would walk
 * the tender back to the version its replacement amended.
 */
const supersededRun = (tender, rule = 'link') => ({ action: 'superseded', tenderId: tender.id, tender, rule });
const unmatched = (reason, tenders = []) => ({
  action: 'unmatched',
  reason,
  candidateIds: tenders.map((t) => t.id),
});

/**
 * An amendment notice (ticket 07): rule 1, then the code its title names. Its
 * content is never read — the alert names the file, and a supplier opens it —
 * so its format decides nothing, and an unreadable one is never
 * `unsupported_format` (decided 2026-10-21): that reason is for files whose
 * content Tendra must read. A code Tendra holds only on e-auction or ARMEPS is
 * that tender's, and its own source carries the change.
 */
const resolveAmendment = (observation, { linked = [], byCode = [] }) => {
  const byLink = unique(linked);
  if (byLink.length === 1) return link(byLink[0], 'link');
  if (byLink.length > 1) return unmatched('ambiguous', byLink);

  const key = normalizeCode(observation.procedureCode);
  const coded = key ? byCode.filter((tender) => normalizeCode(tender.referenceCode) === key) : [];
  const own = coded.filter((tender) => tender.submissionChannel === observation.submissionChannel);
  if (coded.length && !own.length) return { action: 'skip', reason: 'other_channel' };

  if (!key) return unmatched('no_code');
  const amended = unique(own.filter((tender) => amendedBy(observation, tender)));
  if (amended.length === 1) return link(amended[0], 'code');
  if (amended.length > 1) return unmatched('ambiguous', amended);
  return unmatched('no_candidate');
};

/**
 * One observation → link to a tender, create a new one, or unmatched with a
 * reason. ADR 0004's order, and the first decisive rule wins:
 *
 *   1. the `(source, external_id)` pair is already linked;
 *   2. the source points at another source's id that is linked, or names
 *      earlier runs of its own that are (an e-auction amendment);
 *   3. a result is matched on normalized code + submission channel + dates and lots;
 *   4. anything else is unmatched — never guessed onto a tender.
 *
 * A detail or discovery source that is not linked creates its tender. A
 * result source never does, the same rule as the listing writing no domain
 * rows. ADR 0004's one exception, a PPCM history backfill whose tenders are
 * never biddable, is its own decision and adds its own mode when it is built.
 *
 * A replacement whose predecessors are on two tenders is `create` with an
 * `unmatched` beside it: a new run, the two tenders untouched, and the join
 * recorded as ambiguous.
 *
 * A tender created with no readable procedure code is `create` with a
 * `no_code` beside it (ticket 06). It is a real, biddable tender and must
 * appear — but rule 3 can never attach a result to it, so its eventual
 * result is a gap the count has to show in advance.
 *
 * A file the source's parser could not read (a paper invitation uploaded as
 * .rar, .doc or a scan) is `unsupported_format`: there is no buyer, deadline
 * or code to create anything from, and it is counted rather than dropped.
 *
 * A paper invitation of a code and buyer Tendra already holds (`codeRuns`, ticket
 * 07) joins that run when the two overlap — the earlier still open as the
 * later was published. The newer of the two is the tender from then on: a
 * newer file is `link` with rule `reposts`, which the caller writes as an
 * amendment that supersedes the run's current file; an older one, arriving
 * late (a sweep reads newest first), is `superseded` and writes only its
 * link. Two runs it could join is `create` with an `ambiguous` beside it, as
 * for an e-auction replacement.
 *
 * An amendment notice names a code and nothing else: it attaches to the one
 * tender of its channel announced before it and still open when it was
 * published (rule `code`), and never creates. A code Tendra holds only in
 * another channel is `skip` — that channel's own source carries the
 * amendment (an e-auction's new tid, armeps.am's page) — and a code it does
 * not hold at all is `no_candidate`, which is what a missed tender looks like.
 *
 * A page from a superseded run — one that says so, or whose link its
 * replacement already marked — is `superseded` when linked, and `skip` when
 * not: nothing is created for a dead run, and its replacement records it
 * when it arrives.
 *
 * `candidates` is `{ linked, pointed, predecessorTenders, byCode, codeRuns }`,
 * the answers to `lookupsFor`; `predecessorTenders` hold the observation's
 * predecessors.
 */
export const resolve = (observation, { linked = [], pointed = [], predecessorTenders = [], byCode = [], codeRuns = [] } = {}) => {
  if (observation.amendment) return resolveAmendment(observation, { linked, byCode });
  if (observation.unreadable) return unmatched('unsupported_format');

  const byLink = unique(linked);
  if (byLink.length === 1) {
    if (observation.superseded || byLink[0].linkSuperseded) return supersededRun(byLink[0]);
    return link(byLink[0], 'link');
  }
  // The unique key makes this impossible; if it ever happens, it is not ours to pick.
  if (byLink.length > 1) return unmatched('ambiguous', byLink);

  if (observation.superseded) return { action: 'skip', reason: 'superseded' };

  // Predecessors on two tenders Tendra holds apart: joining would merge them,
  // and which one the replacement belongs to is not ours to pick. But the
  // replacement is a live, biddable run, and dropping it would be a missed
  // tender — so it is created as a new run, and the join it could not make is
  // recorded as an ambiguous unmatched result naming both tenders.
  const byPredecessor = unique(predecessorTenders);
  if (byPredecessor.length === 1) return link(byPredecessor[0], 'supersedes');
  if (byPredecessor.length > 1) return { action: 'create', unmatched: unmatched('ambiguous', byPredecessor) };

  const byPointer = unique(pointed);
  if (byPointer.length === 1) return link(byPointer[0], 'pointer');
  if (byPointer.length > 1) return unmatched('ambiguous', byPointer);

  const reposts = unique(codeRuns).map((tender) => ({ tender, order: repostOf(observation, tender) })).filter((r) => r.order);
  if (reposts.length === 1) {
    const [{ tender, order }] = reposts;
    return order === 'newer' ? link(tender, 'reposts') : supersededRun(tender, 'reposts');
  }
  if (reposts.length > 1) return { action: 'create', unmatched: unmatched('ambiguous', reposts.map((r) => r.tender)) };

  if (observation.role !== 'results') {
    // A discovery never creates (its caller reads `create` as "not yet"), so
    // only a detail's missing code is counted.
    const uncoded = observation.role === 'detail' && !normalizeCode(observation.procedureCode);
    return uncoded ? { action: 'create', unmatched: unmatched('no_code') } : { action: 'create' };
  }

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
 * Status only moves forward from `current`, with one exception: a `closed`
 * that only the deadline ever said reopens when the deadline moves ahead.
 * `amended` is kept over `active`: no source says it — an addendum does
 * (services/addendum.service.js) — so a page re-read that says "open" has
 * not undone it, and reverting would re-notify as a status change.
 *
 * `replaces` is a replacement joining its predecessor's tender (ticket 29),
 * or a re-posted paper invitation joining its run (ticket 07).
 * The status is then the replacement's alone: what the old run reached short
 * of a terminal state is not carried (a `closed` read off a deadline the
 * amendment moved), and an open replacement is `amended`, which the source
 * itself says of the run it replaced.
 */
export const deriveStatus = ({ submissionChannel, links = [], current = null, deadlineAt = null, replaces = false }, now) => {
  if (replaces) {
    if (TERMINAL.has(current)) return current;
    const next = deriveStatus({ submissionChannel, links, current: null, deadlineAt }, now);
    return next === 'active' ? 'amended' : next;
  }
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
    if (open) next = open.status;
    else {
      const ahead = !(deadlineAt && new Date(deadlineAt).getTime() < now.getTime());
      // A `closed` read off the deadline is not an event the source announced,
      // only what the deadline said at the time — so a deadline that has since
      // moved into the future reopens it. armeps.am states no status at all,
      // and an extension caught after the old deadline passed must not leave
      // a biddable tender closed.
      if (ahead && current === 'closed') return 'active';
      next = ahead ? 'active' : 'closed';
    }
  }

  if (!current || !(current in STEP)) return next;
  if (TERMINAL.has(current)) return current;
  if (current === 'amended' && next === 'active') return current;
  return STEP[next] < STEP[current] ? current : next;
};

export default { normalizeCode, normalizeBuyer, lookupsFor, resolve, deriveStatus, STATUS_OWNERS, JOINS_ON_CODE };
