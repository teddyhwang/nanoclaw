/**
 * Lazy session rotation: decide whether to clear the provider continuation
 * before the next turn so a chained-compaction session doesn't keep drifting.
 *
 * Long-lived sessions chain auto-compactions, and compactions drift. v1 hit
 * this at ~4 days / 2+ compacts / 7.6 MB (discord_ai_friends 2026-04-16:
 * post-compact summary hallucinated a screenshot that was never in the turn).
 * v2's daily dream pass at 04:00 covers the common case, but a single very
 * chatty day can compact multiple times before 04:00 arrives. This evaluator
 * is the missing drift trigger.
 *
 * It runs in the poll-loop right before `provider.query()` — never mid-flight
 * — so the rotation only takes effect on the NEXT turn relative to the
 * current dequeue. The current turn keeps its in-memory continuation; the
 * cleared row on disk is what the next cold dequeue picks up.
 *
 * The "day" boundary is 04:00 in TIMEZONE so rotations land on a session
 * that already has fresh knowledge files seeded by the 04:00 Dream task.
 */
import type { SessionStats } from './session-stats.js';

const ROTATION_HOUR = 4;

/**
 * Rotate when the on-disk transcript crosses this byte threshold even before
 * the first compact boundary appears. The v1 ai-friends incident failed at
 * 7.6 MB / 2+ compacts; 2 MB is a comfortable margin before the first compact
 * typically fires.
 */
export const SIZE_ROTATION_THRESHOLD_BYTES = 2 * 1024 * 1024;

/**
 * Token-counter threshold for providers that lack a clean compact-boundary
 * marker (codex). Rotate preemptively as the counter approaches the model's
 * usable context window.
 */
export const TOKENS_ROTATION_THRESHOLD = 100_000;

/**
 * Calendar date shifted back by ROTATION_HOUR so a timestamp between 00:00
 * and 04:00 local still counts as the previous rotation day. Returns
 * `YYYY-MM-DD` in `en-CA`.
 */
export function computeRotationDate(now: Date, tz: string): string {
  const shifted = new Date(now.getTime() - ROTATION_HOUR * 60 * 60 * 1000);
  return shifted.toLocaleDateString('en-CA', { timeZone: tz });
}

export type RotationReason =
  | 'no-session'
  | 'same-day'
  | 'quiet-session'
  | 'cross-day-stale'
  | 'compacted'
  | 'size-threshold'
  | 'tokens-threshold';

export interface RotationDecision {
  rotate: boolean;
  reason: RotationReason;
}

/**
 * Decide whether to rotate. Same-day sessions are preserved — mid-chat
 * rotation destroys conversation continuity, and a single compact inside a
 * single day has not yet chained into drift. Strong disk signals
 * (compactCount, sizeBytes, tokensUsed) rotate even when `startedAt` is
 * missing — an unstamped row with disk evidence is a pre-fix artifact, not
 * a genuine "no session" state.
 *
 * A stamped session whose `startedAt` precedes the current rotation day MUST
 * rotate even with no readable disk evidence (`cross-day-stale`). The
 * transcript `.jsonl` is read from inside the container at a path that is
 * frequently absent/unreadable there, so `readClaudeSessionStats` returns
 * EMPTY_STATS and the compact/size/token guards never fire. Before this case
 * existed, such a session fell through to `quiet-session` → rotate:false and
 * NEVER rotated: the day boundary at the top only *prevents same-day*
 * rotation, it doesn't *force cross-day* rotation. That stranded the
 * Degenerates Claude continuation on a single thread from 2026-05-30 onward
 * (`continuation_started_at:claude` frozen, re-stamped continuation), so every
 * 04:00 dream landed on an over-grown thread and returned an empty turn —
 * which meant the dream's own step-6 `rotate_session` never ran, a
 * self-reinforcing loop. `startedAt` being from a prior rotation day is itself
 * sufficient evidence the thread has lived ≥1 full day across the dream
 * boundary; that is exactly when we want a clean thread seeded by the fresh
 * 04:00 knowledge files. Only sessions that already passed the same-day guard
 * reach here, so this can never rotate a live same-day conversation.
 */
export function evaluateRotation(
  now: Date,
  tz: string,
  startedAt: string | undefined,
  stats: SessionStats,
): RotationDecision {
  if (startedAt && computeRotationDate(now, tz) === startedAt) {
    return { rotate: false, reason: 'same-day' };
  }
  if (stats.compactCount >= 1) {
    return { rotate: true, reason: 'compacted' };
  }
  if (stats.sizeBytes > SIZE_ROTATION_THRESHOLD_BYTES) {
    return { rotate: true, reason: 'size-threshold' };
  }
  if (typeof stats.tokensUsed === 'number' && stats.tokensUsed > TOKENS_ROTATION_THRESHOLD) {
    return { rotate: true, reason: 'tokens-threshold' };
  }
  if (!startedAt) return { rotate: false, reason: 'no-session' };
  // Stamped + not same-day (the same-day guard above already returned) ⇒ the
  // thread has crossed at least one rotation boundary. Rotate even without
  // disk evidence — empty in-container stats must not strand a cross-day
  // thread on the same continuation indefinitely.
  return { rotate: true, reason: 'cross-day-stale' };
}
