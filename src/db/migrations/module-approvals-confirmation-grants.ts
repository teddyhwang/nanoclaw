import type { Migration } from './index.js';

/**
 * `confirmation_grants` table — session-scoped "don't keep asking" grants
 * for the sensitive-action confirmation gate (Phase 1 of the
 * sensitive-action-approvals design).
 *
 * When an actor confirms a sensitive MCP action, a grant is recorded so
 * subsequent sensitive actions by the SAME actor in the SAME session pass
 * silently until the grant expires (30-min hard cap; optional idle layer
 * default-disabled) or the session is cleared.
 *
 * Keyed `(session_id, actor_id)` — NOT session alone. A `sessions` row in
 * `shared`/`agent-shared` mode is shared across messages from different
 * people in the same chat; keying on the session alone would let member
 * A's confirmation silently suppress prompts for member B's sensitive
 * actions (a cross-user privilege leak). Per (session, actor) a distinct
 * actor in the same shared session still gets their own first prompt.
 *
 * `granted_at`  — set on the confirming click (and refreshed on re-confirm
 *                 after expiry); the 30-min hard cap is measured from here.
 * `last_used_at`— bumped on every silent live-grant allow. Kept current
 *                 even though the default policy only reads `granted_at`,
 *                 so the optional idle-TTL layer can be enabled later with
 *                 no schema change or backfill.
 *
 * Grants are deleted when the owning session is cleared/reset (engine-
 * authoritative cascade — see deleteConfirmationGrantsForSession), which
 * is the natural "duration of the session" boundary, further bounded by
 * the hard cap.
 */
export const moduleApprovalsConfirmationGrants: Migration = {
  version: 8,
  name: 'confirmation-grants',
  async up(db) {
    await db.exec(`
      CREATE TABLE confirmation_grants (
        session_id   TEXT NOT NULL REFERENCES sessions(id),
        actor_id     TEXT NOT NULL,
        granted_at   TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (session_id, actor_id)
      );

      CREATE INDEX idx_confirmation_grants_session
        ON confirmation_grants(session_id);
    `);
  },
};
