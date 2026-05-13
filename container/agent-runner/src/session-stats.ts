/**
 * Shape of the per-session disk-state snapshot consumed by `evaluateRotation`.
 *
 * Each provider implements its own reader (`AgentProvider.readSessionStats`)
 * because the on-disk shape is provider-specific: claude writes a single jsonl
 * transcript; codex tracks running token counts in a sqlite file; opencode
 * uses its own XDG dirs; etc. The poll-loop only sees the union shape below
 * and hands it to the pure evaluator.
 *
 * - `compactCount` — number of compact boundaries observed in the transcript.
 *   Claude exposes this via `isCompactSummary: true` markers in the jsonl;
 *   codex doesn't expose a marker, so it back-derives a heuristic count from
 *   `tokens_used`. Even one compact means the conversation has been
 *   summarized — chained summaries are what drives drift.
 * - `sizeBytes` — transcript size on disk. Catches the "about to compact"
 *   regime before the first compact appears.
 * - `tokensUsed` — provider's own running counter, only populated where it's
 *   cheap to read (codex). Undefined for providers that don't track it.
 * - `turnCount` — informational; not used by the rotation decision today.
 */
export interface SessionStats {
  compactCount: number;
  sizeBytes: number;
  turnCount: number;
  /** Only populated when the provider exposes a running token counter. */
  tokensUsed?: number;
}

export const EMPTY_STATS: SessionStats = {
  compactCount: 0,
  sizeBytes: 0,
  turnCount: 0,
};
