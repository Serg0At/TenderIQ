// NPM Modules
import knex from 'knex';
import knexConfigs from '../../src/configs/knex.config.js';

function up(pg) {
  return pg.schema
    // Parties must exist before tenders and awards reference them.
    .createTable('parties', table => {
      table.string('id').primary();
      table.string('name').notNullable();
      table.string('tax_id');
      table.string('role').notNullable(); // buyer | supplier | both
      table.string('region');
    })

    // Tenders
    .createTable('tenders', table => {
      table.string('id').primary();
      table.string('source_id').notNullable().unique();
      table.string('title').notNullable();
      table.string('description');
      table.string('buyer_id').notNullable().references('id').inTable('parties').onDelete('CASCADE');
      table.string('cpv_code');
      table.string('procedure_type').notNullable();
      table.string('status').notNullable();
      table.decimal('estimated_value', 18, 2);
      table.string('currency').notNullable().defaultTo('AMD');
      table.timestamp('published_at');
      table.timestamp('deadline_at');
      table.timestamp('qna_deadline_at');
      table.integer('version').notNullable().defaultTo(1);
      table.boolean('is_latest').notNullable().defaultTo(true);
    })

    // Awards
    .createTable('awards', table => {
      table.string('id').primary();
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      table.string('supplier_id').references('id').inTable('parties').onDelete('SET NULL');
      table.decimal('amount', 18, 2);
      table.string('currency').notNullable().defaultTo('AMD');
      table.timestamp('awarded_at');
      table.string('status').notNullable();
    })

    // Contracts
    .createTable('contracts', table => {
      table.string('id').primary();
      table.string('award_id').notNullable().references('id').inTable('awards').onDelete('CASCADE');
      table.decimal('value', 18, 2);
      table.timestamp('signed_at');
      table.string('status').notNullable();
    })

    // Tender documents
    .createTable('tender_documents', table => {
      table.string('id').primary();
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      table.string('url').notNullable();
      table.string('storage_key').notNullable();
      table.string('kind').notNullable();
      table.boolean('parsed').notNullable().defaultTo(false);
    })

    // Source payloads
    .createTable('source_payloads', table => {
      table.string('id').primary();
      table.string('source').notNullable();
      table.string('ref').notNullable();
      table.string('storage_key').notNullable();
      table.string('hash').notNullable();
      table.timestamp('fetched_at').notNullable();
      table.unique(['source', 'ref', 'hash'], {
        indexName: 'source_payloads_source_ref_hash_uq',
      });
    })

    // Users, organizations, roles, and memberships
    .createTable('users', table => {
      table.string('id').primary();
      table.string('email').notNullable().unique();
      table.string('password_hash').notNullable();
      table.string('locale').notNullable().defaultTo('hy');
    })
    .createTable('organizations', table => {
      table.string('id').primary();
      table.string('name').notNullable();
      table.string('type'); // IT, construction, medical...
      table.string('created_by').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    })
    .createTable('roles', table => {
      table.string('id').primary();
      table.string('name').notNullable().unique();
      table.specificType('permissions', 'text[]').notNullable().defaultTo('{}');
    })
    .createTable('memberships', table => {
      table.string('id').primary();
      table.string('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('role_id').notNullable().references('id').inTable('roles').onDelete('RESTRICT');
      table.unique(['user_id', 'organization_id']);
    })

    // Tracked tenders
    .createTable('tracked_tenders', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      table.string('status').notNullable();
      table.string('go_no_go');
      table.text('decision_note');
      table.timestamp('created_at').defaultTo(pg.fn.now());
      table.timestamp('updated_at').defaultTo(pg.fn.now());
      table.unique(['organization_id', 'tender_id']);
    })

    // Bids
    .createTable('bids', table => {
      table.string('id').primary();
      table.string('tracked_tender_id').notNullable().unique().references('id').inTable('tracked_tenders').onDelete('CASCADE');
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.decimal('price', 18, 2);
      table.timestamp('submitted_at');
      table.boolean('locked').notNullable().defaultTo(false);
      table.timestamp('created_at').defaultTo(pg.fn.now());
      table.timestamp('updated_at').defaultTo(pg.fn.now());
    })

    // Checklists and checklist items
    .createTable('checklists', table => {
      table.string('id').primary();
      table.string('tracked_tender_id').notNullable().unique().references('id').inTable('tracked_tenders').onDelete('CASCADE');
      table.timestamp('created_at').defaultTo(pg.fn.now());
    })
    .createTable('checklist_items', table => {
      table.string('id').primary();
      table.string('checklist_id').notNullable().references('id').inTable('checklists').onDelete('CASCADE');
      table.string('label').notNullable();
      table.boolean('required').notNullable().defaultTo(true);
      table.float('confidence');
      table.boolean('done').notNullable().defaultTo(false);
      table.timestamp('created_at').defaultTo(pg.fn.now());
    })

    // Tasks
    .createTable('tasks', table => {
      table.string('id').primary();
      table.string('tracked_tender_id').notNullable().references('id').inTable('tracked_tenders').onDelete('CASCADE');
      table.string('assignee_user_id').references('id').inTable('users').onDelete('SET NULL');
      table.string('title').notNullable();
      table.timestamp('due_at');
      table.string('status').notNullable().defaultTo('open');
      table.timestamp('created_at').defaultTo(pg.fn.now());
      table.timestamp('updated_at').defaultTo(pg.fn.now());
    })

    // Vault documents
    .createTable('vault_documents', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('kind').notNullable();
      table.string('storage_key').notNullable();
      table.timestamp('valid_until');
      table.string('hash').notNullable();
      table.timestamp('created_at').defaultTo(pg.fn.now());
    })

    // Saved searches
    .createTable('saved_searches', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.specificType('cpv_codes', 'text[]').notNullable().defaultTo('{}');
      table.specificType('keywords', 'text[]').notNullable().defaultTo('{}');
      table.specificType('regions', 'text[]').notNullable().defaultTo('{}');
      table.decimal('min_value', 18, 2);
      table.decimal('max_value', 18, 2);
      table.specificType('channels', 'text[]').notNullable().defaultTo('{}');
      table.timestamp('created_at').defaultTo(pg.fn.now());
      table.timestamp('updated_at').defaultTo(pg.fn.now());
    })

    // Pricing and party analytics
    .createTable('price_benchmarks', table => {
      // CUIDs are generated by the application, as with the existing tables.
      table.string('id').primary();
      table.string('cpv_code').notNullable();
      table.string('buyer_id').references('id').inTable('parties').onDelete('SET NULL');
      table.integer('sample_size').notNullable();
      table.decimal('min_price', 18, 2);
      table.decimal('median_price', 18, 2);
      table.decimal('max_price', 18, 2);
      table.float('avg_discount_pct');
      table.timestamp('computed_at').notNullable();
    })
    .createTable('buyer_profiles', table => {
      table.string('id').primary();
      table.string('buyer_id').notNullable().unique().references('id').inTable('parties').onDelete('CASCADE');
      table.decimal('total_spend', 18, 2);
      table.integer('tender_count').notNullable();
      table.specificType('favored_supplier_ids', 'text[]').notNullable();
    })
    .createTable('supplier_profiles', table => {
      table.string('id').primary();
      table.string('supplier_id').notNullable().unique().references('id').inTable('parties').onDelete('CASCADE');
      table.float('win_rate');
      table.specificType('categories', 'text[]').notNullable();
      table.float('avg_discount_pct');
    })

    // Notifications and alert delivery history
    .createTable('notifications', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('user_id').references('id').inTable('users').onDelete('SET NULL');
      table.string('type').notNullable(); // tender-match, amendment, reminder, expiry
      table.string('tender_id').references('id').inTable('tenders').onDelete('SET NULL');
      table.jsonb('payload').notNullable();
      table.timestamp('read_at');
    })
    .createTable('alert_deliveries', table => {
      table.string('id').primary();
      table.string('notification_id').notNullable().references('id').inTable('notifications').onDelete('CASCADE');
      table.string('channel').notNullable();
      table.string('status').notNullable();
      table.timestamp('sent_at');
    })

    // Billing
    .createTable('plans', table => {
      table.string('id').primary();
      table.string('name').notNullable();
      table.decimal('price_usd', 18, 2).notNullable();
      table.specificType('features', 'text[]').notNullable();
    })
    .createTable('subscriptions', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().unique().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('plan_id').notNullable().references('id').inTable('plans').onDelete('RESTRICT');
      table.string('status').notNullable();
      table.timestamp('renews_at');
    })
    .createTable('invoices', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.decimal('amount', 18, 2).notNullable();
      table.string('status').notNullable();
      table.timestamp('issued_at').notNullable();
    })

    // Audit trail
    .createTable('audit_logs', table => {
      table.string('id').primary();
      table.string('organization_id').references('id').inTable('organizations').onDelete('SET NULL');
      table.string('actor_user_id').references('id').inTable('users').onDelete('SET NULL');
      table.string('action').notNullable();
      table.string('entity').notNullable();
      table.string('entity_id');
      table.jsonb('metadata').notNullable();
      table.timestamp('at').notNullable().defaultTo(pg.fn.now());
    });
}

async function init() {
  try {
    const options =
      process.env.NODE_ENV === 'production'
        ? knexConfigs.production
        : knexConfigs.development;

    const pg = knex(options);

    await pg.transaction(async trx => {
      await up(trx);
    });

    console.log('✅ Successfully created all tables in transaction');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

init();
