# Procurement sources beyond eauction.armeps.am: research

Status: research (no decision taken)
Accessed: 2026-10-17/18. Every "verified" claim was seen on the primary source at the URL given.
Fetching was deliberately light: about 60 requests in total across all hosts, nothing crawled.

## Summary

- **The e-auction is the minority of the money.** In 2025, e-auctions were 27% of completed procedures but
  only **12.1% of contract value** (AMD 56.6 bn of 466.8 bn). Open and urgent-open tenders, which are
  ARMEPS non-auction procedures, were 1.9% of procedures but **61.7% of value**, and requests for
  quotation were a further 9.2%. Measured by value, the source Tendra ingests today covers about an
  eighth of the market. *(MoF 2025 annual report, verified.)*
- **The best next source is probably neither gnumner nor the armeps.am HTML. It is PPCM.** The public
  JSON endpoints behind `armeps.am/ppcm/public/reports` return a per-bidder, per-lot ledger for **every
  procedure form, e-auction included**: bidder name, **bidder ՀՎՀՀ (tax ID)**, rejected flag, total and
  unit offer, winner, contract price, CPV and dates. There are about 179k rows for 2025 alone, and the
  data goes back to at least 2019. No login is needed, only a session cookie. *(verified by calling the
  endpoints.)*
- **ARMEPS non-auction (armeps.am/epps)** is server-rendered JBoss/Struts (European Dynamics e-PPS). Its
  public CfT page shows the notice, its metadata (CPV included) and the documents. It shows **no bidders
  and no results**, and the "Notices" tab needs a login. Bidders and prices are public through PPCM's
  `bid-report` instead. Each bidder's whole bid ZIP is downloadable, with the price in a machine-readable
  XML. *(verified.)*
- **gnumner.minfin.am** is the official bulletin. It is a mix of links into ARMEPS and eauction, plus
  DOC, DOCX, ZIP and RAR uploads for **paper procedures**. Results exist only as uploaded Word files. The
  ministry template for the "contract concluded" notice (`Կնքված պայմանագրի մասին հայտարարություն`)
  carries a full bidder/price table (net, VAT, gross) for every lot. That gives full coverage, including
  paper procedures, but at the cost of parsing DOCX. There are about 24,300 listing pages of these
  notices. The two paper procedures sampled were **absent from PPCM**. *(verified.)*
- **Recommendation as far as the evidence goes:** add **PPCM reports** first, as the award and price
  source for all ARMEPS procedures and as a cross-check on the e-auction ledger. Add **armeps.am CfT
  pages** for discovery of open tenders and quotations (CPV is on the page). Treat **gnumner** as a
  lower-priority third source that only adds paper procedures, through DOCX parsing.
- **2027 platform:** the official record does not support "an OCDS platform launches 2027-01-01". The
  government's own OGP commitment (Action Plan 2025–2027) puts **"launch of testing activities" in July
  2027**. The procurement-law amendments that create a "unified electronic platform" are planned to
  enter into force 2027-01-01 (first reading 18 June 2026, secondary source). No official source found
  mentions OCDS, and the OCP Data Registry lists no Armenian publication.
- **HayTender could not be examined.** `haytender.am` does not resolve, and the .am whois answers "No
  match". The owner needs to supply the actual URL.

---

## 1. Volume: e-auction vs. other procedures

### Source

Ministry of Finance, **«ՀԱՇՎԵՏՎՈՒԹՅՈՒՆ 2025 թվականի գնումների»** (Report on 2025 procurement). It is
linked from the gnumner home page, under "Հաշվետվություններ → 2025 թվականի հաշվետվություններ":
`https://gnumner.minfin.am/website/themes/frontend/default/files/years5.zip`. The ZIP was last modified
2026-04-29 and contains the report DOCX and annexes 1–3. **Verified**: I downloaded and read it.
The 2024 report is at `.../files/years.rar`. The 2026 entry and later ones link to
`https://armeps.am/ppcm/public/reports`, so for later years the yearly statistics live in PPCM.

Scope note from the report: 136,732 procedures were organised in 2025, and the report excludes
state-secret procurement.

### 2025, completed procedures (Աղյուսակ 2 count, Աղյուսակ 5 value), verified

| Form (`Գնման ձևը`) | Completed procedures | % count | Contract value, mln AMD | % value |
|---|---:|---:|---:|---:|
| Open tender (`Բաց մրցույթ`) | 1,161 | 0.9% | 129,249.4 | 27.7% |
| Urgent open tender (`Հրատապ բաց մրցույթ`) | 1,245 | 1.0% | 158,925.7 | 34.0% |
| Two-stage tender (`Երկփուլ մրցույթ`) | 19 | 0.0% | 2,835.8 | 0.6% |
| Request for quotation (`Գնանշման հարցում`) | 19,362 | 15.7% | 42,937.0 | 9.2% |
| **E-auction (`Էլեկտրոնային աճուրդ`)** | **33,688** | **27.3%** | **56,552.7** | **12.1%** |
| Urgent single source (`Հրատապ մեկ անձ`) | 680 | 0.6% | 12,607.7 | 2.7% |
| Single source (`Մեկ անձ`) | 67,128 | 54.5% | 63,669.5 | 13.6% |
| **Total** | **123,283** | | **466,777.9** | |

The percentages are my arithmetic on the report's figures. Estimated (budget) value shows the same
picture: e-auction is 59,758.4 of 490,542.9 mln AMD, or 12.2%.

Other figures from the same report, all verified:
- **Failed procedures** (`չկայացած`, Աղյուսակ 3): 13,449 in total, of which **10,169 were
  e-auctions**. Of the 43,857 e-auctions organised, 23% failed.
- **Participation** (Աղյուսակ 7): e-auction had 43,857 procedures and 135,705 participants, an average of
  3.1. Quotation had 22,535 procedures and 37,297 participants (1.7). Open tender had 1,188 and 3,024
  (2.5). Urgent open had 1,266 and 3,146 (2.5). Across all competitive forms: 68,870 procedures and
  179,205 participants (2.6).
- **Savings** (Աղյուսակ 6): 23,764.9 mln AMD in total. E-auction contributed 3,205.7 of it, and open
  plus urgent-open contributed 14,349.9.
- Works dominate the big tenders. Urgent open tenders for works came to 146,697.7 mln AMD in contract
  value. E-auction is overwhelmingly goods: 49,796.2 of its 56,552.7.

### Electronic vs. paper: what the evidence does and does not say

- **The report does not split by channel.** It splits by procedure form and by buyer type: state bodies,
  communities, commercial and non-commercial organisations subordinate to each, and public organisations.
  I found **no official figure for the share of procedures run on paper**.
- **Paper procedures exist and are tracked as such.** This is verified from the MoF guide «ԿՖԿՏՀ ներդրման
  ծրագրի ՓՈՒԼ 2.1-ի հաշվետվություն» (2022), `https://minfin.am/website/images/files/ff9cde6e.pdf`,
  section Գ9 ("PPCM համակարգում թղթային տարբերակով իրականացվող գնման ընթացակարգեր", i.e. "procurement
  procedures carried out on paper in the PPCM system"). It lists the forms entered into PPCM as paper:
  single source, ԳՉԾ, two-stage, "թղթային" (paper) open, urgent open, **e-auction**, quotation and urgent
  single source. Paper procedures "ARMEPS համակարգ չեն տեղափոխվում" ("are not moved to ARMEPS"). This is a
  2022 description, and current practice is unverified.
- The PPCM `bid-report` JSON carries a `paperBased` boolean per tender (verified field). It cannot be
  filtered on, so I could not count with it.
- **gnumner sample, page 1 of each listing on 2026-10-17 (verified, inferential only):**

  | Listing | Items | Links into ARMEPS/eauction | Uploaded files |
  |---|---:|---:|---:|
  | Quotation p.1 | 10 | 8 | 2 |
  | Quotation p.2 | 10 | 2 | 8 |
  | Open tender p.1 | 10 | 9 | 1 |
  | E-auction p.1 | 10 | 10 (eauction `tmid` UUIDs) | 0 |
  | Single source p.1 | 10 | 1 | 9 |

  An uploaded file *probably* means a paper procedure. That is unverified per item, because a buyer
  could also upload a copy.
- **PPCM report row counts** for "Organized procurement procedures" in 2025, which count bidder-lot rows
  rather than procedures (verified). E-auction 118,417; quotation 23,155; single source 18,626; urgent
  open 3,493; open 3,197; urgent single 887; two-stage 28. The total for all forms is 178,908. Compare
  these with the MoF participant counts above: 135,705 for e-auction and 37,297 for quotation. The gap
  suggests PPCM misses part of the market, plausibly paper and non-reporting buyers. **Inferred, not
  verified.**

## 2. Price data per source

### (a) gnumner.minfin.am

- **Stack:** server-rendered HTML (Apache), UTF-8. As recorded in SCRAPER_WORKFLOW, it sends no ETag or
  Last-Modified and omits its intermediate certificate. `certs/gogetssl-rsa-dv-ca2.pem` still works with
  curl (verified). There is no robots.txt per CLAUDE.md, which I did not re-check here.
- **Structure:** one listing per notice type under `/hy/page/<slug>/`, paginated as `/hy/page/<slug>/<N>`.
  Each item is a link plus "(Հրապարակված է <datetime>-ից ...)" ("published from ..."). There is **no
  per-notice ID page**. The link target is either an ARMEPS URL
  (`armeps.am/epps/cft/listContractDocuments.do?resourceId=N`), an eauction URL
  (`eauction.armeps.am/hy/public/tender_details/tmid/<uuid>`), or an uploaded file
  (`/website/images/original/<hash>.docx|.doc|.zip|.rar`). The only stable ID for a paper notice is the
  file name, plus the procedure code (`ծածկագիր`) inside the title text. Verified on 2026-10-17.
- **Results:** the listing «Կնքված պայմանագրի մասին հայտարարություն» (contract-concluded notice),
  `https://gnumner.minfin.am/hy/page/knqvats_paymanagri_masin_haytararutyun/`, showed **24,299 pages** on
  2026-10-17, newest first, every item a DOC or DOCX. I sampled two:
  - `https://gnumner.minfin.am/website/images/original/de685221.docx` is ԽՄՄ-ԳՀԾՁԲ-26/09, a quotation by
    a ՊՈԱԿ (state non-commercial organisation). It uses the template «Հավելված N 1 ՀՀ ֆինանսների
    նախարարի 2021 թվականի հունիսի 29-ի N 323-Ա հրամանի» (Annex 1 to MoF order 323-Ա of 2021-06-29). It
    contains a table «Յուրաքանչյուր մասնակցի հայտով ... ներկայացված գինը» ("price submitted in each
    participant's bid, including after simultaneous negotiation"). The columns are **Գինն առանց ԱԱՀ /
    ԱԱՀ / Ընդհանուր** (price without VAT / VAT / total), per lot (`Չափաբաժին`). Here that was two bidders:
    3,323,470 + 664,694 = 3,988,164, and 4,080,000 + 816,000 = 4,896,000. The template also has rejected
    bids with reasons, the decision date, the standstill period, the winner, the contract number and date,
    the contract price, and the estimated price per lot. **Verified.**
  - `https://gnumner.minfin.am/website/images/original/ca55aac0.docx` is ՀՊՏՀ-ԳՀԱՊՁԲ-26/ՄՊԼ-1, on the
    same template. A non-VAT payer (ԱՁ) shows an empty VAT cell. **Verified.**
  - Neither procedure code was found in PPCM `bid-report` or in the PPCM organized-procedures report.
    That makes them likely paper procedures (inferred), and this route is the **only** one that reaches
    them.
- **Other result-bearing listings exist but were not sampled:** «Գնահատող հանձնաժողովի նիստերի
  արձանագրություններ» (evaluation-commission minutes) and «Հայտերի բացման/գնահատման նիստի
  արձանագրություններ» (bid opening and evaluation minutes), split by buyer type.
- **Public API, feed or export: none found** on gnumner.

### (b) armeps.am (non-auction, e-PPS)

- **Stack:** `Server: Apache-Coyote/1.1`, `X-Powered-By: Servlet 2.5; JBoss-5.0`, footer "©2009 European
  Dynamics". It is server-rendered, uses a `jsessionid` URL and cookie, and sends `Cache-Control:
  no-store`. `robots.txt` returns 404 (verified). The anonymous quick-search
  (`/epps/quickSearchAction.do`) returned an "Application error" page both via GET and via POST with a
  session (verified), so I found no working public listing on e-PPS itself. Discovery would go through
  the gnumner listings or the PPCM bid-report.
- **CfT page**, `https://armeps.am/epps/cft/listContractDocuments.do?resourceId=12315509` (also
  `prepareViewCfTWS.do?resourceId=`), is public and **verified**. It shows the buyer, Armenian, English
  and Russian titles, CfT code (ԱՄՄՀ-ԳՀԱՇՁԲ-26/30), procedure (Request for Quotations), evaluation (Lowest
  Price), type (Works), **CPV (45221142)**, deadlines and the document list: invitation in HY/EN/RU, a
  RAR bill of quantities, and `c4t_12315509_1.xml` ("Tender Structure XML"). "Estimated value" and "Date
  of Awarding" were **blank** even though this tender is awarded. **There are no bidders and no prices
  on the page.** The "Notices" tab (`viewContractNotices.do`) answers "you must log in" (verified).
- **Bidders and prices come through PPCM `bid-report`** (`https://armeps.am/ppcm/public/bid-report`), an
  AngularJS SPA by iunetworks.am. It exposes JSON endpoints, verified 2026-10-17. They need a
  `JSESSIONID` from loading the page plus `Content-Type: application/json`; without the session they
  answer `{"status":500}`.
  - `POST /ppcm/public/bid-report/count` returned **66,845** tenders. The time range is unknown.
  - `POST .../list-tender` takes `{filter, order, page}` and returns per tender: a UUID `id`,
    **`armepsId`** (= the e-PPS `resourceId`, which makes it a stable ID), `code`, titles in HY/EN/RU,
    `state` (COMPLETED / CANCELLED / EVALUATION), **`paperBased`**, `procedureType` (for example
    `cft.procedure.type.request.for.quotations`, `...open.tendering.urgent`) and dates.
  - `POST .../retrieve-suppliers {tenderId}` returns per bidder: `supplierName`, **`taxpayerId`
    (ՀՎՀՀ)**, **`email`**, `country`, and `bidUrl`. For tender 12315509 that was two bidders, with
    `/ppcm/bids/12315509/20152.zip`.
  - **The bid ZIP is public** (2.1 MB, verified). It holds the bidder's signed PDFs and a `c4t` XML
    manifest whose financial envelope carries the price numerically: `<price year="0">1.155E7</price>`,
    which is 11,550,000 AMD. That figure matches PPCM's report row for the same bidder, `participant_total_price
    11550000`. The ZIP also contains the bidder's own proof documents (signed PDFs, certificates), which
    is a privacy and copyright consideration for anyone thinking of storing them.
- **PPCM public reports are the structured, all-forms ledger.** `https://armeps.am/ppcm/public/reports`
  is backed by `POST /ppcm/public/reports/{list,get-report,get-report-row-total,get-report-excel,...}`.
  This is verified, and the reports listed are:
  - **"Organized procurement procedures"** (`22654759-87e3-4c54-9095-ffe7517123c4`, table
    `report_cache_form1_tender_procedures`). Output columns: authority, CPV title/code, form,
    announcement date, unit, quantity, est. total/unit price, savings, tender_reference, opening date,
    num_of_participants, **participant_name, participant_taxpayer, bid_rejected, participant_total_price,
    participant_unit_price**, bidder_country, **winner_name, taxpayer_id**, award/standstill/notice/
    contract dates, contract_id, **contract_price**, authority_type, procurement_type, lot_name, lot_number,
    year. There is one row per bidder per lot.
    - Example, tender_reference ԱՄՄՀ-ԳՀԱՇՁԲ-26/30. Two rows: «Էռվիէռ Քոմֆորտ ՍՊԸ» (08422716),
      10,308,000, not rejected, winner; «ԱՐՍՏՈՆ ՍՊԸ» (08425842), 11,550,000, rejected. contract_price
      was 12,369,600, which is exactly 1.2 × 10,308,000. **Offers here appear to be net of VAT and the
      contract price gross** (inferred from one example).
    - Example, open tender ՀՀԱՄԱՇՏ-ԲՄԱՇՁԲ-25/1. Bidders 75,937,500 and 86,650,000, est 143,515,280,
      contract 91,125,000 (75,937,500 × 1.2). Same pattern.
    - Row totals by `year`: 2019: 115,793 · 2022: 154,301 · 2024: 179,354 · 2025: 178,908.
    - Filters take `{paramId, value}` pairs. `p_form` matches the **Armenian form name** (for example
      `Էլեկտրոնային աճուրդ`); the form UUID or code returns 0. `est_total_price` was 0 for at least one
      awarded RFQ, so the budget field is not reliable.
  - "Completed procurement procedures" (`f89dce4e-…`): names_of_participants and bids_of_participants as
    aggregated strings, the winner, contract_price.
  - "Failed procurement procedures" (`4399aa2f-…`): participants, prices, decision_basis.
  - Three dashboards: spend by authority and CPV, and by form and CPV.
  - The MoF guide (Գ15, `minfin.am/.../ff9cde6e.pdf`) adds that contracts and plans are downloadable as
    **Excel/CSV**, that an "archived procedures" section covers ARMEPS tenders **before 2018**, and that
    the dashboards refresh every 10 minutes. This comes from a 2022 description and was not re-verified
    live.
- **OCDS / bulk:** no OCDS endpoint found on armeps.am, PPCM or gnumner.

### Comparison with what we ingest today

| | eauction (today) | PPCM reports | armeps.am e-PPS | gnumner |
|---|---|---|---|---|
| Discovery (open notices) | yes | no (results only) | CfT page, no public listing found | yes, all types |
| CPV | only in invitation ZIP | yes, per row | yes, on CfT page | inside the document |
| Bidders + prices | HTML ledger: rank, initial/final, net/gross | JSON, per lot, **with bidder ՀՎՀՀ** | no; via bid-report + bid ZIP XML | DOCX table (net / VAT / gross) |
| Covers | e-auction only | ARMEPS + eauction (+ some paper?) | ARMEPS non-auction | everything, paper included |
| Format risk | HTML parser | undocumented JSON on a 2016 AngularJS app | old JBoss e-PPS | free-form uploaded Word files |

Note for CLAUDE.md: it says *"no source this project has carries a supplier's tax number"*. PPCM
publishes **`participant_taxpayer` / `taxpayerId` for every bidder** (verified). That reopens the
question of linking `organizations.supplier_party_id` by ՀՎՀՀ, and of de-duplicating supplier `parties`
across sources, which would only be safe for the PPCM-sourced parties.

## 3. The 2027 platform

- **Who and when (official).** Open Government Partnership commitment **AM0058**, "E-procurement system:
  Automated transfer of data of beneficial owners", in the Armenia Action Plan 2025–2027 (December).
  The lead institution is the Ministry of Finance, with EKENG among the supporting institutions.
  `https://www.opengovpartnership.org/members/armenia/commitments/AM0058/`, verified. The text is the
  Armenian government's own commitment, published by OGP. It says:
  - The ToR was completed in 2023, followed by a two-stage competition. **Pre-qualified: "AWS, Oracle,
    Ebidtopay, and European Dynamics"**. The 2nd-stage invitation was approved on 27 March 2025; "A
    winning participant has been selected. It is planned to sign a contract by the end of 2025." **The
    winner is not named.**
  - Milestones: **"Action 1. Launch of testing activities … July 2027"**; beneficial-owner register
    integration December 2027; transfer of bidder data to the Commission for the Prevention of
    Corruption declaration system, December 2027.
  - Goals include "machine processing of data (machine readability)", "effective access to data and
    information for the public", "a digital environment for management of procurement contracts", a
    digital "shop", and "complete information on the organisation of procurement procedures and
    management of contracts available on the Internet free-of-charge and automatically". **OCDS is not
    named.**
- **The law.** A package amending the Law «Գնումների մասին» (On Procurement) and the Law on the Budget
  System, which introduces «գնումների միասնական էլեկտրոնային հարթակ» ("a unified electronic
  procurement platform"). It was presented at first reading on **18 June 2026** by Deputy Finance
  Minister Avag Avanesyan, and «Նախատեսվում է, որ օրենքն ուժի մեջ կմտնի 2027 թվականի հունվարի 1-ից» ("the
  law is expected to enter into force from 1 January 2027"). **Secondary source only**: Armenpress,
  `https://armenpress.am/hy/article/1253403`. I could not find the bill on parliament.am or e-draft.am,
  nor its adoption status. A government session on 22 January 2026 (gov.am) also records procurement
  amendments entering into force 2027-01-01, but those concern conflict-of-interest rules, not the
  platform.
- **Reconciling the dates.** "Platform live on 2027-01-01" is not supported. The **law** may take effect
  on 2027-01-01, while the **system** has testing planned for July 2027. Inferred: the new platform is
  more plausibly live in late 2027 or 2028, with ARMEPS, eauction and PPCM still running through 2027.
  The reference spec's "contract already signed, OCDS-based, 2027-01-01" (`README.md`, `business/*.md`)
  cites no source.
- **Coverage.** The commitment states the problem as "the current system does not ensure the
  opportunity to include all clients" and the aim as "use of the system by all clients". That points to
  covering all buyers and all procedure types, but it is a goal, not a specification.
- **OCDS / bulk data / historical migration.** The **OCP Data Registry lists no Armenian publication**
  (`https://data.open-contracting.org/en/search/?q=Armenia`, checked 2026-10-17, read through a
  summarising fetch). **No official source found says the new platform will publish OCDS, offer an API
  or bulk download, or migrate or publish historical data.**

## 4. HayTender

- **Not examined.** `haytender.am` does not resolve through either the local resolver or 1.1.1.1 /
  8.8.8.8. `whois haytender.am` (AMNIC) answers **"No match"**, and haytender.com, .org, .net and
  hay-tender.am also do not resolve. Web search found nothing under "HayTender" or «Հայտենդեր».
- The only in-repo evidence is the 2026-10-17 commit 7b6ea1c and CLAUDE.md: "cross-checking five tenders
  against HayTender, which shows net". The owner has used it, so it exists under some other address.
- Unverified alternatives seen in search results, not examined: `tenderhub.am`, and `itender.am` (see
  docs/COMPETITORS.md history). Neither is HayTender.

## Open questions

1. **What is HayTender's real URL?** Until it is known, question 4 (which sources it shows, whether it
   shows bidder prices for non-auction procedures, and how deep its history goes) is unanswered.
2. **Paper share:** what fraction of procedures and value is paper-only? There is no official split.
   One way to measure it is to count `paperBased` across the PPCM `bid-report`, then compare PPCM report
   totals by form with the MoF annual table.
3. **PPCM completeness:** the two paper procedures sampled were missing from PPCM. Is PPCM missing
   paper procedures systematically, or only ones not yet reported by the buyer's administrator? How do
   PPCM rows per form reconcile with the MoF participant counts (for example, e-auction 118,417 rows vs
   135,705 participants)?
4. **PPCM price semantics:** confirm across more rows that `participant_total_price` is net of VAT and
   `contract_price` is gross. Confirm for e-auctions whether the PPCM price is the **final** auction
   offer or the initial one, by cross-checking a handful of tids against our ledger.
5. **What does the PPCM `year` field mean?** A `…-23/11` code appeared under year 2025, so it may be the
   plan year rather than the award year. Pagination and order limits, and rate tolerance, are untested.
   There is also an Excel export endpoint.
6. **Discovery of ARMEPS non-auction notices:** is there a working anonymous e-PPS search or listing?
   The quick-search errored. If not, gnumner listings are the discovery channel for open tenders and
   RFQs.
7. **Legal and privacy:** PPCM publishes bidder emails, individual entrepreneurs' tax IDs and complete
   bid ZIPs. What may Tendra store or redisplay, given CLAUDE.md's "Publish only aggregated/anonymized
   statistics externally" and Armenian personal-data law?
8. **2027 platform:** who won the competition, and is the contract signed? Is the procurement-law package
   adopted, and in what final text? Does the ToR (published for discussion in May 2023) specify OCDS, an
   API or historical migration? The ToR is the document to find next, probably on e-draft.am or
   minfin.am.
9. **Does CLAUDE.md's "Strategic clock: launches 2027-01-01" need rewording** to "law in force
   2027-01-01; system testing from July 2027 (OGP AM0058)"? That is a doc change for the owner to decide.

## Verification against our e-auction ledger (2026-10-18)

Done by hand against the local `tendra` DB (live import, tenders published 2026-08-12 onward) and
the PPCM "Organized procurement procedures" report, filtered by `tender_reference`.

- **Request shape:** `POST /ppcm/public/reports/get-report` with
  `{reportId, values: [{paramId, value: "<plain string>"}], page: {index, size}, order: null}`.
  An array `value` answers HTTP 400. Any other `page` shape silently caps at 15 rows.
- **Coverage: 12 of 24 awarded e-auction tenders were in PPCM.** The misses are not by age (the
  oldest hits and misses share a publish date). The likely cause is that PPCM lists a procedure
  only once the buyer files its results, but that is **unconfirmed**. `bid-report` would settle
  it, but it answered `{"status":500}` to every request that day, even with an empty filter.
- **Prices: 95 of 95 bidder rows matched our `final_offer_net` exactly.** PPCM's
  `participant_total_price` is the final auction offer, net of VAT. It is never the opening offer.
- **Contract price = our gross award** (`awards.amount`) on 28 of 29 winners. The 29th differs
  by 1.50 AMD (rounding).
- **Row parity:** a 26-lot tender (ԵՔ-ԷԱՃԱՊՁԲ-26/338) has 48 rows on both sides.
- **`bid_rejected` is not reliable.** It is mostly null. Where it is set, it disagrees with the
  ledger's accepted/rejected status in 28 of 95 rows, including one bidder the ledger lists as
  accepted at rank 2. For e-auctions, keep the eauction ledger as the authority on status and rank.
- **Why tenders are missing:** `bid-report` search is broken on PPCM's side; the owner confirmed it
  fails in a browser too. I looked up three missing tenders' buyers instead, by their exact PPCM
  names via `POST /ppcm/public/autocomplete/get-authority-list {value, authorityType: null}`. That
  endpoint also returns each buyer's **`tin`**. I then queried all three result reports for 2026:
  - **Vedu Medical Center (`ՎԲԿ`): lag.** Awarded and completed tenders run up to `26/17`, failed
    ones up to `26/25`. Our awarded `26/22` is not in PPCM yet. Failures appear to be filed sooner
    than awards.
  - **Burns and Dermatology Center (`ԱՄԱԿ`): the buyer is not filing.** It has 0 awarded or
    completed rows for 2026 but 17 failed tenders, so PPCM knows it. Its awarded `26/40` is absent.
  - **Prime Minister's Office (`ՀՀՎԱ`): busy and filing.** It has 92 awarded tenders across
    e-auction, open (`ԲՄ`) and quotation (`ԳՀ`) procedures, but not our `26/51`; that fits lag.
  - So a PPCM gap is either lag or a buyer that never files. A PPCM ingester needs a re-poll
    window, like `tender.refresh`, and a coverage figure. It cannot be the only source of awards.

## Paper share, measured on gnumner announcements (2026-10-18)

The first 5 listing pages of each announcement type (about 45 items each) were classified by
where each item's link points: ARMEPS or eauction means electronic; an uploaded file means
probably paper. The "contract concluded" listing can't be used for this, because it mixes
notices from every channel.

| Type (listing slug) | Window | Electronic | Uploaded file |
|---|---|---|---|
| Open tender (`bac_mrcuyti_haytararutyun_ev_hraver`) | 10-13 → 10-16 | 37 | 8, of which **1** is public paper (see below) |
| Quotation (`gnanshman_harcman_haytararutyun_ev_hraver`) | 10-15 → 10-17 | 26 | **19 (42%)** |
| Single source (`_mek_andzic_…`) | 2022-09 → 2026-10 | 0 | 45, so rare on gnumner |
| E-auction (`elektronayin_achurdi_…`) | 10-15 → 10-17 | 45 (eauction) | 0 |

- **Open tender files are mostly outside procurement law.** 6 are Electric Networks of Armenia's
  own "open request for proposals" (a private company) and 1 is a World Bank-funded project. Only
  the Academy of Sciences ZIP is a public paper open tender.
- **Paper quotations are confirmed.** 3 of 3 sampled `.docx` invitations say «հայտերն անհրաժեշտ
  է ներկայացնել [address] հասցեով, **փաստաթղթային ձևով** մինչև … հրապարակման օրվանից հաշված
  **7-րդ օրվա**» ("bids must be submitted to [address] **in paper form**, by the **7th day**
  after publication"). The buyers are regional and small: school, polyclinic, national park,
  research institutes, community utilities.
- **Rough volume:** about 15 quotations a day, of which about 6 are paper. That is roughly 1,500
  paper quotations a year. It is extrapolated from 3 days in October, which is year-end
  budget-spending season, so treat it as an **inference**.
- **Value: small.** Quotation is the below-threshold procedure (9.2% of 2025 value), so paper is
  plausibly about 4% of contract value. That figure is inferred.
- **Results:** a paper quotation's bidder prices are published only in the gnumner "contract
  concluded" `.docx` (template 323-Ա, net, VAT and total per lot). The two sampled earlier were not
  in PPCM.

## Identity facts for merging sources (2026-10-18)

- **A procedure code is not a tender identity.** In the local DB, 1,152 e-auction tenders carry
  1,146 distinct `reference_code` values. Six codes each belong to two tids: the same buyer
  cancels and re-announces under the same code within days, and for `ԱՄԱԿ-ԷԱՃԱՊՁԲ-26/40` both runs
  were awarded.
- **gnumner points to e-auctions by `tmid` UUID** (`/tender_details/tmid/<uuid>`), never by tid.
  The tmid page is an empty shell, and the 9 stored eauction detail pages I checked contain no
  UUIDs at all. There is no tmid-to-tid mapping available today.
- **gnumner points to armeps.am by `resourceId`**, which is the same number as PPCM bid-report's
  `armepsId`. That is a native key across three sites.
- **Code spelling varies in titles:** «» quotes, an en dash (`ՍԱՊ–ԳՀԱՊՁԲ-26/18`), inner spaces
  (`ՀՀ ՊՆ-ԲՄԱՊՁԲ-27-7/5`), and sometimes no code at all in the title.
