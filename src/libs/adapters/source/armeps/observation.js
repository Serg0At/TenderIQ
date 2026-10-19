import { parseCft } from './cft.parser.js';
import { cftUrl, documentsUrl } from './client.js';
import { sha256 } from '../../../../utils/hash.js';

/**
 * A stored armeps.am CfT page → an observation for the resolution module
 * (services/resolution.service.js). Everything armeps.am-specific about
 * normalization lives here, the counterpart of eauction/observation.js.
 *
 * No network, no database and no clock — `seenAt` is the payload's
 * `fetched_at`, so a replay from storage maps exactly as the original run did.
 */
export const SOURCE = 'armeps';

/** Every tender on armeps.am is bid there, as a sealed electronic submission. */
const SUBMISSION_CHANNEL = 'armeps';

export const observeDetail = (html, { externalId }) => {
  const cft = parseCft(html);

  // Layout-health alarm: the detail handler stores only pages that carry the
  // field grid, so a stored page with no labels is a redesign.
  if (cft.labelsSeen === 0) {
    throw new Error(`[${SOURCE}] CfT ${externalId} yielded 0 label/value pairs — parser likely broken`);
  }

  // A procedure type cannot be guessed, and a wrong one files the tender
  // under the wrong filter. The failed job names the label to add to
  // PROCEDURE_RULES in cft.parser.js.
  if (!cft.procedureType) {
    throw new Error(
      `[${SOURCE}] CfT ${externalId}: unknown procedure ${JSON.stringify(cft.procedureLabel)} — ` +
        'add it to PROCEDURE_RULES in armeps/cft.parser.js'
    );
  }

  return {
    source: SOURCE,
    // The page that creates an ARMEPS tender. gnumner only discovers it, and
    // results (PPCM) never create one.
    role: 'detail',
    externalId: String(externalId),
    url: cftUrl(externalId),
    pointer: null,
    procedureCode: cft.procedureCode,
    submissionChannel: SUBMISSION_CHANNEL,
    procedureType: cft.procedureType,
    buyerName: cft.buyerName,
    publishedAt: cft.publishedAt,
    deadlineAt: cft.deadlineAt,
    lotNumbers: cft.lots.map((lot) => lot.lotNumber),
    // The page states no status at all: armeps.am owns "open" and the
    // deadline, and the deadline is what resolution derives it from. Null
    // here is not an unmapped label — `observedStatus` is null too.
    status: null,
    observedStatus: null,
    tender: {
      sourceStatus: null,
      title: cft.title,
      referenceCode: cft.procedureCode,
      procedureType: cft.procedureType,
      submissionChannel: SUBMISSION_CHANNEL,
      goodsWorksServices: cft.goodsWorksServices,
      evaluationMethod: cft.evaluationMethod,
      // The page lists every CPV the tender is in, but has one column to put
      // it in; the first is the one it leads with. Per-lot codes are written
      // with the lots, by the document stage.
      cpvCode: cft.cpv[0]?.code ?? null,
      description: null,
      estimatedValue: cft.estimatedValue,
      currency: 'AMD',
      publishedAt: cft.publishedAt,
      deadlineAt: cft.deadlineAt,
      qnaDeadlineAt: cft.qnaDeadlineAt,
      // `auction_at` is an e-auction's auction. An ARMEPS tender has none,
      // and "Tenders Opening Date" is not one.
      auctionAt: null,
      // Where the tender's documents are, so a tender whose archive is not
      // stored yet still says so (`not_stored`) instead of showing nothing.
      invitationUrl: documentsUrl(externalId),
    },
    // armeps.am publishes no bids; its ledger is PPCM's (ticket 10).
    ledger: [],
    /**
     * What the document stage needs and nothing it would have to re-parse:
     * a fingerprint of the document table, so an added addendum queues a
     * download even when no tender field moved, and the page's per-file
     * languages and CPV codes, which the ZIP does not carry.
     */
    documents: {
      fingerprint: sha256(JSON.stringify(cft.documents.map((d) => d.documentId))).slice(0, 12),
      files: cft.documents.map(({ fileName, language }) => ({ fileName, language })),
      cpv: cft.cpv,
      listed: cft.documents.length,
      total: cft.documentsTotal,
    },
  };
};

export default { SOURCE, observeDetail };
