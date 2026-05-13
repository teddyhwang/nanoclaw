/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

/**
 * Calendar date (`YYYY-MM-DD`) the provider's current continuation was first
 * adopted. Used by the lazy rotation evaluator to detect a day-boundary
 * crossing. Written next to `continuation:<provider>` and wiped in lockstep.
 */
function continuationStartedAtKey(providerName: string): string {
  return `continuation_started_at:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

export function getContinuationStartedAt(providerName: string): string | undefined {
  return getValue(continuationStartedAtKey(providerName));
}

export function setContinuationStartedAt(providerName: string, date: string): void {
  setValue(continuationStartedAtKey(providerName), date);
}

export function clearContinuationStartedAt(providerName: string): void {
  deleteValue(continuationStartedAtKey(providerName));
}

/**
 * Wipe every provider's continuation row AND its `started_at` stamp in one
 * shot. Two reasons this is a single function rather than two:
 *
 *   - Lockstep — a continuation without its `started_at` stamp would look
 *     pre-fix to the rotation evaluator (no-session branch) and stay
 *     un-rotatable on disk-quiet days. A `started_at` without its
 *     continuation is harmless but pointless.
 *   - Surface — the `rotate_session` MCP tool is the agent-visible API for
 *     "reset this session's drift state." It needs to clear both shapes;
 *     forcing the tool to call two functions invites a future caller to
 *     forget one.
 *
 * Used by the `rotate_session` MCP tool and by the lazy rotation hook in
 * the poll-loop. Returns the number of rows deleted (sum of both shapes).
 */
export function clearAllSessionTrackingState(): number {
  const result = getOutboundDb()
    .prepare(
      "DELETE FROM session_state WHERE key LIKE 'continuation:%' OR key LIKE 'continuation_started_at:%'",
    )
    .run();
  return result.changes;
}
