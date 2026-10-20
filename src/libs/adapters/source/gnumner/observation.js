import { sha256 } from '../../../../utils/hash.js';
import { parseInvitation } from './invitation.parser.js';

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
      procedureType: null,
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

export default { SOURCE, pathDigest, paperNoticeId, paperNoticeRef, observeArmepsNotice, observePaperNotice, observeInvitation, paperDeadline };
