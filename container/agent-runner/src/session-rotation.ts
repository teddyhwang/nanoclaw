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
  if (
    typeof stats.tokensUsed === 'number' &&
    stats.tokensUsed > TOKENS_ROTATION_THRESHOLD
  ) {
    return { rotate: true, reason: 'tokens-threshold' };
  }
  if (!startedAt) return { rotate: false, reason: 'no-session' };
  return { rotate: false, reason: 'quiet-session' };
}
