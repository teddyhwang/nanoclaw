import { describe, expect, it } from 'bun:test';

import { pickPushScopedContext, type TaskFireContext } from './poll-loop.js';

// Push-scoped attribution replaces the prior "most recent unwritten
// overall" walk. The 2026-05-25 Degenerate-Server incident: a dream
// context registered in push 0 was starved when a chat-sdk task arrived
// in push 1 and won the attribution race for the dream's own result.
// Push-scoped serves the oldest push with pending contexts first.

function ctx(taskId: string, written = false): TaskFireContext {
  return {
    seriesId: taskId,
    taskId,
    dispatched: [],
    assistantText: null,
    written,
  };
}

describe('pickPushScopedContext', () => {
  it('returns null when there are no pushes', () => {
    expect(pickPushScopedContext([])).toBeNull();
  });

  it('returns null when every context across every push is written', () => {
    const a = ctx('a', true);
    const b = ctx('b', true);
    expect(pickPushScopedContext([[a], [b]])).toBeNull();
  });

  it('picks the newest unwritten context in the only push', () => {
    const a = ctx('a');
    const b = ctx('b');
    // Newest in the push wins — matches the original within-push order.
    expect(pickPushScopedContext([[a, b]])?.taskId).toBe('b');
  });

  it('serves the oldest push first, even when a later push has unwritten contexts', () => {
    // Degenerate scenario: dream in push 0 (unwritten), chat task in push 1
    // (unwritten). The dream's result lands first → dream wins.
    const dream = ctx('dream');
    const chat = ctx('chat');
    expect(pickPushScopedContext([[dream], [chat]])?.taskId).toBe('dream');
  });

  it('advances to the next push only once every earlier push is fully written', () => {
    const dream = ctx('dream', true); // dream just got its result, flushed
    const recap = ctx('recap');
    const chat = ctx('chat');
    // After dream is written, the next result attributes to push 1.
    expect(pickPushScopedContext([[dream], [recap, chat]])?.taskId).toBe('chat');
  });

  it('within a push, prefers the newer unwritten context when older is still pending', () => {
    // Both tasks in the same push (e.g. two follow-up tasks pushed together).
    // The newer one is the most-recently-registered — matches prior intra-
    // push behavior so existing assumptions hold for task↔task within one push.
    const older = ctx('older');
    const newer = ctx('newer');
    expect(pickPushScopedContext([[older, newer]])?.taskId).toBe('newer');
  });

  it('skips fully-written pushes entirely', () => {
    const a = ctx('a', true);
    const b = ctx('b', true);
    const c = ctx('c');
    expect(pickPushScopedContext([[a, b], [c]])?.taskId).toBe('c');
  });

  it('handles an empty push entry (chat-only follow-up registered no task contexts)', () => {
    const dream = ctx('dream');
    // Push 1 was a chat-sdk-only follow-up — no task contexts registered.
    // Dream in push 0 must still be reachable.
    expect(pickPushScopedContext([[dream], []])?.taskId).toBe('dream');
  });

  it('handles all-empty pushes', () => {
    expect(pickPushScopedContext([[], []])).toBeNull();
  });
});
