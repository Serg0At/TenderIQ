# Competitors — field notes

Supplements the reference spec's `business/Competitor Analysis.md`, which **does not mention
itender.am**. That omission still matters, but less alarmingly than a first read of their
marketing suggested.

Researched 2026-08-28. Two passes: public marketing pages, then a **registered account's
dashboard**. The second pass contradicted the first on several points — recorded below, because
the gap between what iTender advertises and what it ships is itself the finding.

---

## itender.am

**verified:** Yerevan, 24 Azatutyan Ave, +374 10 244974. Copyright 2018–2026 — roughly eight
years operating. Armenian interface.

### It is a buyer-side product with a supplier funnel

The dashboard splits into **Կազմակերպիչ** (organizer — the buying side) and **Մասնակից**
(participant — the supplier side). Everything monetised sits on the organizer side.

**verified — all four paid tiers are billed «1 տարի ժամկետով» per single organizer:**

| tier | what it unlocks |
|---|---|
| Անվճար (free) | browse, filter, view statistics, submit a price for single-source purchases |
| Էկոնոմ | procurement plan creation, responsible divisions, single-source procedures, auto-generated documents, Excel/PDF export, CPV integration |
| Պրեմիում | competitive procedures (ԲՄ, ՀԲՄ, ԳՀ, ՀՄԱ), automatic price comparison and winner selection, evaluation records |
| Գոլդ | contract management, delivery-acceptance documents, deadline reminders, complaint analysis |

Prices render as **0 դր.** on every tier while a «Վճարել» (Pay) button is present — promotional,
or JS-rendered figures not captured. Unresolved, but the paid flow exists.

### What the supplier actually gets (from the logged-in dashboard)

Under **Մասնակից**, the entire supplier surface is:

- **Տենդերներ** — tender listings
- **Առաջարկներ** — offers/proposals
- **Պայմանագրերի կառավարում** — greyed out (Գոլդ-tier feature)

Separately in the sidebar:

- **Վիճակագրություն** — **Beta, and greyed out**
- **Անժամկետ տենդերներ** — Beta (Բոլորը / Գնումներ / Վաճառքներ / Հետաքրքրողներ) — an open-ended
  buy/sell board, closer to B2B classifieds than procurement intelligence

**No AI feature appears anywhere in the dashboard.** Social-media posts reference an "AI
assistant"; on the evidence available that is support chat, not tender intelligence.

### Correction to the first read

The marketing site advertises «մրցակիցների ներկայացրած գները և առաջարկները» (competitors'
presented prices and offers), winning-price analysis, market averages, and contract management.
A first pass over those pages read as *"they already ship several things on TenderIQ's roadmap."*

**The product does not support that reading.** Statistics is Beta and greyed; contract management
is a Gold-tier lock. Marketing copy described the roadmap, not the build.

The lesson generalises: judge a competitor from an account, not a landing page.

### Revised competitive position

| | TenderIQ | iTender |
|---|---|---|
| primary customer | suppliers | **procuring organisations** |
| monetisation | supplier subscription | **per-organizer annual licence** |
| per-lot competitor bid prices | **65,075 rows, shipped** | not visible; Statistics is Beta |
| price benchmarks, buyer/supplier profiles | shipped | not visible |
| win/loss reconciliation | shipped | none |
| AI checklist with verified evidence | shipped | none |
| procurement document generation for buyers | none (not the product) | **shipped** |
| coverage | 1 source, e-auctions only, ~2,590 tenders | AM public + private, RU, all procedure types |

**They are not competing for the same wallet.** iTender sells procurement automation to buyers.
TenderIQ sells bid intelligence to suppliers. The overlap is the listings layer, which is
commodity on both sides.

### The real risk is adjacency, not competition

iTender has eight years of relationships, both sides of the market, and a **Beta statistics
module**. That module is precisely the direction TenderIQ's moat lies in. They have the
distribution and the data position to build supplier intelligence whenever they choose; TenderIQ's
lead is a head start, not a barrier.

The structural defence is the one already written into CLAUDE.md: **suppliers only**. A platform
serving buyers *and* the suppliers bidding against them has a trust problem with competitive
pricing data that TenderIQ does not. That argument should be made explicitly in positioning — it
is currently honoured in the schema and said nowhere a customer would see it.

### Where iTender is genuinely ahead

- **Coverage.** AM public *and private*, Russian tenders, all procedure types (sealed bid, open
  bid, RFP, two-stage). TenderIQ is one source, e-auctions only. A supplier bidding on open
  competitions finds most of their market absent — no checklist quality compensates for a tender
  that is not there. This keeps the deferred second source (gnumner) high priority.
- Eight years of brand, an office, a phone number, a banking tie-up for guarantees.
- Buyer-side revenue: buyers hold budgets; supplier SMEs are price-sensitive.

## Still open

1. **Does the Beta statistics module show per-bidder, per-lot prices?** It was greyed on the
   registered tier. If it ships at TenderIQ's granularity, the moat narrows sharply. Worth
   re-checking periodically — this is the single indicator to watch.
2. **Real prices.** Every tier displays 0 դր. beside a Pay button.
3. **Add iTender to the spec's `business/Competitor Analysis.md`** — it is absent, which makes
   that document misleading about the landscape.
