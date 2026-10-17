import type { DbDriver } from '../driver.js';
import type { Migration } from './index.js';

/**
 * Remember inbound messages a host prompt consumed (`consumed_inbound_messages`).
 *
 * A reply captured by a host prompt (the new-agent name step, a
 * reject-with-reason reply) never reaches a session's inbound.db, so the
 * session-level (session_id, message_id) dedup that startup/reconnect channel
 * recovery relies on cannot see it. After a restart, recovery re-fetched such
 * a reply and, its prompt already gone, routed it to the DM's agent as
 * ordinary chat. The router skips any message recorded here.
 *
 * Keyed by receiving instance, platform id and platform message id — the same
 * identity a live event and its recovered copy share. Rows are pruned after
 * CONSUMED_INBOUND_RETENTION_MS, far beyond the recovery lookback.
 *
 * Additive only: a new table, no change to existing tables. Roll back with
 * `rollbackMigration027`; the only loss is the skip-list itself.
 */
export const migration027: Migration = {
  version: 27,
  name: 'consumed-inbound-messages',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS consumed_inbound_messages (
        instance     TEXT NOT NULL,
        platform_id  TEXT NOT NULL,
        message_id   TEXT NOT NULL,
        consumed_by  TEXT NOT NULL,
        consumed_at  TEXT NOT NULL,
        PRIMARY KEY (instance, platform_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_consumed_inbound_messages_at ON consumed_inbound_messages(consumed_at);
    `);
  },
};

/** Down migration for 027. Not run automatically; for manual rollback. */
export async function rollbackMigration027(db: DbDriver): Promise<void> {
  await db.exec(`
    DROP INDEX IF EXISTS idx_consumed_inbound_messages_at;
    DROP TABLE IF EXISTS consumed_inbound_messages;
  `);
  await db.run('DELETE FROM schema_version WHERE name = ?', migration027.name);
}
