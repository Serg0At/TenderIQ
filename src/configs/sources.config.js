const sources = {
  armeps: {
    enabled: true,
    displayName: 'ARMEPS e-auction (reverse auctions)',
    baseUrl: process.env.SOURCE_ARMEPS_BASE || 'https://eauction.armeps.am',
    listingCron: process.env.SOURCE_ARMEPS_CRON || '*/5 * * * *',
    rateLimit: { requests: 20, perMs: 60000 },
    concurrency: 2,
    /**
     * Cold-start / post-outage bound only. Steady-state depth is the tid
     * watermark in workers/scraper.js, which normally stops this board on
     * page 1. There is deliberately no `lookbackHours` here: this listing
     * table has no publish-date column, so any time-based depth rule would
     * be comparing against a field that does not exist.
     */
    maxListingPages: 40,
    /**
     * Award-catching pass. Hourly rather than every five minutes: a result
     * ledger appears once, hours after the auction, so there is nothing to
     * gain from checking more often — and each run costs one request per
     * unsettled tender out of the same 20/min budget the sweep uses.
     *
     * `refreshWindowDays` bounds how long a tender stays eligible; the batch
     * cap keeps one run from monopolising the rate budget.
     */
    refreshCron: process.env.SOURCE_ARMEPS_REFRESH_CRON || '17 * * * *',
    refreshWindowDays: 30,
    maxRefreshBatch: 200,
    downloadDocuments: true,
    listingPaths: [{ slug: 'all-tenders', path: '/hy/public/tender/' }],
    detailBaseUrl:
      process.env.SOURCE_ARMEPS_DETAIL_BASE || 'https://eauction.armeps.am/hy/public/tender_details/tid/',
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
