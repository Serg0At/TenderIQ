import { closeDb } from '../libs/knex.js';
import { getStorage } from '../libs/storage/index.js';
import { observeDetail } from '../libs/adapters/source/armeps/observation.js';
import { parseInvitation } from '../libs/adapters/source/eauction/invitation.parser.js';
import { tenderCodes } from '../libs/cpv.js';
import tenders from '../repositories/tender.repo.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import savedSearches from '../repositories/savedSearch.repo.js';
import { matchCandidate, matchesByOrganization, ALERTABLE_STATUSES } from '../services/matcher.service.js';
import { logger } from '../utils/logger.js';

/**
 * Fill `tenders.cpv_codes` for tenders stored before it existed, from what is
 * already in storage — the armeps.am CfT page, the e-auction invitation
 * archive — never from the source (ticket 17).
 *
 *   node src/scripts/backfillCpvCodes.js            # dry run: counts, writes nothing
 *   node src/scripts/backfillCpvCodes.js --apply    # write the lists
 *
 * **It raises no alert.** The lists are written straight to the column — no
 * version, no event, no match job — because a code the tender always stated is
 * not news, and an old tender a supplier never heard about is not one to
 * announce now. What it reports instead is how many tenders gained a code and
 * how many organization alerts the same codes WOULD have raised, against the
 * saved searches as they stand, so that number is known before any alert job
 * runs on these tenders. A later amendment of one of them matches as usual.
 *
 * Idempotent: only tenders with an empty list are read, and the write fills a
 * blank only.
 */
const apply = process.argv.includes('--apply');

/** Where each source keeps the codes it states, and how to read them. */
const READERS = {
  armeps: {
    ref: (externalId) => `detail:${externalId}`,
    codes: (body, externalId) => observeDetail(body.toString('utf8'), { externalId }).tender.cpvCodes ?? [],
  },
  eauction: {
    ref: (externalId) => `invitation:${externalId}`,
    codes: (body) => parseInvitation(body).cpvCodes,
  },
};

const groupsOf = (candidate, profiles) => new Set(matchesByOrganization(candidate, profiles).map((g) => g.organizationId));

const run = async () => {
  const storage = await getStorage();
  const profiles = await savedSearches.listAll();
  const totals = {
    read: 0,
    noStoredPayload: 0,
    noCodes: 0,
    unsupportedSource: 0,
    withCodes: 0,
    gainedCodes: 0,
    codesGained: 0,
    newMatches: 0,
    newMatchesLive: 0,
    written: 0,
    failed: 0,
  };
  const gained = [];

  for (let afterId = null; ; ) {
    const rows = await tenders.findWithoutCpvCodes({ afterId, limit: 200 });
    if (!rows.length) break;

    for (const row of rows) {
      totals.read += 1;
      const [source, externalId] = row.source_id.split(':');
      const reader = READERS[source];
      if (!reader) {
        totals.unsupportedSource += 1;
        continue;
      }
      try {
        const payload = await sourcePayloads.findLatestByRef(source, reader.ref(externalId));
        if (!payload) {
          totals.noStoredPayload += 1;
          continue;
        }
        const body = await storage.get(payload.storage_key);
        const codes = reader.codes(Buffer.isBuffer(body) ? body : Buffer.from(body), externalId);
        if (!codes.length) {
          totals.noCodes += 1;
          continue;
        }
        totals.withCodes += 1;

        const tender = await tenders.findDetail(row.id);
        const before = matchCandidate(tender);
        const after = { ...before, cpvCodes: codes };
        const codesOf = (c) => tenderCodes({ cpvCode: c.cpvCode, cpvCodes: c.cpvCodes, lotCodes: c.lotCpvCodes });
        const had = new Set(codesOf(before));
        const added = codesOf(after).filter((code) => !had.has(code));
        if (added.length) {
          totals.gainedCodes += 1;
          totals.codesGained += added.length;
          gained.push(`${row.source_id} +${added.join(',')}`);

          const already = groupsOf(before, profiles);
          const fresh = [...groupsOf(after, profiles)].filter((org) => !already.has(org)).length;
          totals.newMatches += fresh;
          if (ALERTABLE_STATUSES.includes(tender.status)) totals.newMatchesLive += fresh;
        }

        if (apply && (await tenders.fillCpvCodes(row.id, codes))) totals.written += 1;
      } catch (error) {
        totals.failed += 1;
        logger.error(`[cpv-backfill] ${row.source_id} failed: ${error.message}`);
      }
    }
    afterId = rows[rows.length - 1].id;
  }

  for (const line of gained) logger.info(`[cpv-backfill] gained ${line}`);
  return totals;
};

run()
  .then((totals) => {
    logger.info(`[cpv-backfill] ${apply ? 'applied' : 'dry run'}: ${JSON.stringify(totals)}`);
    return closeDb().then(() => process.exit(totals.failed ? 1 : 0));
  })
  .catch(async (error) => {
    logger.error(`[cpv-backfill] aborted: ${error.message}`);
    await closeDb();
    process.exit(1);
  });
