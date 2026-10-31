// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

async function down(pg) {
  // Drop dependents before the tables they reference.
  const tables = [
    'audit_logs',
    'invoices',
    'subscriptions',
    'promo_codes',
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
    'vault_documents',
    'invitations',
    'supplier_identities',
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
    'unmatched_results',
    'listing_notices',
    'tender_sources',
    'tenders',
    'users',
    'party_aliases',
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
