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
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
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

/**
 * Authoritative reply-target transport between poll-loop and the
 * out-of-process built-in MCP server.
 *
 * The `nanoclaw` MCP server runs as a SEPARATE stdio subprocess
 * (container/agent-runner/src/index.ts spawns `bun run mcp-tools/index.ts`),
 * so poll-loop's `setCurrentInReplyTo()` module state is invisible to the
 * `send_message` / `send_file` tools — they live in a different process.
 * Historically that gap was bridged by reconstructing the reply target
 * inside the subprocess (`isTaskOnlyTurn()` + a newest-trigger=1 DB
 * fallback in mcp-tools/core.ts). Both halves are unreliable from the
 * subprocess: `isTaskOnlyTurn()` races poll-loop's cross-process
 * `markProcessing`/`markCompleted` on `processing_ack` and fails OPEN
 * when it sees zero processing rows (the normal state when observed from
 * the subprocess mid-turn), and the DB fallback reads a stale long-lived
 * `getInboundDb()` snapshot. The observable failure: a recurring RSS /
 * status task post gets a Discord reply pill threaded onto a stale,
 * hours-old human @mention (2026-05-11, 2026-05-15, 2026-05-18 — the
 * regression kept coming back because every prior fix patched the
 * subprocess-side *guess* rather than removing it).
 *
 * Fix: poll-loop already computes the correct value — `routing.inReplyTo`
 * from `extractRouting` → `pickInReplyToMessage`, which is `null` for
 * task-only / accumulate-only turns and the triggering message id for a
 * user-addressed turn. Publish that authoritative value into
 * `session_state` (outbound.db — container-owned, readable by the stdio
 * subprocess) and have the tools trust it. The reconstruction heuristic
 * is demoted to a backward-compat fallback used only when the key is
 * entirely absent (e.g. an old container mid-rollout).
 *
 * Tri-state is load-bearing and must survive the string round-trip:
 *   - `getCurrentBatchReplyTarget()` → string  : reply to this message id.
 *   - `getCurrentBatchReplyTarget()` → null    : poll-loop authoritatively
 *       says NO reply pill this turn (task / accumulate). Do NOT fall back.
 *   - `getCurrentBatchReplyTarget()` → undefined: no batch published yet
 *       (key absent) — caller may use the legacy heuristic.
 * The sentinel below encodes the authoritative-null case; an empty/missing
 * row reads back as `undefined` (legacy path), never as authoritative-null.
 */
const CURRENT_BATCH_REPLY_KEY = 'current_batch:in_reply_to';
const REPLY_TARGET_NONE = '__no_reply__';

export function setCurrentBatchReplyTarget(id: string | null): void {
  // Empty string would round-trip as a falsy value indistinguishable from
  // "absent"; an id is never empty in practice, but normalize defensively.
  setValue(CURRENT_BATCH_REPLY_KEY, id && id.length > 0 ? id : REPLY_TARGET_NONE);
}

export function clearCurrentBatchReplyTarget(): void {
  deleteValue(CURRENT_BATCH_REPLY_KEY);
}

export function getCurrentBatchReplyTarget(): string | null | undefined {
  const v = getValue(CURRENT_BATCH_REPLY_KEY);
  if (v === undefined || v.length === 0) return undefined; // key absent → legacy path
  if (v === REPLY_TARGET_NONE) return null; // authoritative: no reply pill
  return v;
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
    .prepare("DELETE FROM session_state WHERE key LIKE 'continuation:%' OR key LIKE 'continuation_started_at:%'")
    .run();
  return result.changes;
}

/**
 * One-shot rotation notice for the NEXT fresh thread's first prompt.
 *
 * Written at rotation time (pressure-driven consolidate-then-rotate and the
 * lazy drift/cold-resume rotations in the poll-loop) and consumed exactly
 * once when the poll-loop builds the first prompt of a new thread — so the
 * fresh thread learns that context was rotated and where the handoff note /
 * archived transcripts live, instead of silently knowing nothing.
 *
 * Deliberately a SEPARATE key from the `continuation:%` shapes:
 * `clearAllSessionTrackingState()` must wipe the thread state without
 * destroying the notice that explains the wipe.
 */
const ROTATION_NOTICE_KEY = 'rotation_notice';

export function setRotationNotice(notice: string): void {
  setValue(ROTATION_NOTICE_KEY, notice);
}

/** Read-and-delete: a notice is only ever delivered to one fresh thread. */
export function consumeRotationNotice(): string | undefined {
  const v = getValue(ROTATION_NOTICE_KEY);
  if (v !== undefined) deleteValue(ROTATION_NOTICE_KEY);
  return v;
/**
 * The a2a reply stamp: the id of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it and stamp it onto outbound
 * rows so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This lives in outbound.db rather than module state because the MCP server
 * runs as a separate stdio subprocess from the poll loop — module state set
 * by the poll loop is invisible to it. Both processes open outbound.db
 * (journal_mode=DELETE + busy_timeout make intra-container access safe).
 */
const IN_REPLY_TO_KEY = 'current_in_reply_to';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const IN_REPLY_TO_MAX_AGE_MS = 30 * 60 * 1000;

export function setCurrentInReplyTo(id: string | null): void {
  if (id === null) {
    clearCurrentInReplyTo();
    return;
  }
  setValue(IN_REPLY_TO_KEY, id);
}

export function clearCurrentInReplyTo(): void {
  deleteValue(IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  const row = getOutboundDb()
    .prepare('SELECT value, updated_at FROM session_state WHERE key = ?')
    .get(IN_REPLY_TO_KEY) as { value: string; updated_at: string } | undefined;
  if (!row) return null;
  const age = Date.now() - new Date(row.updated_at).getTime();
  if (!Number.isFinite(age) || age > IN_REPLY_TO_MAX_AGE_MS) return null;
  return row.value;
}
