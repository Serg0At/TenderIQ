// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

async function down(pg) {
  // Drop dependents before the tables they reference.
  const tables = [
    'audit_logs',
    'invoices',
    'subscriptions',
    'plans',
    'channel_subscriptions',
    'alert_deliveries',
    'notifications',
    'supplier_profiles',
    'buyer_profiles',
    'price_benchmarks',
    'saved_searches',
    'checklist_items',
    'checklists',
    'bids',
    'tracked_tenders',
    // After checklist_items, not before: checklist_items carries the composite FK
    // (vault_document_id, organization_id) into this table, so dropping it earlier
    // aborts the whole transaction and migrate:down can never complete.
    'vault_documents',
    'memberships',
    'role_permissions',
    'permissions',
    'roles',
    'organizations',
    'source_payloads',
    'tender_documents',
    'contracts',
    'tender_lots',
    'public_tender_bids',
    'awards',
    'tenders',
    'users',
    'parties',
  ];

  for (const table of tables) {
    await pg.schema.dropTableIfExists(table);
  }
}

async function init() {
  try {
    const options =
      process.env.NODE_ENV === 'production'
        ? knexConfigs.production
        : knexConfigs.development;

    const pg = knex(options);

    await pg.transaction(async trx => {
      await down(trx);
    });

    console.log('✅ Successfully dropped all tables in transaction');
    process.exit(0);
  } catch (error) {
    console.error('❌ Rollback failed:', error.message);
    process.exit(1);
  }
}

init();
