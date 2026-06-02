import { describe, expect, it } from 'bun:test';

import { shouldPersistContinuation, shouldResumeContinuation } from './poll-loop.js';

// Root-cause fix for silent empty dream fires (Degenerates / Stanielle /
// Teddy DM, 2026-05/06): a Dream / maintenance spawn must ALWAYS run on a
// fresh provider thread — never resume a persisted continuation, and never
// persist its own ephemeral thread back over the group's standing one.
// Resuming a stale/poisoned codex thread is what deadlocks thread/resume,
// hangs thread/start, or crashes the rmcp stdio transport mid-replay, each
// leaving task_fires.assistant_text empty.

describe('shouldResumeContinuation', () => {
  it('resumes a normal spawn that has a continuation', () => {
    expect(shouldResumeContinuation('thread-abc', false)).toBe(true);
  });

  it('does NOT resume when there is no continuation', () => {
    expect(shouldResumeContinuation(undefined, false)).toBe(false);
  });

  it('NEVER resumes on a dream spawn, even with a continuation present', () => {
    expect(shouldResumeContinuation('thread-abc', true)).toBe(false);
  });

  it('does not resume a dream spawn with no continuation either', () => {
    expect(shouldResumeContinuation(undefined, true)).toBe(false);
  });
});

describe('shouldPersistContinuation', () => {
  it('persists a freshly-adopted continuation on a normal spawn', () => {
    expect(shouldPersistContinuation(false)).toBe(true);
  });

  it('does NOT persist the ephemeral thread of a dream spawn', () => {
    // Persisting would clobber the interactive session's standing thread
    // with the dream's one-shot maintenance thread.
    expect(shouldPersistContinuation(true)).toBe(false);
  });
});
