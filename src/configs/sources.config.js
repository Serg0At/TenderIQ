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
    //
    // `kind: 'failed'` is «Չկայացած գնման ընթացակարգի մասին հայտարարություն»,
    // the failed-procedure notices (ticket 09): the ARMEPS and paper
    // channels' cancellation source. Uploads only, e-auctions' among them —
    // about 10 a day (180 over 10-05 → 10-23), 6 a page.
    //
    // `kind: 'eauction'` is «Էլեկտրոնային աճուրդի հայտարարություն և հրավեր»,
    // where every link is an e-auction's `tmid` page (ticket 34). Indexed in
    // `listing_notices` and never ingested: eauction.armeps.am is the only
    // source of an e-auction tender, and this listing is the one check on its
    // sweep that does not come from that site. Nothing waits on it, so it has
    // its own `cron` and sweeps hourly, its page 1 at `priority` behind live
    // discovery (later pages go at CHAIN, like every chain's: ticket 39) —
    // the chain walks to the watermark however rarely it runs. 10 notices a
    // page and ~30 a day (50 over 10-28 → 10-30), so an hour costs one or two
    // requests, and a cold start's 5 pages reach back under two days.
    listingPaths: [
      { slug: 'open', path: '/hy/page/bac_mrcuyti_haytararutyun_ev_hraver/', procedureType: 'open' },
      { slug: 'quotation', path: '/hy/page/gnanshman_harcman_haytararutyun_ev_hraver/', procedureType: 'quotation' },
      { slug: 'amendment', path: '/hy/page/hraverum_katarvats_popokhutyunner/', kind: 'amendment' },
      { slug: 'contract', path: '/hy/page/knqvats_paymanagri_masin_haytararutyun/', kind: 'contract' },
      { slug: 'failed', path: '/hy/page/chkayacats_gnman_yntacakargi_masin_haytararutyunner/', kind: 'failed' },
      {
        slug: 'eauction',
        path: '/hy/page/elektronayin_achurdi_haytararutyun_ev_hraver/',
        kind: 'eauction',
        cron: process.env.SOURCE_GNUMNER_EAUCTION_CRON || '23 * * * *',
        priority: 'RESULTS',
      },
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
    // PPCM is served from this host and draws on this budget too
    // (`ppcm.rateLimitSource`): one host, one allowance.
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
  /**
   * PPCM (armeps.am/ppcm), the public reports behind which every ARMEPS
   * tender's bidders, prices and winner are published (ticket 10, ADR 0004:
   * the ARMEPS channel's award source). Results only: it creates no tender
   * and has no listing; a tender is asked about by its procedure code.
   */
  ppcm: {
    enabled: true,
    displayName: 'PPCM (ARMEPS results)',
    baseUrl: process.env.SOURCE_PPCM_BASE || 'https://armeps.am',
    // Served by armeps.am, so it spends armeps.am's budget rather than a
    // second one of its own pointed at the same host.
    rateLimitSource: 'armeps',
    /**
     * Which ARMEPS tenders are asked about: past their deadline, not
     * cancelled, and with a lot that has neither an award nor a recorded
     * failure (one awarded lot does not settle the rest), deadline within
     * the window. A buyer files its
     * results late or never (research.md: lag of weeks, and buyers that do
     * not file), so the window is long and each tender is asked at most once
     * per `pollIntervalHours`. Every 2 hours, a batch each: ~720 asks a day
     * at most, one request each — results are not time-critical, so
     * politeness wins over freshness.
     */
    refreshCron: process.env.SOURCE_PPCM_REFRESH_CRON || '13 */2 * * *',
    refreshWindowDays: 90,
    maxRefreshBatch: 60,
    pollIntervalHours: 24,
    /**
     * Awarded e-auctions are asked about too, for their bidders' ՀՎՀՀ alone
     * (ticket 11), in whatever room a batch has after the ARMEPS asks, while
     * a bidder of the tender still has none — same window. About half are
     * ever in PPCM (12 of 24 on 2026-10-18), so most are asked to the end of
     * the window: every 3 days, not daily, keeps ~700 tenders near 230 asks a
     * day instead of filling the batch.
     */
    taxIdPollHours: 72,
    /**
     * «Կազմակերպված գնման ընթացակարգեր», one row per bidder per lot. Read
     * off `POST /ppcm/public/reports/list` on 2026-10-23. A row is a bare
     * array in `columns` order — the report's `outputFormats` — so a column
     * added or moved there must be added or moved here; the parser refuses a
     * row of another length.
     */
    organizedProcedures: {
      reportId: '22654759-87e3-4c54-9095-ffe7517123c4',
      // `tender_reference`, an exact and case-sensitive match on the code.
      codeParamId: '2241bc3a-61eb-4986-b249-2ef5e2b38a33',
      // `p_form`, an exact match on the form's Armenian name («Բաց մրցույթ»
      // does not return «Հրատապ բաց մրցույթ», checked 2026-10-27).
      formParamId: 'bf2d5e57-d8f9-4060-9f36-914cfc7643ed',
      // `announcement_date`, a DATE parameter: "YYYY-MM-DD,YYYY-MM-DD", both
      // ends inclusive — the reports page's own encoding (reports-app.js).
      announcedParamId: 'e2fab567-8fb5-a1aa-bc3f-13d264f2eaaf',
      // Any `page` other than `{ index, size }` silently caps at 15 rows.
      pageSize: 100,
      // A code's rows past this many pages is not one tender's ledger.
      maxPages: 20,
      columns: [
        'authority_name', 'cpv_title', 'cpv_code', 'p_form', 'announcement_date', 'm_unit', 'quantity',
        'est_total_price', 'est_unit_price', 'tender_savings', 'tender_reference', 't_opening_date',
        'num_of_participants', 'participant_name', 'participant_taxpayer', 'bid_rejected',
        'participant_total_price', 'participant_unit_price', 'bidder_country', 'winner_name', 'taxpayer_id',
        'award_date', 'standstill_start', 'standstill_end', 'winner_notice_date', 'winner_contract_submit_date',
        'contract_sign_date', 'contract_id', 'contract_price', 'brief_description_per_tender',
        'brief_description_per_contract', 'authority_type', 'procurement_type', 'lot_name', 'lot_number', 'year',
      ],
    },
    /**
     * The missed-tender sweep (ticket 12): the same report read by
     * announcement day, one form at a time, every day of the window, so
     * every procedure PPCM has filed is resolved — and one Tendra holds no
     * tender for is recorded as `no_candidate`.
     *
     * By announcement day because every row of a procedure shares its
     * announcement, so a day's answer holds whole procedures, and a buyer's
     * late filing lands in a day already being read. 90 days of the four
     * competitive forms held ~8,000 rows on 2026-10-27 (e-auction 5,577,
     * quotation 2,243), a day ≤ 300: one page each, about 450 requests a
     * day, nearly all of them days with nothing new.
     *
     * Single source is not swept: a procedure with no invitation is never a
     * tender Tendra missed (ticket 31), and «Մեկ անձ» is half of every
     * procedure filed. Nor are grants («Դրամաշնորհային մրցույթ», 1,924 rows
     * in the year to 2026-10-27), which no supplier bids for. Every other
     * form `get-form-list` names — «Բաց ընթացակարգ», simplified, framework,
     * competitive dialogue, negotiated, exchange — had 0 rows that year; a
     * form that starts to carry rows has to be added here by name, exactly.
     */
    missedSweep: {
      cron: process.env.SOURCE_PPCM_SWEEP_CRON || '29 1 * * *',
      windowDays: 90,
      forms: ['Բաց մրցույթ', 'Հրատապ բաց մրցույթ', 'Գնանշման հարցում', 'Երկփուլ մրցույթ', 'Էլեկտրոնային աճուրդ'],
      // A page of 1,000 is served (291 rows of the busiest day checked came
      // back in one): a day is one request, and a split page cannot cut a
      // procedure's rows in two.
      pageSize: 1000,
      maxPages: 10,
    },
    /**
     * PPCM's bid-report (`/ppcm/public/bid-report`), asked for the armeps.am
     * `resourceId` (`armepsId`) of a procedure Tendra has no tender for, so
     * the gap repairs itself (ticket 12). It answers only the shape its own
     * page sends — every filter field present and an `order` — and
     * `{"status":500}` to anything else, which is what research.md saw on
     * 2026-10-18 (verified 2026-10-27). A code is asked at most once per
     * `repairPollHours`, whatever the answer.
     */
    bidReport: {
      repairPollHours: 24,
      pageSize: 20,
    },
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
