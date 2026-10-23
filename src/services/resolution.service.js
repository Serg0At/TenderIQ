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
 *     amendment: boolean | undefined,           // a notice amending a tender it does not name (gnumner)
 *     channelUnstated: boolean | undefined,     // a result whose source names no channel (a gnumner contract notice)
 *     createsWhenNeverPublic: boolean | undefined } // a result that is its own tender when none was ever public (ticket 31)
 *
 * A candidate is a stored tender:
 *
 *   { id, status, referenceCode, submissionChannel, buyerName, publishedAt, deadlineAt, lotNumbers,
 *     replacedRuns,                             // it holds a superseded run: publishedAt is its newest
 *     runPublishedAt,                           // optional: every file's publication, for a paper re-post
 *     resultOnly,                               // only results created it: no invitation, no page (ticket 31)
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
 * `ՍԱՊ–ԳՀԱՊՁԲ-26/18` (en dash) and `«ՍԱՊ-ԳՀԱՊՁԲ-26/18»` (quoted), with runs
 * of inner whitespace (`ՀՀ  ՊՆ-…`), and with the dash after the method marker
 * dropped (`ՄԿԻ-ԳՀԱՊՁԲ26/47`). Inner spaces are collapsed, not removed:
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
    .toUpperCase()
    // ՄԿԻ-ԳՀԱՊՁԲ26/47 is ՄԿԻ-ԳՀԱՊՁԲ-26/47: the dash a buyer dropped after the
    // method marker, put back in that one position (ticket 07). No other dash
    // is ever added or removed.
    .replace(/ՁԲ(?=[0-9])/g, 'ՁԲ-');
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
    .toUpperCase()
    // ՄԿԻ-ԳՀԱՊՁԲ26/47 is ՄԿԻ-ԳՀԱՊՁԲ-26/47: the dash a buyer dropped after the
    // method marker, put back in that one position (ticket 07). No other dash
    // is ever added or removed.
    .replace(/ՁԲ(?=[0-9])/g, 'ՁԲ-');
  return key || null;
};

/**
 * What `resolve` needs a repository to look up, so that which queries run is
 * decided here too. A result is matched on its code within its channel. A
 * detail or discovery source carries its own identity, and matching it on a
 * code would merge a re-announcement into the run it replaced — except a
 * paper invitation, which has no other way to name its run (`codeRuns`), and an
 * amendment notice, which is matched on its code in any channel so that one
 * for an e-auction is told apart from one for a tender Tendra missed. A
 * result whose source does not say its channel is looked up in every channel
 * for the same reason.
 */
const codeLookup = (observation, key) => {
  if (!key) return null;
  if (observation.role === 'results') {
    return { key, submissionChannel: observation.channelUnstated ? null : observation.submissionChannel };
  }
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
 *
 * A paper tender a re-post joined (ticket 07) was published once per file,
 * and its `publishedAt` is only the newest. A contract notice states the day
 * its buyer remembers — the first file's, or the re-post's — so the
 * publication agrees when it falls on the day of any of the run's files
 * (`runPublishedAt`, decided 2026-10-23). They are one run: no file of a
 * re-announcement is among them.
 */
const publicationDays = (tender) =>
  new Set([tender.publishedAt, ...(tender.runPublishedAt ?? [])].map(yerevanDay).filter(Boolean));

const datesAgree = (observation, tender) => {
  let agreed = 0;
  const published = yerevanDay(observation.publishedAt);
  const days = publicationDays(tender);
  if (published !== null && days.size) {
    if (!days.has(published)) return false;
    agreed += 1;
  }
  const deadline = yerevanDay(observation.deadlineAt);
  const storedDeadline = yerevanDay(tender.deadlineAt);
  if (deadline !== null && storedDeadline !== null) {
    if (deadline !== storedDeadline) return false;
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
      // A result-only tender's lots are only those its notices have named so
      // far, not the procedure's: a second notice for another lot is still its.
      (tender.resultOnly || lotsFit(observation.lotNumbers, tender.lotNumbers))
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
  // A result-only tender has no file to be a re-post of, and no deadline it was open until.
  if (tender.resultOnly || !sameProcedure(observation, tender)) return null;
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
const unmatched = (reason, tenders = [], wasPublic = null) => ({
  action: 'unmatched',
  reason,
  candidateIds: tenders.map((t) => t.id),
  wasPublic,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The stretch of the invitation listings a result's invitation must fall in
 * for Tendra to know it was never public: its stated day, and the day either
 * side. The date is typed by the buyer into the notice — "sent or published"
 * — so a day's slip either way must not turn a public invitation into a
 * private one at the edge of what the sweeps have read. Null with no date.
 */
export const invitationSpan = (observation) => {
  const day = yerevanDay(observation.publishedAt);
  if (!day) return null;
  const start = new Date(`${day}T00:00:00+04:00`).getTime();
  return { from: new Date(start - DAY_MS), to: new Date(start + 2 * DAY_MS) };
};

/**
 * Was a result's procedure ever announced publicly (ticket 31)? `true`,
 * `false` or `null` for "not known" — decided from facts, never guessed:
 *
 *   - an invitation of its code was seen on gnumner's invitation listings, at
 *     any date (`codeSeen`): public;
 *   - a single-source procedure: never public, there is no invitation to
 *     announce;
 *   - otherwise only inside the window the sweeps have read without a gap
 *     (`window`, `{ from, to }` in ms: the newest of the listings' floors to
 *     the oldest of their watermarks, workers/listingChain.js): no invitation
 *     of its code there means none was published — unless a notice whose code
 *     nobody knows (a title without one, a file nobody could read) was
 *     published in its span, which could be it (`uncodedNearby`).
 *
 * Outside the window it is unknown, and so is an e-auction, whose coverage
 * is eauction's sweep, not these listings'. `false` is what lets a result
 * become its own tender; `true` with no tender is what Tendra missed.
 */
export const wasPublic = (observation, { window = null, codeSeen = false, uncodedNearby = false } = {}) => {
  if (codeSeen) return true;
  if (observation.procedureType === 'single_source') return false;
  if (observation.procedureType === 'e_auction') return null;
  const span = invitationSpan(observation);
  if (!span || !window) return null;
  // Strictly above the floor: a notice published in the floor's own minute
  // may sit on the page after the one the chain stopped at.
  if (!(window.from < span.from.getTime() && span.to.getTime() <= window.to)) return null;
  return uncodedNearby ? null : false;
};

/**
 * What a result-only tender needs to be written at all: a code and an
 * invitation date later notices can find it by (rule 3 needs both — without
 * the date, every notice of the procedure would be a tender of its own), a
 * buyer, a procedure type, and an award — its status is `awarded`, and a
 * notice that names no winner says nothing that would be.
 */
const standsAlone = (observation) =>
  Boolean(
    observation.createsWhenNeverPublic &&
      observation.status === 'awarded' &&
      yerevanDay(observation.publishedAt) &&
      observation.procedureType &&
      normalizeBuyer(observation.buyerName) &&
      normalizeCode(observation.procedureCode)
  );

/**
 * A gnumner notice names a code and no channel, and the same listing carries
 * notices of e-auction and ARMEPS tenders. When Tendra holds that code, and
 * only in another channel, the notice is that tender's, and the tender's own
 * source carries what it says (ADR 0004): not ours to attach, and not a
 * missed tender either.
 */
const heldElsewhere = (observation, byCode) => {
  const key = normalizeCode(observation.procedureCode);
  const coded = key ? byCode.filter((tender) => normalizeCode(tender.referenceCode) === key) : [];
  return coded.length > 0 && !coded.some((tender) => tender.submissionChannel === observation.submissionChannel);
};

const OTHER_CHANNEL = { action: 'skip', reason: 'other_channel' };

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

  if (heldElsewhere(observation, byCode)) return OTHER_CHANNEL;

  const key = normalizeCode(observation.procedureCode);
  if (!key) return unmatched('no_code');
  const own = byCode.filter((tender) => sameProcedure(observation, tender));
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
 * result source does not, the same rule as the listing writing no domain
 * rows — with two exceptions, both tenders that are never biddable: a PPCM
 * history backfill (ADR 0004, its own mode when it is built), and a result
 * of a procedure that was never public (below).
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
 * A result whose source names no channel (`channelUnstated`, a gnumner
 * contract notice, ticket 08) is the same: a code held only in another
 * channel is `skip`, asked before its format, so another channel's tender
 * never counts as an unreadable paper result. Otherwise it is rule 3 within
 * its own channel, like any result.
 *
 * A page from a superseded run — one that says so, or whose link its
 * replacement already marked — is `superseded` when linked, and `skip` when
 * not: nothing is created for a dead run, and its replacement records it
 * when it arrives.
 *
 * **A result of a procedure that was never public** (ticket 31, the second
 * exception to "a result never creates", beside ADR 0004's PPCM history):
 * a gnumner contract notice with no candidate, whose procedure `wasPublic`
 * says was never announced, is `create` with `resultOnly` — a tender that is
 * only its results, `awarded`, never biddable and never alerted. Anything
 * short of `false` stays `no_candidate`, and every unmatched result carries
 * `wasPublic`, so a miss (`true`) can be told from the unknown (`null`) and
 * from the never public (`false`) without reading the notice again.
 *
 * `candidates` is `{ linked, pointed, predecessorTenders, byCode, codeRuns,
 * publicity }`, the answers to `lookupsFor`; `predecessorTenders` hold the
 * observation's predecessors, and `publicity` is `wasPublic`'s facts, which
 * only a result needs.
 */
export const resolve = (
  observation,
  { linked = [], pointed = [], predecessorTenders = [], byCode = [], codeRuns = [], publicity = {} } = {}
) => {
  if (observation.amendment) return resolveAmendment(observation, { linked, byCode });
  if (observation.channelUnstated && !linked.length && heldElsewhere(observation, byCode)) return OTHER_CHANNEL;
  const resultPublic = () => (observation.role === 'results' ? wasPublic(observation, publicity) : null);
  if (observation.unreadable) return unmatched('unsupported_format', [], resultPublic());

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

  if (!normalizeCode(observation.procedureCode)) return unmatched('no_code', [], resultPublic());
  const fits = unique(codeMatches(observation, byCode));
  if (fits.length === 1) return link(fits[0], 'code');
  if (fits.length > 1) return unmatched('ambiguous', fits);
  const isPublic = resultPublic();
  if (isPublic === false && standsAlone(observation)) return { action: 'create', resultOnly: true };
  return unmatched('no_candidate', [], isPublic);
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

export default {
  normalizeCode,
  normalizeBuyer,
  lookupsFor,
  invitationSpan,
  wasPublic,
  resolve,
  deriveStatus,
  STATUS_OWNERS,
  JOINS_ON_CODE,
};
