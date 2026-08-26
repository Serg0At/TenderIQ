// NPM Modules
import knex from 'knex';
import knexConfigs from '../../src/configs/knex.config.js';

/**
 * Additive migration for delivery channels (phase 2 — the alert hook).
 *
 * Separate from `create_table.js` for the same reason the intelligence indexes
 * are: that script builds the whole schema in one transaction and is not
 * idempotent, so it cannot run against a database that already holds the
 * corpus. Every statement here is `IF NOT EXISTS` and safe to re-run, and the
 * same table is mirrored into `create_table.js` and `drop_table.js` so a fresh
 * database matches.
 *
 * Why a table rather than a column on `organizations`:
 *
 *   - A Telegram bot cannot open a conversation. The chat must be linked by the
 *     user messaging the bot first, which means a subscription has LIFECYCLE —
 *     pending, verified, revoked — and a column has nowhere to put it.
 *   - BR-10 requires per-recipient channel preferences and quiet hours. Those
 *     are properties of "this person on this channel", not of the org.
 *   - One org routinely has several people who each want alerts, and the same
 *     person may link Telegram and email. Both are rows here; neither is a
 *     column anywhere.
 *   - Viber and email land in this table unchanged, which is the point of
 *     `channel` being a value rather than a table name.
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS channel_subscriptions (
     id               varchar(255) PRIMARY KEY,
     organization_id  varchar(255) NOT NULL
                        REFERENCES organizations(id) ON DELETE CASCADE,
     -- Who linked it. SET NULL rather than CASCADE: the org keeps receiving
     -- alerts on a chat after the person who set it up leaves, which is the
     -- behaviour a team expects.
     user_id          varchar(255) REFERENCES users(id) ON DELETE SET NULL,
     channel          varchar(255) NOT NULL,
     -- The channel-specific destination: a Telegram chat id, later an email
     -- address. Null until the link is confirmed, because for Telegram the
     -- address is not knowable until the user messages the bot.
     address          varchar(255),
     -- The one-time secret carried in the t.me deep link.
     link_token       varchar(255),
     token_expires_at timestamptz,
     verified_at      timestamptz,
     -- Set when the user blocks the bot or sends /stop. Kept as a row rather
     -- than deleted so a re-link is an update and the audit trail survives.
     revoked_at       timestamptz,
     -- BR-10. Local wall-clock hours, inclusive start, exclusive end; a window
     -- that wraps midnight (22 -> 8) is normal and handled in the service.
     quiet_hours_start smallint,
     quiet_hours_end   smallint,
     timezone         varchar(255) NOT NULL DEFAULT 'Asia/Yerevan',
     failure_count    integer NOT NULL DEFAULT 0,
     last_error       text,
     created_at       timestamptz NOT NULL DEFAULT now(),
     updated_at       timestamptz NOT NULL DEFAULT now()
   )`,

  /**
   * One live subscription per (org, channel, address).
   *
   * Partial, on confirmed rows only: `address` is NULL while a link is pending,
   * and a NULL never collides in a Postgres unique index — so without the
   * WHERE clause a second pending link would look unique while two confirmed
   * duplicates of the same chat would too. Excluding revoked rows lets a chat
   * be unlinked and linked again later.
   */
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_subscriptions_live_uq
     ON channel_subscriptions (organization_id, channel, address)
     WHERE address IS NOT NULL AND revoked_at IS NULL`,

  // The token lookup is the hot path of the /start handler and arrives from an
  // untrusted source, so it must not be a sequential scan.
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_subscriptions_token_uq
     ON channel_subscriptions (link_token) WHERE link_token IS NOT NULL`,

  // Delivery resolves recipients by (org, channel) on every alert.
  `CREATE INDEX IF NOT EXISTS channel_subscriptions_org_channel_idx
     ON channel_subscriptions (organization_id, channel)`,

  // The inbound-update path resolves a chat id to its subscription so /stop and
  // "bot was blocked" can find the row without knowing the org.
  `CREATE INDEX IF NOT EXISTS channel_subscriptions_channel_address_idx
     ON channel_subscriptions (channel, address)`,

  /**
   * Quiet hours defer a delivery rather than dropping it, so `alert_deliveries`
   * needs somewhere to record that it is waiting and when it will be retried.
   * Without this a deferred alert is indistinguishable from a failed one.
   */
  `ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS deferred_until timestamptz`,
  `ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS detail text`,
];

const run = async () => {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);
  try {
    await pg.transaction(async (trx) => {
      for (const sql of STATEMENTS) {
        await trx.raw(sql);
        console.log(`  ok  ${sql.trim().split('\n')[0].slice(0, 72)}`);
      }
    });
    console.log('channel subscriptions applied');
  } finally {
    await pg.destroy();
  }
};

run().catch((error) => {
  console.error('channel migration failed:', error.message);
  process.exit(1);
});
