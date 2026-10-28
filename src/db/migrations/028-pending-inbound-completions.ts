import type { DbDriver } from '../driver.js';
import type { Migration } from './index.js';

/**
 * Inbound completions the host owes a session (`pending_inbound_completions`).
 *
 * A host Stop must mark the stopped inputs completed in the session's
 * inbound.db, which a runner can hold locked. When that write cannot land,
 * the inputs would stay pending and the next runner (which clears its own
 * claims on start) would run them again. The host records the debt here
 * first — the central DB no container can lock — and settles it before any
 * spawn and at the start of every sweep pass; the record is cleared only
 * once the mailbox write has landed.
 *
 * Additive only: a new table. Roll back with `rollbackMigration028`; the only
 * loss is any unsettled debt.
 */
export const migration028: Migration = {
  version: 28,
  name: 'pending-inbound-completions',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS pending_inbound_completions (
        session_id   TEXT NOT NULL,
        message_id   TEXT NOT NULL,
        reason       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
    `);
  },
};

/** Down migration for 028. Not run automatically; for manual rollback. */
export async function rollbackMigration028(db: DbDriver): Promise<void> {
  await db.exec('DROP TABLE IF EXISTS pending_inbound_completions;');
  await db.run('DELETE FROM schema_version WHERE name = ?', migration028.name);
}
