// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';
import { getStorage, tenderDocTextKeyOf } from '../src/libs/storage/index.js';
import ChecklistExtractionService from '../src/services/checklistExtraction.service.js';

/**
 * Ticket 24: two columns on `tender_documents`, so a checklist can say whether
 * its AI items come from the invitation the tender holds now.
 *
 * - `stored_at`: when the row was written. A tender holds one invitation row
 *   per document set (ticket 18), and the newest is the current one. Existing
 *   rows take their archive's `source_payloads.fetched_at`; a row with no
 *   payload keeps the time this ran.
 * - `text_hash`: `ChecklistExtractionService.documentHash` of the extracted
 *   text stored beside the archive — what `checklists.document_hash` is
 *   compared with. NULL where no text was stored.
 *
 * Additive and safe to run twice. The schema change runs in one transaction;
 * the text hashes are then filled from storage, blanks only, one row at a
 * time.
 *
 * Run it BEFORE the code deploys: the document stage writes `text_hash` and
 * every invitation read sorts on `stored_at`, so new code against the old
 * schema fails every document job and every checklist read. Run it once more
 * after the deploy, to fill invitations the old code stored in between —
 * until then such a row reads as having no text, and `itemsCurrent` says
 * `false` for a checklist over it.
 */

async function migrate(pg) {
  const addedAt = !(await pg.schema.hasColumn('tender_documents', 'stored_at'));
  if (addedAt) {
    await pg.schema.alterTable('tender_documents', table => {
      table.timestamp('stored_at').notNullable().defaultTo(pg.fn.now());
    });
    await pg.raw(`
      UPDATE tender_documents d SET stored_at = p.fetched_at
      FROM source_payloads p WHERE p.storage_key = d.storage_key
    `);
  }
  const addedHash = !(await pg.schema.hasColumn('tender_documents', 'text_hash'));
  if (addedHash) {
    await pg.schema.alterTable('tender_documents', table => {
      table.string('text_hash');
    });
  }
  return { storedAtAdded: addedAt, textHashAdded: addedHash };
}

async function fillTextHashes(pg) {
  const storage = await getStorage();
  const rows = await pg('tender_documents')
    .where({ kind: 'invitation' })
    .whereNull('text_hash')
    .select('id', 'storage_key');
  const totals = { hashed: 0, noText: 0 };

  for (const row of rows) {
    let text = '';
    try {
      const body = await storage.get(tenderDocTextKeyOf(row.storage_key));
      text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
    } catch {
      // No text object: the checklist cannot read this one either.
    }
    if (!text) {
      totals.noText += 1;
      continue;
    }
    await pg('tender_documents')
      .where({ id: row.id })
      .whereNull('text_hash')
      .update({ text_hash: ChecklistExtractionService.documentHash(text) });
    totals.hashed += 1;
  }
  return totals;
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    const filled = await fillTextHashes(pg);
    console.log('✅ tender_documents.stored_at and text_hash in place:', { ...result, ...filled });
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
