import type { DbDriver } from '../driver.js';
import type { Migration } from './index.js';

/**
 * Persist the "Create new agent" name prompt (`pending_name_inputs`).
 *
 * After the approver clicks "new agent" on a channel-registration card, the
 * next DM they send in that channel is captured as the agent name. That state
 * used to live in process memory and was lost on restart, so a reply after a
 * restart was routed as ordinary chat. One row per approver (a second click
 * replaces it); the row belongs to its pending channel approval and is
 * cascade-deleted with it.
 *
 * Additive only: a new table, no change to existing tables. Roll back with
 * `rollbackMigration026` (drops the table and its schema_version row); the
 * only loss is any name prompt open at rollback time.
 */
export const migration026: Migration = {
  version: 26,
  name: 'pending-name-inputs',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS pending_name_inputs (
        approver_user_id    TEXT PRIMARY KEY,
        messaging_group_id  TEXT NOT NULL
                            REFERENCES pending_channel_approvals(messaging_group_id) ON DELETE CASCADE,
        dm_channel_type     TEXT NOT NULL,
        dm_platform_id      TEXT NOT NULL,
        dm_instance         TEXT NOT NULL,
        created_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_name_inputs_mg ON pending_name_inputs(messaging_group_id);
    `);
  },
};

/** Down migration for 026. Not run automatically; for manual rollback. */
export async function rollbackMigration026(db: DbDriver): Promise<void> {
  await db.exec(`
    DROP INDEX IF EXISTS idx_pending_name_inputs_mg;
    DROP TABLE IF EXISTS pending_name_inputs;
  `);
  await db.run('DELETE FROM schema_version WHERE name = ?', migration026.name);
}
