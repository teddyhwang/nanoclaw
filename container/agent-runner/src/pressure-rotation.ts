/**
 * Proactive context-pressure rotation: consolidate-then-rotate BEFORE the
 * provider's auto-compaction fires, instead of compacting mid-turn and
 * discarding the compacted thread at the next day boundary.
 *
 * Why: SDK auto-compaction is the documented failure point of long
 * sessions — it fires mid-turn and the model-blind summary has produced
 * silent turns (Nook 2026-06-07: 135,986-token thread compacted, resumed,
 * emitted only an internal handoff and no channel reply), plan poisoning
 * (Nook 2026-05-27: the compaction summary anchored the agent to a
 * dead-end approach), and hallucinated content (ai-friends 2026-04-16).
 * On top of that, the lazy rotation evaluator throws the compacted thread
 * away at the next cross-day dequeue, so the compaction's work is wasted
 * AND its risks were eaten.
 *
 * The proactive path mirrors the nightly dream protocol's
 * consolidate-then-rotate, scoped down and pressure-triggered:
 *
 *   1. Providers report the live context size (`tokensUsed`, from SDK
 *      usage data) on each `result` event.
 *   2. When a turn ends above the pressure threshold (default 70% of the
 *      auto-compact window), the poll-loop pushes one HANDOFF turn into
 *      the still-warm query: the agent writes a handoff note to its
 *      notes/ + memory — durable kernel files that survive rotation by
 *      design — and replies `<internal>`-only.
 *   3. When the handoff turn's result arrives, the poll-loop itself
 *      clears the continuation state (rotation is deterministic — it does
 *      NOT depend on the agent calling rotate_session) and ends the
 *      query. The next dequeue starts a fresh thread.
 *   4. A rotation notice persisted in session_state is prepended to the
 *      fresh thread's first prompt, pointing it at the handoff note and
 *      `conversations/` archives.
 *
 * The SDK's auto-compaction (165k window) remains as a backstop for the
 * residual case (a single turn that blows through the remaining 30%
 * headroom), along with the PreCompact archive hook and the post-compact
 * silent-turn notice from fork 85a1b63.
 */

/** Lifecycle of the pressure handoff inside one provider query stream. */
export type PressureState = 'idle' | 'handoff-requested' | 'rotated';

/**
 * Default fraction of the provider's auto-compact window at which the
 * proactive handoff fires. 70% leaves enough headroom for the handoff
 * turn itself to run well clear of the SDK's own compaction trigger.
 */
export const DEFAULT_PRESSURE_RATIO = 0.7;

/**
 * Resolve the pressure threshold (tokens) from operator env overrides.
 *
 *   - `PRESSURE_ROTATION_TOKENS`: absolute token threshold. `0` or a
 *     negative value disables proactive rotation entirely.
 *   - `PRESSURE_ROTATION_RATIO`: fraction of `autoCompactWindowTokens`
 *     (clamped to (0, 1]); ignored when the absolute override is set.
 *
 * Returns null when disabled or when the window itself is unusable.
 */
export function resolvePressureThresholdTokens(
  env: Record<string, string | undefined>,
  autoCompactWindowTokens: number,
): number | null {
  const absRaw = env.PRESSURE_ROTATION_TOKENS;
  if (absRaw !== undefined && absRaw.trim() !== '') {
    const abs = Number(absRaw);
    if (!Number.isFinite(abs)) return null;
    return abs > 0 ? Math.floor(abs) : null;
  }
  if (!Number.isFinite(autoCompactWindowTokens) || autoCompactWindowTokens <= 0) {
    return null;
  }
  let ratio = DEFAULT_PRESSURE_RATIO;
  const ratioRaw = env.PRESSURE_ROTATION_RATIO;
  if (ratioRaw !== undefined && ratioRaw.trim() !== '') {
    const parsed = Number(ratioRaw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) ratio = parsed;
  }
  return Math.floor(autoCompactWindowTokens * ratio);
}

/**
 * Decide whether this result event should trigger the handoff push.
 * Pure so the poll-loop's state machine is pinned by unit tests:
 * fires exactly once per query stream, only above threshold, never when
 * the feature is disabled (null threshold — dream runs and providers
 * without usage data).
 */
export function shouldRequestPressureHandoff(
  state: PressureState,
  tokensUsed: number | undefined,
  thresholdTokens: number | null,
): boolean {
  if (thresholdTokens === null) return false;
  if (state !== 'idle') return false;
  if (typeof tokensUsed !== 'number' || !Number.isFinite(tokensUsed)) return false;
  return tokensUsed >= thresholdTokens;
}

/**
 * The handoff prompt pushed into the warm query. The agent's only job is
 * the durable write-down — rotation itself is performed by the poll-loop
 * when this turn's result arrives, so a flubbed instruction can't leave
 * the thread un-rotated.
 */
export function buildPressureHandoffPrompt(tokensUsed: number, thresholdTokens: number): string {
  return (
    `<system>Context-pressure maintenance (internal housekeeping, not a user message): ` +
    `this conversation thread has reached ${tokensUsed.toLocaleString()} context tokens ` +
    `(threshold ${thresholdTokens.toLocaleString()}) and will be ROTATED to a fresh thread ` +
    `after this turn. Before rotation, write a concise handoff so the fresh thread keeps ` +
    `working context:\n` +
    `1. Append a "## Handoff" section to today's note in your notes/ directory (create the ` +
    `file if needed) capturing: conversations and commitments in flight, who asked for what ` +
    `and what is still owed, decisions made on this thread, and any state a fresh thread ` +
    `would need to continue seamlessly.\n` +
    `2. Update your memory files if this thread surfaced durable facts not yet recorded.\n` +
    `3. Do NOT send any channel messages for this maintenance turn — respond with a single ` +
    `<internal> block summarizing what you wrote. Rotation happens automatically after this ` +
    `turn; you do not need to call rotate_session.</system>`
  );
}

/**
 * Notice stored in session_state at rotation time and prepended (wrapped
 * in `<system>`) to the fresh thread's first prompt, so the new thread
 * knows context was rotated and where the handoff lives. Without this the
 * fresh thread's only bridge is passive discoverability of notes/ and
 * conversations/ — the "it compacted and then forgot everything"
 * experience.
 */
export function buildRotationNotice(reason: string): string {
  return (
    `Your previous conversation thread was rotated (${reason}) before this turn. ` +
    `Recent conversational context may be missing. A handoff note may exist in your ` +
    `notes/ directory (look for a "## Handoff" section in the most recent note) and ` +
    `archived transcripts in conversations/. Consult them before answering anything ` +
    `that depends on recent conversation state, and do not mention this housekeeping ` +
    `to users unless asked.`
  );
}
