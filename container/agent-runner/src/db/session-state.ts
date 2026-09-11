/**
 * Persistent key/value state owned by the registered mailbox.
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getAgentMailbox } from '../mailbox/index.js';

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
  return getAgentMailbox().operations.getState(key)?.value;
}

function setValue(key: string, value: string): void {
  getAgentMailbox().operations.setState(key, value);
}

function deleteValue(key: string): void {
  getAgentMailbox().operations.deleteState(key);
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
  return getAgentMailbox().operations.deleteStateByPrefixes(['continuation:', 'continuation_started_at:']);
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

/** Read-and-delete atomically: a notice is only delivered to one fresh thread. */
export function consumeRotationNotice(): string | undefined {
  return getAgentMailbox().operations.consumeState(ROTATION_NOTICE_KEY)?.value;
}

/**
 * Where the message being answered came from, plus its id for the a2a return
 * path. Null routing fields mean the batch has no channel (a task run).
 */
export interface ReplyRoute {
  inReplyTo: string;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

/**
 * The reply stamp: the route of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it to thread a reply into the
 * conversation being answered and to stamp `in_reply_to` onto outbound rows so
 * the host's a2a return-path routing can correlate replies back to the
 * originating session.
 *
 * This lives in mailbox state because the MCP server runs as a separate stdio
 * subprocess; module state set by the poll loop is invisible to it.
 *
 * No age limit: the tools only run inside a query, and every query publishes
 * (or clears) the stamp before it starts, so a stamp is never older than the
 * turn it belongs to. A container killed mid-batch (SIGKILL) skips the
 * clearing finally, so the poll loop clears any leftover at startup instead.
 */
const REPLY_ROUTE_KEY = 'current_reply_route';

export function setCurrentReplyRoute(route: ReplyRoute | null): void {
  if (route === null) {
    clearCurrentReplyRoute();
    return;
  }
  const { inReplyTo, channelType, platformId, threadId } = route;
  setValue(REPLY_ROUTE_KEY, JSON.stringify({ inReplyTo, channelType, platformId, threadId }));
}

export function clearCurrentReplyRoute(): void {
  deleteValue(REPLY_ROUTE_KEY);
}

export function getCurrentReplyRoute(): ReplyRoute | null {
  const row = getAgentMailbox().operations.getState(REPLY_ROUTE_KEY);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<ReplyRoute>;
    if (typeof parsed.inReplyTo !== 'string') return null;
    return {
      inReplyTo: parsed.inReplyTo,
      channelType: parsed.channelType ?? null,
      platformId: parsed.platformId ?? null,
      threadId: parsed.threadId ?? null,
    };
  } catch {
    return null;
  }
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo ?? getCurrentReplyRoute()?.inReplyTo ?? null;
}

// Compatibility for older plugins; persisted routes remain the cross-process transport.
let currentInReplyTo: string | null = null;
export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}
export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
}
