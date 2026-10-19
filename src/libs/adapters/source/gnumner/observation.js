/**
 * A gnumner notice → an observation for the resolution module
 * (services/resolution.service.js). Pure: the notice the listing parser
 * produced in, a plain object out.
 */
export const SOURCE = 'gnumner';

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

export default { SOURCE, observeArmepsNotice };
