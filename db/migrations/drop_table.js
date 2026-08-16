// NPM Modules
import knex from 'knex';
import knexConfigs from '../../src/configs/knex.config.js';

async function down(pg) {
  // Drop dependents before the tables they reference.
  const tables = [
    'audit_logs',
    'invoices',
    'subscriptions',
    'plans',
    'alert_deliveries',
    'notifications',
    'supplier_profiles',
    'buyer_profiles',
    'price_benchmarks',
    'saved_searches',
    'vault_documents',
    'tasks',
    'checklist_items',
    'checklists',
    'bids',
    'tracked_tenders',
    'memberships',
    'roles',
    'organizations',
    'source_payloads',
    'tender_documents',
    'contracts',
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
