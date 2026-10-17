# 01 — Filter Discovery by purchase kind

**What to build:** A supplier can narrow Discovery to tenders that buy goods, works or services.
A cleaning company stops reading through 373 equipment purchases to find the 47 service contracts.

The source already labels every tender (Ապրանք / Աշխատանք / Ծառայություն) and the detail parser
already stores it on every row — there is nothing to scrape and nothing to migrate. The column
simply has no filter in front of it. This is the smallest slice in the feature and the fallback
the relevant list points a supplier at when it has nothing to rank on.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] The tender list accepts a purchase-kind filter and returns only tenders carrying that label.
- [x] The filter is validated against the three labels the source actually emits; anything else is
      a validation failure, not an empty list.
- [x] The filter composes with every existing Discovery filter and with cursor paging.
- [x] Omitting it changes nothing about today's response.
- [x] The value is part of the tender shape the API already returns, so a client can display what
      it filtered on.
- [x] `docs/API_REFERENCE.md` documents the filter.
