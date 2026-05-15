/**
 * Regression tests for the typing-suppression decision (Optimus fork
 * patch). Bug, raised 3×: the agent answers a user message, then a
 * *deferred maintenance/recurring task* runs as a separate ~24s turn
 * emitting only `<internal>`. The typing refresher (started for the
 * user turn) stays alive on heartbeat freshness; the silent task turn
 * produces no outbound so the pre-delivery skip doesn't apply, and
 * S290's `silent_turn_complete` only stops typing *after* the turn —
 * so the user sees "Optimus is typing…" for the whole silent turn
 * with no message coming. `decideSuppressTypingForNonUserTurn` is the
 * gate that suppresses typing *during* a task/system-only turn.
 *
 * Pure-helper tests (same approach as host-sweep's decideStuckAction)
 * so the rule is pinned without real session-DB files.
 */
import { describe, expect, it } from 'vitest';

import { decideSuppressTypingForNonUserTurn } from './index.js';

describe('decideSuppressTypingForNonUserTurn', () => {
  it('does NOT suppress when nothing is processing (idle / grace logic owns it)', () => {
    // No active turn — typing decision belongs to the grace/heartbeat
    // path, not this gate. Must fail open so we never wrongly hide a
    // legitimate indicator.
    expect(decideSuppressTypingForNonUserTurn(0, false)).toBe(false);
    expect(decideSuppressTypingForNonUserTurn(0, true)).toBe(false);
  });

  it('SUPPRESSES when an active turn is processing only task/system rows', () => {
    // The screenshot case: a deferred maintenance task is the only
    // thing in flight, no user-conversation row → silent turn → hide
    // "is typing…".
    expect(decideSuppressTypingForNonUserTurn(1, false)).toBe(true);
    expect(decideSuppressTypingForNonUserTurn(5, false)).toBe(true);
  });

  it('does NOT suppress when a user-conversation row is in flight', () => {
    // A real user turn (chat / chat-sdk) is being processed — typing
    // is correct and expected; never suppress it.
    expect(decideSuppressTypingForNonUserTurn(1, true)).toBe(false);
    expect(decideSuppressTypingForNonUserTurn(3, true)).toBe(false);
  });

  it('mixed batch with at least one user row → still shows typing', () => {
    // poll-loop can process a user message and a task in the same
    // batch; presence of ANY user-kind row means the turn is
    // user-facing → keep typing. (hasUserKindProcessing is "≥1 user
    // row among the processing set".)
    expect(decideSuppressTypingForNonUserTurn(4, true)).toBe(false);
  });
});
