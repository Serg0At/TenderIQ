# 37 — Paper invitations whose deadline sentence is not read

**What to build:** The paper invitation parser reads the bid deadline in every wording of the
submission sentence that buyers use. When no deadline can be read and the listing shows no close
either, the tender does not stay biddable forever.

**Blocked by:** None.

**Status:** needs-triage

Found in ticket 36's replay (local `tendra`, 2026-10-29). Four stored invitations log `states no
deadline, and the listing shows no close: stored without one`. These tenders have no
`deadline_at`, so nothing ever closes them.

| invitation | code | what the sentence says |
|---|---|---|
| `d2055d44…` | ՇՄՁԻԹՄԴ-ԳՀԱՇՁԲ-26/01 | «… հրապարակման օրվանից հաշված 7 -րդ օրը՝ 2026 թվականի սեպտեմբերի 11-ին ժամը 11։00-ն»: a day count, with the date written out in words in place of «օրվա ժամը» |
| `f711fe0c…` | ԿՀԳԿ-ԳՀԱՊՁԲ-26/15 | «… մինչև 2026 թվականի Հոկտեմբերի 16-ին ժամը 12:00-ը»: a date with the month in words |
| `a6e7e118…` | ԼՄՓՀ-ՓԿՀ-ԳՀԱՊՁԲ-26/06 | «… մինչև սույն հայտարարությունը և հրավերը հնարավոր մասնակցին ուղարկվելու օրվանից հաշված 7-րդ օրվա ժամը 12:00-ն»: counted from the day the invitation was **sent** to the supplier, not from publication |
| `bb9dec42…` | ԳԳԱԿ-ԳՀԾՁԲ-27/1/Պ | no sentence the parser recognises. Not looked at yet |

The first two are template wordings: the date is right there in the text. The third is a
different case. The send date is not on gnumner, and publication + N would be a guess.
Ticket 06 says showing a day early is the safe error, but nothing has checked that the send day
falls on or before the publication day.

## Acceptance

- [ ] **Read the date in words** («2026 թվականի սեպտեմբերի 11-ին ժամը 11։00»), both after a
      day count and on its own. Check it against the stated bid-opening date, as ticket 06 did.
- [ ] **Decide the «ուղարկվելու օրվանից» case.** Either count it from publication and say why
      that is the safe error, or leave it with no deadline. Record which.
- [ ] **Open `bb9dec42…`** and record what its sentence says.
- [ ] **Decide what a paper tender with no deadline shows.** Today it is `active` with no end.
      ԱԱ-ԳՀԱՇՁԲ-26/33 sat like that from 2026-09-04 until ticket 36.
- [ ] **Old and new parsers over all stored paper invitations:** identical output except the
      deadlines this ticket adds. Paste the differences, as ticket 36 did.
