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
    listingPaths: [
      { slug: 'open', path: '/hy/page/bac_mrcuyti_haytararutyun_ev_hraver/' },
      { slug: 'quotation', path: '/hy/page/gnanshman_harcman_haytararutyun_ev_hraver/' },
    ],
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

export { sources, getSourceConfig, listEnabledSources };
