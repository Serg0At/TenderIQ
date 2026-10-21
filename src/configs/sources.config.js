const sources = {
  eauction: {
    enabled: true,
    displayName: 'e-auction (reverse auctions)',
    baseUrl: process.env.SOURCE_EAUCTION_BASE || 'https://eauction.armeps.am',
    listingCron: process.env.SOURCE_EAUCTION_CRON || '*/5 * * * *',
    rateLimit: { requests: 20, perMs: 60000 },
    concurrency: 2,
    maxListingPages: 40,
    refreshCron: process.env.SOURCE_EAUCTION_REFRESH_CRON || '17 * * * *',
    refreshWindowDays: 30,
    maxRefreshBatch: 200,
    downloadDocuments: true,
    backfillDocuments: true,
    listingPaths: [{ slug: 'all-tenders', path: '/hy/public/tender/' }],
    detailBaseUrl:
      process.env.SOURCE_EAUCTION_DETAIL_BASE || 'https://eauction.armeps.am/hy/public/tender_details/tid/',
  },
  /**
   * The announcement index of every submission channel. Discovery only: it
   * points at ARMEPS tenders (armeps.am resourceId) and paper ones (an
   * uploaded invitation), and lists e-auctions too, which are only counted.
   */
  gnumner: {
    enabled: true,
    displayName: 'gnumner.minfin.am (ARMEPS and paper announcements)',
    baseUrl: process.env.SOURCE_GNUMNER_BASE || 'https://gnumner.minfin.am',
    // Every 5 minutes against a 15-minute freshness target. A quiet sweep is
    // one request per listing, so the cadence costs ~24 requests an hour.
    listingCron: process.env.SOURCE_GNUMNER_CRON || '*/5 * * * *',
    // Half of eauction's budget: a ministry site we have no relationship
    // with, and steady state needs a fraction of even this.
    rateLimit: { requests: 10, perMs: 60000 },
    // Cold-start bound only. ~10 notices a page and ~15 quotations a day, so
    // 5 pages is about three days of each listing on a first sweep. History
    // is a backfill's job.
    maxListingPages: 5,
    // `procedureType` is what a paper tender found on that listing is: the
    // buyer filed the notice there, and the invitation's own heading agrees.
    //
    // `kind: 'amendment'` is «Հրավերում կատարված փոփոխություններ», where a
    // buyer announces a change to an invitation (ticket 07). Its uploads are
    // amendment notices, never invitations, so it names no procedure type;
    // its ARMEPS links re-read the armeps.am page at once rather than at the
    // hourly refresh. Its sibling «Հրավերներում…» (with -ներում) is the public
    // organizations' listing, outside the procurement law, and is not read.
    //
    // `kind: 'contract'` is «Կնքված պայմանագրի մասին հայտարարություն», the
    // contract-concluded notices (ticket 08): the paper channel's results.
    // Every procedure type files there — ARMEPS, e-auction and single-source
    // ones too, all as uploads — about 50 a day, 6 a page.
    listingPaths: [
      { slug: 'open', path: '/hy/page/bac_mrcuyti_haytararutyun_ev_hraver/', procedureType: 'open' },
      { slug: 'quotation', path: '/hy/page/gnanshman_harcman_haytararutyun_ev_hraver/', procedureType: 'quotation' },
      { slug: 'amendment', path: '/hy/page/hraverum_katarvats_popokhutyunner/', kind: 'amendment' },
      { slug: 'contract', path: '/hy/page/knqvats_paymanagri_masin_haytararutyun/', kind: 'contract' },
    ],
    /**
     * A paper tender's file never changes, so nothing re-reads it — and its
     * status is read off its deadline. This re-normalizes, from storage and
     * with no request to gnumner, the paper tenders whose deadline has passed
     * while they still say open, so they close. Hourly; a tender leaves the
     * set as soon as it closes, so a batch is the day's ~6 quotations.
     */
    refreshCron: process.env.SOURCE_GNUMNER_REFRESH_CRON || '41 * * * *',
    refreshWindowDays: 30,
    maxRefreshBatch: 200,
    // The invitation is stored and listed as the tender's document. It costs
    // no request: it is the file the invitation fetch already downloaded.
    downloadDocuments: true,
    /**
     * Uploaded files from buyers outside the procurement law, matched on the
     * notice title. Read off the open-tender listing on 2026-10-19, where
     * these were the only uploaded files that were not public paper tenders.
     * A named list on purpose: an unlisted buyer stays in and is visible,
     * which is the failure worth having.
     */
    excludedBuyers: [
      {
        name: 'Electric Networks of Armenia (own open requests for proposals)',
        pattern: /«Հայաստանի էլեկտրական ցանցեր»/u,
      },
      {
        // e.g. «ՀՀ վարչապետի աշխատակազմի կողմից ՊՀԱԾ 4 (Վարկ No. 9338-ԱՄ)
        // շրջանակներում…» — a World Bank loan, procured under the lender's rules.
        name: 'Loan-financed project implementation units',
        pattern: /\(Վարկ\s*No\.?\s*\d+-ԱՄ\)/u,
      },
    ],
  },
  /**
   * armeps.am (European Dynamics e-PPS): the detail page of every ARMEPS
   * tender. It has no listing (its public search errors), so it is reached
   * only through a `resourceId` that gnumner — later PPCM — supplies.
   */
  armeps: {
    enabled: true,
    displayName: 'armeps.am (ARMEPS tender pages)',
    baseUrl: process.env.SOURCE_ARMEPS_BASE || 'https://armeps.am',
    // Same budget as gnumner: a government site we have no relationship with.
    // PPCM (ticket 10) is served from this host and will share the key.
    rateLimit: { requests: 10, perMs: 60000 },
    /**
     * The refresh re-reads every unsettled ARMEPS tender, not only those past
     * their deadline, because what it is for is a deadline armeps.am moves
     * while the gnumner notice stays the same. Every 3 hours, stalest first,
     * so ~500 open tenders cost ~70 requests an hour. After the deadline the
     * page has nothing more to say (awards are PPCM's, ticket 10), so the
     * window past it is short: long enough to catch a late extension.
     */
    refreshCron: process.env.SOURCE_ARMEPS_REFRESH_CRON || '29 */3 * * *',
    refreshWindowDays: 3,
    maxRefreshBatch: 200,
    downloadDocuments: true,
    backfillDocuments: true,
  },
};

const getSourceConfig = (key) => {
  const cfg = sources[key];
  if (!cfg) throw new Error(`[sources] Unknown source "${key}"`);
  return cfg;
};

const listEnabledSources = () =>
  Object.entries(sources)
    .filter(([, cfg]) => cfg.enabled)
    .map(([key]) => key);

/** A source with a listing is swept; one without (armeps.am) is only reached by id. */
const hasListing = (key) => Boolean(getSourceConfig(key).listingPaths?.length);

/** A source's host, `www.` dropped, for classifying links that point at it. */
const hostOf = (key) => new URL(getSourceConfig(key).baseUrl).hostname.replace(/^www\./, '');

export { sources, getSourceConfig, listEnabledSources, hasListing, hostOf };
