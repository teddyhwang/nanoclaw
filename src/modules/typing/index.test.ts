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

import { classifyWakeCause, decideSuppressTypingForNonUserTurn } from './index.js';

const msg = (text: string, replyToId?: string) =>
  JSON.stringify({ _type: 'chat:Message', text, ...(replyToId ? { replyTo: { messageId: replyToId } } : {}) });

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

/**
 * Telemetry classifier for silent turns. Without this, "agent correctly
 * stayed quiet on ambient group chatter" and "agent ignored a user who
 * @mentioned/DM'd it" both logged the same indistinguishable
 * `silent_turn_complete` line — the ambiguity that made the 2026-05-16
 * Barret incident take a full reverse log-correlation to diagnose.
 * `addressed=true` is the suspicious combination to surface.
 */
describe('classifyWakeCause', () => {
  it('no resolvable trigger row → unknown, not addressed', () => {
    expect(classifyWakeCause(null, false)).toEqual({ wakeCause: 'unknown', addressed: false });
  });

  it('scheduled/recurring task wake → task, never addressed (silence is normal here)', () => {
    expect(classifyWakeCause({ kind: 'task', content: '{"prompt":"maintenance"}' }, false)).toEqual({
      wakeCause: 'task',
      addressed: false,
    });
    // Even in a DM-shaped session a task wake is not "addressed".
    expect(classifyWakeCause({ kind: 'task', content: '{}' }, true)).toEqual({ wakeCause: 'task', addressed: false });
  });

  it('1:1 DM chat wake → dm + addressed (one human, typed to this agent)', () => {
    expect(classifyWakeCause({ kind: 'chat-sdk', content: msg('hello there?') }, true)).toEqual({
      wakeCause: 'dm',
      addressed: true,
    });
  });

  it('the Barret regression: group @mention with a direct question → group-mention + addressed', () => {
    // Exact shape of the message that silently dropped on 2026-05-16:
    // a Discord user-id mention token + a direct question, in a group.
    const barret = msg('<@1485390229526413444> for your dream cycle ability is there a repo with this available ?');
    expect(classifyWakeCause({ kind: 'chat-sdk', content: barret }, false)).toEqual({
      wakeCause: 'group-mention',
      addressed: true,
    });
  });

  it('reply-to-bot in a group (no mention token) → reply-to-bot + addressed', () => {
    expect(
      classifyWakeCause({ kind: 'chat-sdk', content: msg('and the other thing?', 'plat-msg-123') }, false),
    ).toEqual({ wakeCause: 'reply-to-bot', addressed: true });
  });

  it('ambient group chatter (no mention, no reply, not a DM) → group-ambient + NOT addressed', () => {
    // The legitimately-silent case the old log could not distinguish
    // from the Barret case. Staying quiet here is correct behavior.
    expect(classifyWakeCause({ kind: 'chat-sdk', content: msg('lol that game was wild') }, false)).toEqual({
      wakeCause: 'group-ambient',
      addressed: false,
    });
  });

  it('malformed/non-JSON content → degrades to group-ambient, never throws', () => {
    // Telemetry must never break delivery; bad content just means we
    // can't see mention/reply signals, so treat as ambient.
    expect(classifyWakeCause({ kind: 'chat-sdk', content: 'not json {' }, false)).toEqual({
      wakeCause: 'group-ambient',
      addressed: false,
    });
    // ...but a DM is still addressed regardless of content parseability.
    expect(classifyWakeCause({ kind: 'chat-sdk', content: 'not json {' }, true)).toEqual({
      wakeCause: 'dm',
      addressed: true,
    });
  });
});
