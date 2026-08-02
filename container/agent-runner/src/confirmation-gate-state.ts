/**
 * Per-turn record of whether a sensitive-action confirmation gate paused a
 * tool call during this turn.
 *
 * ## Why this exists
 *
 * When the gate holds a call it returns a NON-error tool result whose text
 * says the call "is awaiting the user's confirmation … End your turn now
 * without commentary". A compliant agent then ends the turn with zero
 * `<message>` blocks — which the addressed-silent safety net in
 * `dispatchResultText` would otherwise report to the channel as
 * "I couldn't complete that request or produce a reliable reply."
 *
 * That guard originally sniffed the *model's own prose* for the gate's
 * language. That is structurally unsound: the gate instruction explicitly
 * orders the model to end "without commentary", so the better the model
 * complies the less prose there is to match — and any paraphrase misses.
 * It failed live in Boys Night on 2026-08-01: the model wrote
 * "Waiting on the calendarList confirmation prompt." and all four patterns
 * missed by a word ("waiting **on**", not "waiting for") or by a sentence
 * boundary (`[^.]*` cannot cross the period after "prompt"). The channel
 * got a false failure while the calendar event was created correctly
 * seconds later. `notes/2026-05-19.md` had already recorded that
 * model-text detection is unreliable — codex paraphrases the same result.
 *
 * The fix is to test the **tool result** rather than the model's retelling.
 * The tool result is emitted verbatim by the gate, so the existing
 * `isAwaitingSensitiveConfirmation` predicate matches it reliably.
 *
 * ## Lifecycle
 *
 * Set from the provider's PostToolUse hook; read by `dispatchResultText`;
 * **reset at the start of every turn**. The reset is load-bearing — a
 * sticky flag would suppress the safety net for genuinely broken turns
 * later in the same container's life, which is the exact failure mode the
 * safety net exists to catch.
 */

/**
 * True when `text` carries the sensitive-gate's pending-confirmation
 * language. Lives here (not in poll-loop) so the provider's PostToolUse
 * hook can use it without importing poll-loop, which would be circular.
 * Re-exported from poll-loop for existing callers.
 *
 * Applied to a TOOL RESULT this is reliable — the gate emits the text
 * verbatim. Applied to model prose it is a lossy heuristic, kept only as
 * a fallback for providers whose tool results the runner cannot observe
 * (codex talks to MCP via its own in-process client — `notes/2026-05-19.md`).
 */
export function isAwaitingSensitiveConfirmation(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /awaiting (the )?(user'?s?|your) confirmation/.test(t) ||
    /a (confirm|approval) prompt (is|has been) (shown|posted)/.test(t) ||
    // "waiting for/on <x> confirmation". Sentence-bounded so an unrelated
    // later sentence can't satisfy it.
    /\bwaiting (for|on)\b[^.]*\bconfirm(ation)?\b/.test(t) ||
    // "confirmation prompt/card" + a pending-ish qualifier ANYWHERE, or the
    // bare phrase at a sentence end (2026-08-01: "Waiting on the
    // calendarList confirmation prompt." — the qualifier never arrives
    // because the sentence stops).
    /\bconfirm(ation)? (prompt|card)\b/.test(t) ||
    /\bend(ing)? (my |the )?turn\b[^.]*\bwithout commentary\b/.test(t)
  );
}

let sawPendingConfirmation = false;

/** Clear the flag. MUST be called at the start of every turn. */
export function resetConfirmationGateState(): void {
  sawPendingConfirmation = false;
}

/**
 * Record a tool result observed during this turn. Marks the turn as
 * gate-paused when the result carries the gate's pending-confirmation
 * language. `match` is injected so this module stays free of a circular
 * import back into poll-loop.
 */
export function noteToolResult(text: string, match: (t: string) => boolean): void {
  if (!text) return;
  if (match(text)) sawPendingConfirmation = true;
}

/** True when a confirmation gate paused a tool call during this turn. */
export function confirmationGatePaused(): boolean {
  return sawPendingConfirmation;
}
