import { parseDetail } from './detail.parser.js';
import { detailUrl } from './client.js';

/**
 * A stored eauction detail page → an observation for the resolution module
 * (services/resolution.service.js). Everything e-auction-specific about
 * normalization lives here, so the normalizer stays an orchestrator.
 *
 * The page, its tid and when it was fetched in; a plain object out. No network,
 * no database and no clock — `seenAt` is the payload's `fetched_at`, so a
 * replay from storage maps exactly as the original run did.
 */
export const SOURCE = 'eauction';

/** Every tender on eauction.armeps.am is bid by live auction there. */
const SUBMISSION_CHANNEL = 'eauction';

export const observeDetail = (html, { externalId, seenAt, baseUrl }) => {
  const detail = parseDetail(html, { baseUrl });

  // Layout-health alarm, the detail-page counterpart to blocksSeen: a page that
  // parsed to no labels at all is a redesign, not an empty tender.
  if (detail.labelsSeen === 0) {
    throw new Error(
      `[${SOURCE}] detail ${externalId} yielded 0 label/value pairs — parser likely broken`
    );
  }

  // The ledger table was present and every row was rejected. That is a column
  // change, not an empty ledger — and persisting it would look identical to an
  // active tender that simply has no bids yet. Failing here is what keeps the
  // ledger-replace from being handed an empty result it would act on.
  if (detail.malformedLedgerRows > 0 && detail.lots.length === 0) {
    throw new Error(
      `[${SOURCE}] detail ${externalId}: bid ledger present but all ` +
        `${detail.malformedLedgerRows} rows failed the column check — ` +
        'Գնառաջարկներ layout likely changed'
    );
  }

  return {
    source: SOURCE,
    // One site is discovery, detail and results for an e-auction; the detail
    // page is the one that creates the tender, so that is the role it carries.
    role: 'detail',
    externalId: String(externalId),
    url: detailUrl(externalId),
    pointer: null,
    // The runs this one replaced: an e-auction amendment is a new tid that
    // names its predecessors, and joins the tender they belong to (ticket 29).
    supersedes: detail.predecessors
      .filter((tid) => tid !== String(externalId))
      .map((tid) => ({ externalId: tid, url: detailUrl(tid) })),
    // This page is such a predecessor: a dead run, which says nothing more
    // about the tender than that it was replaced.
    superseded: detail.superseded,
    seenAt,
    procedureCode: detail.code,
    submissionChannel: SUBMISSION_CHANNEL,
    procedureType: detail.procedureType,
    buyerName: detail.buyerName,
    publishedAt: detail.publishedAt,
    deadlineAt: detail.deadlineAt,
    lotNumbers: detail.lots.map((lot) => lot.lotNumber),
    // Null for a label STATUS in detail.parser.js does not know; resolution
    // then derives it from the deadline. The verbatim label is kept either way.
    status: detail.status,
    observedStatus: detail.rawStatus ?? null,
    // What this page says about the tender, minus `status`, which is derived
    // across the tender's links rather than taken from one page.
    tender: {
      sourceStatus: detail.rawStatus ?? null,
      title: detail.title,
      referenceCode: detail.code,
      procedureType: detail.procedureType,
      submissionChannel: SUBMISSION_CHANNEL,
      goodsWorksServices: detail.goodsWorksServices,
      // Neither is published anywhere in the HTML. `cpvCode` and `cpvCodes`
      // arrive later from the invitation archive via applyInvitationFacts, and
      // null here is silence, which keeps what is stored.
      cpvCode: null,
      cpvCodes: null,
      // `description` does NOT. It has no writer anywhere and no source to have
      // one: the docx's contract-subject line is the title verbatim, and the real
      // per-item text is already stored as tender_lots.name. The column is an
      // OCDS-shaped leftover — see docs/SCRAPER_WORKFLOW.md § 5. Do not "fix"
      // this by joining lot names into it.
      description: null,
      estimatedValue: detail.estimatedValue,
      currency: detail.currency,
      publishedAt: detail.publishedAt,
      deadlineAt: detail.deadlineAt,
      qnaDeadlineAt: detail.qnaDeadlineAt,
      auctionAt: detail.auctionAt,
      invitationUrl: detail.invitationUrl,
    },
    // The Գնառաջարկներ bid ledger, per lot. Empty on an unfinished tender.
    ledger: detail.lots,
  };
};

export default { SOURCE, observeDetail };
