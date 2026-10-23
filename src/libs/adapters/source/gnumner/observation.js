import { sha256 } from '../../../../utils/hash.js';
import { parseInvitation } from './invitation.parser.js';
import { procedureTypeOfCode } from './listing.parser.js';

/**
 * gnumner notices and paper invitations → observations for the resolution
 * module (services/resolution.service.js). Pure: what the listing parser and
 * the invitation parser produced in, a plain object out. No network, no
 * database, no clock.
 */
export const SOURCE = 'gnumner';

/**
 * A paper notice's identity is the uploaded file's path, which can run long
 * and carries runs of spaces (non-ASCII characters in the original name become
 * spaces), so refs, link ids and job ids use a digest of it.
 */
export const pathDigest = (path) => sha256(path).slice(0, 24);

/** The link id of the notice that listed an upload: `paper:{digest of its path}`. */
export const paperNoticeId = (path) => `paper:${pathDigest(path)}`;

/** The `source_payloads` ref the listing records a paper notice under, from its link id. */
export const paperNoticeRef = (noticeId) => `notice:${noticeId}`;

/**
 * A notice that links to an armeps.am tender. gnumner has no ids of its own,
 * and the link target is what identifies a notice (ticket 04's listing ref is
 * `notice:armeps:{resourceId}`), so the link's external id is that target.
 * Re-listing it — the same tender under the open and the quotation listing,
 * or twice in a row — is one link.
 *
 * It carries a pointer to the armeps.am page and nothing that could create a
 * tender: gnumner only discovers an ARMEPS tender, and armeps.am's page is
 * the one that creates it (ADR 0004, rule 2).
 */
export const observeArmepsNotice = (notice, { resourceId, listingUrl }) => ({
  source: SOURCE,
  role: 'discovery',
  externalId: `armeps:${resourceId}`,
  url: listingUrl,
  pointer: { source: 'armeps', externalId: String(resourceId) },
  procedureCode: notice.procedureCode ?? null,
  submissionChannel: 'armeps',
  procedureType: null,
  buyerName: null,
  publishedAt: notice.publishedAt ?? null,
  deadlineAt: null,
  lotNumbers: [],
  status: null,
  observedStatus: null,
});

/**
 * A notice that lists a paper invitation: the discovery link, pointing at the
 * invitation by its content (`invitationId`, see observeInvitation). A buyer
 * who uploads the same file twice — it happens, minutes apart, under a new
 * path each time — has two notices and one tender.
 *
 * Its URL is the upload the notice points at, the counterpart of an ARMEPS
 * notice pointing at its armeps.am page.
 */
export const observePaperNotice = (notice, { invitationId }) => ({
  source: SOURCE,
  role: 'discovery',
  externalId: paperNoticeId(notice.path),
  url: notice.url,
  pointer: { source: SOURCE, externalId: String(invitationId) },
  procedureCode: notice.procedureCode ?? null,
  submissionChannel: 'paper',
  procedureType: null,
  buyerName: null,
  publishedAt: notice.publishedAt ? new Date(notice.publishedAt) : null,
  deadlineAt: null,
  lotNumbers: [],
  status: null,
  observedStatus: null,
});

/** Armenia has kept UTC+4 all year since 2012, so a fixed offset is exact. */
const YEREVAN_OFFSET_MS = 4 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

/**
 * A paper deadline as a datetime: the invitation's "N-th day counted from
 * publication, at HH:MM", against the notice's publish datetime.
 *
 *   deadline = (Yerevan calendar date of publication) + N days, at HH:MM Yerevan
 *
 * The publication day is day 0, and the days are calendar days. Checked on
 * 2026-10-21 against live quotations (ticket 06): the buyer also types a close
 * datetime into the gnumner listing, and it is publication + N in 34 of 36
 * notices that carry both (N = 7, 8, 10 and 14). Publication + N − 1 — the
 * publication day counted as day 1 — fits none, and neither do working days:
 * every Friday notice closes the next Friday and every Tuesday one the next
 * Tuesday. Two invitations say "counted from the day after publication", and
 * their own bid-opening dates are still publication + N (8 on a quotation, 41
 * on an open tender): the count starts the day after either way. The two
 * disagreements both say day 8 in the document and +7 on the listing; the
 * document is the invitation, so it wins.
 *
 * A date that lands on a holiday is NOT moved to the next working day
 * (decided 2026-10-21). Buyers who mind already pick their N to avoid one —
 * two wrote "8th day" exactly when the 7th was Sep 21 or May 28 — and others
 * leave a 7th day on a holiday. Shown literally, the worst case is a supplier
 * told a day early; rolling forward on a calendar we maintain could tell them
 * a day late, which loses the bid.
 *
 * A stated date («մինչև 27.10.2026թ … ժամը 12:30») is taken as it is.
 */
export const paperDeadline = (publishedAt, stated) => {
  if (!publishedAt || !stated) return null;
  const time = `${pad(stated.hour)}:${pad(stated.minute)}:00+04:00`;
  if (stated.date) return new Date(`${stated.date}T${time}`);

  const wallClock = new Date(new Date(publishedAt).getTime() + YEREVAN_OFFSET_MS);
  wallClock.setUTCDate(wallClock.getUTCDate() + stated.day);
  return new Date(`${wallClock.toISOString().slice(0, 10)}T${time}`);
};

/**
 * What the normalizer should say about a paper deadline: the invitation's is
 * used, the listing's typed close is the fallback, and a tender with neither
 * is stored with none — shown biddable until a person looks, so it is said.
 */
const deadlineWarnings = ({ stated, listed }) => {
  if (!stated && !listed) return ['states no deadline, and the listing shows no close: stored without one'];
  if (!stated) return ["states no deadline; the listing's close is used"];
  if (listed && listed.getTime() !== stated.getTime()) {
    return [`deadline ${stated.toISOString()} differs from the listing's ${listed.toISOString()}; the invitation's is used`];
  }
  return [];
};

/** The first publication of an upload: the earliest of its notices, the URL breaking a tie so a replay picks the same one. */
const firstNotice = (notices) =>
  [...notices].sort(
    (a, b) => new Date(a.publishedAt) - new Date(b.publishedAt) || String(a.url).localeCompare(String(b.url))
  )[0] ?? null;

/** The primary CPV code: the most frequent across the lots, the first listed breaking a tie. */
const primaryCode = (codes) => {
  const frequency = new Map();
  for (const code of codes) frequency.set(code, (frequency.get(code) ?? 0) + 1);
  return [...frequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/**
 * A stored paper invitation, and the notices that listed it → an observation.
 *
 * `externalId` is the file's content hash. That, not the upload's path, is
 * the paper detail's identity: the same file uploaded twice is one tender,
 * and the second upload's notice is a second discovery link on it. The
 * notices are what the file does not say — when it was published (the
 * deadline is counted from it), the notice title, and which listing it is on —
 * and the earliest is the publication.
 *
 * An upload the parser cannot read is `unreadable`, which resolution turns
 * into an `unsupported_format` unmatched result and no tender.
 */
export const observeInvitation = (bytes, { externalId, notices = [] }) => {
  const parsed = parseInvitation(bytes);
  const notice = firstNotice(notices);

  const base = {
    source: SOURCE,
    // The file creates the paper tender: gnumner is its discovery and its
    // detail source both (ADR 0004).
    role: 'detail',
    externalId: String(externalId),
    url: notice?.url ?? null,
    pointer: null,
    submissionChannel: 'paper',
    status: null,
    observedStatus: null,
    ledger: [],
  };

  if (!parsed.readable) {
    return {
      ...base,
      unreadable: { format: parsed.format },
      procedureCode: notice?.procedureCode ?? null,
      // Its listing's, so the unreadable count can be split by procedure.
      procedureType: notice?.procedureType ?? null,
      buyerName: null,
      publishedAt: notice?.publishedAt ? new Date(notice.publishedAt) : null,
      deadlineAt: null,
      lotNumbers: [],
    };
  }

  // The deadline is counted from the publication, so without a notice there
  // is no honest one to compute — and a tender without it would be shown
  // biddable forever. The caller always passes one; this is the guard.
  if (!notice) throw new Error(`[${SOURCE}] invitation ${externalId}: no notice to count its deadline from`);

  const { document } = parsed;
  const publishedAt = new Date(notice.publishedAt);
  const stated = paperDeadline(publishedAt, document.deadline);
  // The listing's own close, typed by the buyer when posting, is the fallback
  // for an invitation whose sentence was not found — it agrees with the
  // document in 34 of 36 cases checked.
  const listed = notice.closesAt ? new Date(notice.closesAt) : null;
  const deadlineAt = stated ?? listed;
  const procedureCode = document.procedureCode ?? notice.procedureCode ?? null;
  const codes = document.lots.map((lot) => lot.cpvCode).filter(Boolean);

  return {
    ...base,
    procedureCode,
    procedureType: notice.procedureType,
    buyerName: document.buyerName,
    publishedAt,
    deadlineAt,
    lotNumbers: document.lots.map((lot) => lot.lotNumber),
    warnings: deadlineWarnings({ stated, listed }),
    tender: {
      sourceStatus: null,
      // The buyer's notice headline; the subject only when a notice has none.
      title: notice.title || document.subject,
      referenceCode: procedureCode,
      procedureType: notice.procedureType,
      submissionChannel: 'paper',
      goodsWorksServices: null,
      evaluationMethod: null,
      // The file is the whole tender, so its codes are all there is: an empty
      // list is "none stated", not silence.
      cpvCode: primaryCode(codes),
      cpvCodes: [...new Set(codes)],
      // What is being bought, from «… կնքել <subject> մատակարարման
      // պայմանագիր». Unlike e-auction's, this is not the title over again:
      // the title is the buyer's notice headline.
      description: document.subject,
      submissionAddress: document.submissionAddress,
      estimatedValue: null,
      currency: 'AMD',
      publishedAt,
      deadlineAt,
      qnaDeadlineAt: null,
      auctionAt: null,
      invitationUrl: notice.url,
    },
  };
};

/** The link id of an amendment notice: the file's content hash, as for an invitation, under its own prefix. */
export const amendmentNoticeId = (hash) => `amendment:${hash}`;

/**
 * A notice on the amendment listing → an observation (ticket 07). Its code is
 * the title's, else `bodyCode` — the one a readable .docx states in its body,
 * which the caller reads only for a title with none (`noticeBodyCode`). Nothing
 * else is taken from the file, so a .doc, .rar or .pdf with a code in its
 * title is as good as a .docx (decided 2026-10-21). `externalId` is the file's
 * content hash. It names a tender only by that code: resolution matches
 * it on code, channel and dates (`amendment: true`) and never creates from
 * it. It is a notice of a tender the invitation created, so its link is a
 * `discovery` one, never a detail run a re-post could supersede.
 *
 * Checked on 14 pages of the listing (2026-10-21): the Article 29 template —
 * code, reasons in prose, buyer — or a full amended invitation. Neither states
 * a new deadline worth reading («… 05.10.2026թ ժամը 14:30-ի փոխարեն
 * 06.10.2026թ ժամը 14:30» is a sentence), so nothing is read out of either: a
 * moved deadline reaches the tender through the re-posted invitation.
 */
export const observeAmendment = (notice, { externalId, bodyCode = null }) => ({
  source: SOURCE,
  role: 'discovery',
  amendment: true,
  externalId: amendmentNoticeId(externalId),
  url: notice.url,
  pointer: null,
  procedureCode: notice.procedureCode ?? bodyCode ?? null,
  submissionChannel: 'paper',
  // Read off the code, only so an unmatched notice can be counted by procedure.
  procedureType: procedureTypeOfCode(notice.procedureCode ?? bodyCode),
  buyerName: null,
  publishedAt: new Date(notice.publishedAt),
  deadlineAt: null,
  lotNumbers: [],
  status: null,
  observedStatus: null,
});

/**
 * The link and payload id of a contract-concluded notice: the upload's path,
 * as for the notice of an invitation (`paper:…`), not its content. That is
 * what lets an unmatched one be read again once its tender appears
 * (paper.js#queueResultRetries): the path finds the listing page the notice
 * was stored with, and so its title and URL. A file uploaded twice is two
 * notices writing the same rows.
 */
export const contractNoticeId = (path) => `contract:${pathDigest(path)}`;

/**
 * The path digest a result notice's id carries — a contract notice's or a
 * failure notice's — for a job id: BullMQ ids take no colon.
 */
export const resultNoticeDigest = (id) => String(id).replace(/^(?:contract|failed):/, '');

/** The listing's id for the notice a result notice's id names: `paper:{digest}`, as `paperNoticeId` gives it. */
export const noticeIdOfResult = (id) => `paper:${resultNoticeDigest(id)}`;

/** A start of day in Yerevan, for a date a document states without a time. */
const yerevanDay = (date) => (date ? new Date(`${date}T00:00:00+04:00`) : null);

/**
 * A paper supplier's per-source id. The bid ledger names bidders and nothing
 * else — no operator id, no ՀՎՀՀ in the price table — so, as for a buyer, the
 * name is the identity (contract.parser.js#bidderKey): a company renaming
 * itself becomes a second party, which is far better than two companies
 * becoming one.
 */
const supplierSourceId = (key) => `name:${sha256(key).slice(0, 16)}`;

/** VAT as a percentage of the net price: 20 for a VAT payer, 0 for a non-payer. */
const vatPercent = ({ net, gross }) =>
  net > 0 && gross !== null ? Math.round(((gross - net) / net) * 10000) / 100 : null;

/**
 * A lot of a contract notice → the ledger shape `saveNormalized` and
 * `recordResults` write: every bidder, and the award named by the contract.
 *
 * The award is explicit — `award` is set, null when the contract names no
 * winning bid — never the e-auction rule of the first accepted rank: the
 * notice states who won, and its row order is not a ranking. Its prices are
 * the winning bid's, net and total, so the award compares with the other bids
 * like every award does; the contract's own price can be a framework sum or
 * the available funds only. A sealed bid has one price: it is the final
 * offer, and no rank is stated, so none is stored.
 */
const ledgerLot = (lot) => {
  const winner = lot.contract?.winnerKey ? lot.bids.find((bid) => bid.key === lot.contract.winnerKey) : null;
  return {
    lotNumber: lot.lotNumber,
    estimatedValue: lot.budget,
    bids: lot.bids.map((bid) => ({
      supplierSourceId: supplierSourceId(bid.key),
      supplierName: bid.name,
      rank: null,
      initialPrice: null,
      initialValue: null,
      finalPrice: bid.gross,
      finalValue: bid.net,
      finalVatPercent: vatPercent(bid),
      participantStatus: bid.rejected ? 'rejected' : null,
      applicationUrl: null,
    })),
    award: winner
      ? {
          supplierSourceId: supplierSourceId(winner.key),
          supplierName: winner.name,
          amount: winner.gross,
          netAmount: winner.net,
          awardedAt: yerevanDay(lot.contract.signedOn),
        }
      : null,
  };
};

/**
 * A stored contract-concluded notice → a results observation (ticket 08).
 *
 * gnumner is the paper channel's award source (ADR 0004), and the notice
 * names no channel: an ARMEPS or e-auction tender's contract is announced on
 * the same listing. So it is `channelUnstated`: resolution looks its code up
 * in every channel, skips one Tendra holds only elsewhere — PPCM and eauction
 * own those results — and matches the rest on code, the paper channel and the
 * dates, like any result (rule 3).
 *
 * The date rule 3 compares is the notice's own «Հրավեր ուղարկելու կամ
 * հրապարակելու ամսաթիվը»: the day the invitation was published, which is
 * the tender's `published_at` day. The notice's own publication is weeks
 * later and is no evidence of which run it is.
 *
 * Its code is the title's, else the one its body states (decided 2026-10-21,
 * as for an amendment notice). An unreadable file is `unreadable` and counted;
 * its title's code still lets resolution skip another channel's tender first.
 *
 * Most of these notices are of procedures never announced publicly (ticket
 * 31): a quotation sent to invited suppliers, a single-source purchase. When
 * resolution finds no tender and the facts say there was never a public one,
 * the notice creates a result-only tender (`createsWhenNeverPublic`, and
 * `tender`, its row). Its procedure type is what the code's method marker and
 * the notice's own procedure row say — null when they disagree or neither
 * says, since a single-source price is kept out of every comparison and a
 * wrong type puts it back in.
 */
const statedProcedure = (byCode, byNotice) =>
  byCode && byNotice && byCode !== byNotice ? null : (byCode ?? byNotice ?? null);

export const observeContract = (notice, { externalId, parsed }) => {
  const read = parsed.readable ? parsed.notice : null;
  const ledger = read ? read.lots.filter((lot) => lot.bids.length).map(ledgerLot) : [];
  const procedureCode = notice.procedureCode ?? read?.procedureCode ?? null;
  const procedureType = statedProcedure(procedureTypeOfCode(procedureCode), read?.procedure ?? null);
  const publishedAt = yerevanDay(read?.invitationDate);
  return {
    source: SOURCE,
    role: 'results',
    channelUnstated: true,
    createsWhenNeverPublic: true,
    externalId: String(externalId),
    url: notice.url ?? null,
    pointer: null,
    procedureCode,
    submissionChannel: 'paper',
    procedureType,
    buyerName: read?.buyerName ?? null,
    publishedAt,
    deadlineAt: null,
    lotNumbers: read ? read.lots.map((lot) => lot.lotNumber) : [],
    // A contract was concluded — the notice exists for nothing else — but the
    // tender is `awarded` only with an award that says to whom: a notice
    // whose winner names no bid on any lot leaves the status to the deadline.
    status: ledger.some((lot) => lot.award) ? 'awarded' : null,
    observedStatus: null,
    ...(read ? {} : { unreadable: { format: parsed.format } }),
    ledger,
    warnings: read?.unreadRows ? [`${read.unreadRows} rows could not be placed in a lot and were not read`] : [],
    // The row of a result-only tender, written only when resolution says so.
    // The notice states no deadline, CPV, budget total or address, so none is
    // invented: the tender is what the notice says and nothing more.
    tender: {
      sourceStatus: null,
      title: notice.title || procedureCode,
      referenceCode: procedureCode,
      procedureType,
      submissionChannel: 'paper',
      goodsWorksServices: null,
      evaluationMethod: null,
      cpvCode: null,
      cpvCodes: [],
      description: null,
      submissionAddress: null,
      estimatedValue: null,
      currency: 'AMD',
      // The day the invitation was sent, the date rule 3 matches later notices on.
      publishedAt,
      deadlineAt: null,
      qnaDeadlineAt: null,
      auctionAt: null,
      invitationUrl: null,
    },
  };
};

/**
 * The link and payload id of a failed-procedure notice: the upload's path, as
 * for a contract notice, so one read before its tender existed can be read
 * again from the listing page it was stored with.
 */
export const failedNoticeId = (path) => `failed:${pathDigest(path)}`;

/**
 * A stored failed-procedure notice → a results observation (ticket 09):
 * gnumner's «Չկայացած» is the ARMEPS and paper channels' cancellation source
 * (ADR 0004).
 *
 * It names a code and the lots that failed, and nothing else that matches a
 * tender: no channel — the listing carries e-auctions' too, which eauction
 * states for itself — and no date of the invitation it ends. So its own
 * publication is the date resolution asks about: the tender it ends was
 * announced before it (`resolution.service.js#resolveFailure`).
 *
 * Its code is the title's, else the one its body states (as for an amendment
 * notice, ticket 07). `lotNumbers` are the lots it lists as failed — not the
 * tender's, which is why `status` is what it says of those lots and the
 * tender's status is decided against the tender's own lots
 * (`failureStatus`). An unreadable file is `unreadable`; its title's code
 * still lets resolution skip an e-auction first.
 */
export const observeFailure = (notice, { externalId, parsed }) => {
  const read = parsed.readable ? parsed.notice : null;
  const procedureCode = notice.procedureCode ?? read?.procedureCode ?? null;
  return {
    source: SOURCE,
    role: 'results',
    failure: true,
    channelUnstated: true,
    externalId: String(externalId),
    url: notice.url ?? null,
    pointer: null,
    procedureCode,
    submissionChannel: null,
    // Read off the code, only so an unmatched notice can be counted by procedure.
    procedureType: procedureTypeOfCode(procedureCode),
    buyerName: null,
    publishedAt: new Date(notice.publishedAt),
    deadlineAt: null,
    lotNumbers: read ? read.lots : [],
    // What it says of the lots it names, not of the tender. Status is derived
    // from one observation at a time today; a derivation across a tender's
    // links must read `failed_lots` beside this, or every partly failed
    // tender reads as cancelled.
    status: 'cancelled',
    observedStatus: 'cancelled',
    ...(read ? {} : { unreadable: { format: parsed.format } }),
    warnings: read?.unplacedRows ? [`${read.unplacedRows} rows name no lot and were not read`] : [],
  };
};

export default {
  SOURCE,
  pathDigest,
  paperNoticeId,
  paperNoticeRef,
  amendmentNoticeId,
  contractNoticeId,
  failedNoticeId,
  observeFailure,
  observeArmepsNotice,
  observePaperNotice,
  observeInvitation,
  observeAmendment,
  observeContract,
  paperDeadline,
};
