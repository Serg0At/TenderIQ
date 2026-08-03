const sources = {
  armeps: {
    enabled: true,
    displayName: 'ARMEPS / gnumner live notices',
    baseUrl: process.env.SOURCE_ARMEPS_BASE || 'https://gnumner.minfin.am',
    listingCron: process.env.SOURCE_ARMEPS_CRON || '*/5 * * * *',
    rateLimit: { requests: 20, perMs: 60000 }, 
    concurrency: 2,
    maxListingPages: 40,
    lookbackHours: 48,
    downloadDocuments: true,
    listingPaths: [
      { slug: 'open-competition', path: '/hy/page/bac_mrcuyti_haytararutyun_ev_hraver/' },
    ],
    detailBaseUrl: process.env.SOURCE_ARMEPS_DETAIL_BASE || 'https://armeps.am',
  },

  ppcm: {
    enabled: true,
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
