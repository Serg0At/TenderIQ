const sources = {
  armeps: {
    enabled: true,
    displayName: 'ARMEPS / gnumner live notices',
    baseUrl: process.env.SOURCE_ARMEPS_BASE || 'https://eauction.armeps.am/hy/public/tender/',
    listingCron: process.env.SOURCE_ARMEPS_CRON || '*/5 * * * *',
    rateLimit: { requests: 20, perMs: 60000 }, 
    concurrency: 2,
    maxListingPages: 40,
    lookbackHours: 24 * 30,
    downloadDocuments: true,
    listingPaths: [
      { slug: 'open-competition', path: '/hy/page/bac_mrcuyti_haytararutyun_ev_hraver/' },
    ],
    detailBaseUrl: process.env.SOURCE_ARMEPS_DETAIL_BASE || 'https://eauction.armeps.am/hy/public/tender_details/tid/',
  },

  ppcm: {
    // PPCM is an importer, not a listing scraper. Enable it together with the
    // importer worker; otherwise the generic sweep handler has no listing path
    // to process and every scheduled job fails.
    enabled: false,
    displayName: 'PPCM award & contract exports',
    baseUrl: process.env.SOURCE_PPCM_BASE || 'https://gnumner.minfin.am',
    listingCron: process.env.SOURCE_PPCM_CRON || '0 3 * * *',
    rateLimit: { requests: 10, perMs: 60000 },
    concurrency: 1,
    maxListingPages: 200,
    lookbackHours: 24 * 7,
    downloadDocuments: false,
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
