# 03 — Digest content: order, markers and cap

**What to build:** The digest reads like the product, not a dump. Tenders still accepting bids
come first, soonest deadline first; cancelled and closed ones follow, each marked with one word;
every line says which saved searches the tender matched; a busy day shows at most 20 tenders and
a count of the rest. Telegram and email list exactly the same tenders in the same order, and the
digest email can be unsubscribed from like any alert mail. See `.scratch/daily-digest/spec.md`,
*Content* and *Formatters*.

**Blocked by:** 02 — A daily email receives its matches in one 08:00 digest.

**Status:** done

- [x] Biddable tenders first by deadline ascending (no deadline last), then the rest by deadline
      ascending.
- [x] Markers: `cancelled` «չեղարկված»; `closed` or `awarded` «փակված»; `amended` «փոփոխված». An
      amended tender that is still biddable keeps its place among the biddable ones.
- [x] Each line: title, buyer, budget, deadline, the marker if any, "Matched: …" with the saved
      search names from the notification payload (an old notification without
      `matchedSearches` still renders), and the same tender link instant alerts use.
- [x] At most 20 lines, fewer if the Telegram message limit would be exceeded, then
      "…and N more matches"; every held row of the digest becomes `sent`, listed or counted.
- [x] Ordering, markers, cap and line content live once in the shared presentation module; the
      Telegram and email renderers only format it, and both list the same tenders in the same
      order.
- [x] The digest email carries the per-destination unsubscribe link and both `List-Unsubscribe`
      headers, or neither when `APP.API_BASE_URL` is unset — exactly as alert mail.
- [x] Relevance adds nothing to a digest.
- [x] Verified by hand: a digest with a biddable tender, an amended biddable tender and a
      cancelled one lists them in that order with the right markers; a digest of 30 held matches
      shows 20 and "…and 10 more matches" on both channels.

## Verified (2026-11-08, local `tendra`)

A throwaway organization with one daily Telegram chat and one daily email, held rows written by
hand against real tenders, transports faked at the adapter, driven through `handleDigestSend`;
deleted afterwards.

- Held in the order cancelled, amended, active (plus a closed tender whose notification has no
  `matchedSearches`): both channels list the active tender (deadline 11-19), then the amended
  biddable one «փոփոխված» (11-20), then the closed one «փակված», then the cancelled one
  «չեղարկված». The old notification renders with no "Matched" line. Links are the instant
  alerts' (`tenderLink`). All 8 held rows `sent`.
- 30 held matches with short titles: 20 listed and "…and 10 more matches" on both channels, all
  60 rows `sent`.
- 30 typical tenders (median title 115 characters, buyer 33): the Telegram limit decides — 14
  listed and "…and 16 more matches" on both, 3,544 visible characters; both channels' links in
  the same order. A worst case (900-character titles and buyers, 40 searches) clips each line and
  lists 3 in 3,024.
- With `API_BASE_URL` set, the digest email carries both `List-Unsubscribe` headers and the same
  URL in its footer; with it unset, neither header and the "Manage them in Tendra" footer.
- `digestContent` is the only place that orders, marks, clips and caps; the formatters take its
  result and nothing reads relevance.

Decided while building: the cap counts what Telegram counts (visible text, UTF-16) with a fixed
per-line allowance for the renderer's frame (`LINE_FRAME`, 64; Telegram's is ~45), so the email
lists exactly the tenders the chat does. Title, buyer and the matched line are clipped at 400,
200 and 300 characters so one line can never crowd the list out; no stored title reaches that. An
`active` tender past its deadline is not biddable and carries no marker — its deadline says
"(passed)".
