/**
 * Optimus fork patch — adds two columns to `container_configs` that Optimus
 * uses but upstream does not. Kept as a fork-local migration to keep the
 * upstream-merge diff small.
 *
 * `suppress_embeds` — when 1, agents emit Discord messages with the
 * SUPPRESS_EMBEDS flag set so link previews/unfurls don't clutter replies.
 * Default 1 for new rows (operators flip individual groups to 0 when they
 * actually want previews). Adapters whose platform has no embed concept
 * (WhatsApp, Telegram) ignore it.
 *
 * `assistant_prefix_separator` — separator placed between the assistant name
 * and the message body in shared-number channel adapters (WhatsApp). NULL
 * means use the legacy default `": "`. Set to `" "` for emoji-only marks
 * (`🤖 text`) or `""` to drop entirely.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'optimus-container-config-fields',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN suppress_embeds INTEGER NOT NULL DEFAULT 1').run();
    db.prepare('ALTER TABLE container_configs ADD COLUMN assistant_prefix_separator TEXT').run();
  },
};
