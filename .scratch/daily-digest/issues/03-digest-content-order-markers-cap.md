# 03 — Digest content: order, markers and cap

**What to build:** The digest reads like the product, not a dump. Tenders still accepting bids
come first, soonest deadline first; cancelled and closed ones follow, each marked with one word;
every line says which saved searches the tender matched; a busy day shows at most 20 tenders and
a count of the rest. Telegram and email list exactly the same tenders in the same order, and the
digest email can be unsubscribed from like any alert mail. See `.scratch/daily-digest/spec.md`,
*Content* and *Formatters*.

**Blocked by:** 02 — A daily email receives its matches in one 08:00 digest.

**Status:** ready-for-agent

- [ ] Biddable tenders first by deadline ascending (no deadline last), then the rest by deadline
      ascending.
- [ ] Markers: `cancelled` «չեղարկված»; `closed` or `awarded` «փակված»; `amended` «փոփոխված». An
      amended tender that is still biddable keeps its place among the biddable ones.
- [ ] Each line: title, buyer, budget, deadline, the marker if any, "Matched: …" with the saved
      search names from the notification payload (an old notification without
      `matchedSearches` still renders), and the same tender link instant alerts use.
- [ ] At most 20 lines, fewer if the Telegram message limit would be exceeded, then
      "…and N more matches"; every held row of the digest becomes `sent`, listed or counted.
- [ ] Ordering, markers, cap and line content live once in the shared presentation module; the
      Telegram and email renderers only format it, and both list the same tenders in the same
      order.
- [ ] The digest email carries the per-destination unsubscribe link and both `List-Unsubscribe`
      headers, or neither when `APP.API_BASE_URL` is unset — exactly as alert mail.
- [ ] Relevance adds nothing to a digest.
- [ ] Verified by hand: a digest with a biddable tender, an amended biddable tender and a
      cancelled one lists them in that order with the right markers; a digest of 30 held matches
      shows 20 and "…and 10 more matches" on both channels.
