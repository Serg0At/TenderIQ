const sources = {
  armeps: {
    enabled: true,
    displayName: 'ARMEPS e-auction (reverse auctions)',
    baseUrl: process.env.SOURCE_ARMEPS_BASE || 'https://eauction.armeps.am',
    listingCron: process.env.SOURCE_ARMEPS_CRON || '*/5 * * * *',
    rateLimit: { requests: 20, perMs: 60000 },
    concurrency: 2,
    maxListingPages: 40,
    refreshCron: process.env.SOURCE_ARMEPS_REFRESH_CRON || '17 * * * *',
    refreshWindowDays: 30,
    maxRefreshBatch: 200,
    downloadDocuments: true,
    backfillDocuments: true,
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
