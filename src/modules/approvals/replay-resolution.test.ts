import { afterEach, describe, expect, it } from 'vitest';

import {
  markReplaySucceeded,
  isReplayAlreadyResolved,
  REPLAY_RESOLUTION_TTL_MS,
  _resetReplayResolutionForTesting,
} from './replay-resolution.js';

afterEach(() => _resetReplayResolutionForTesting());

const S = 'sess-1';
const I = 'google';
const T = 'google_call';

describe('replay-resolution tracker', () => {
  it('unrecorded call is not resolved', () => {
    expect(isReplayAlreadyResolved(S, I, T)).toBe(false);
  });

  it('marking success makes the SAME (session,integration,tool) resolved', () => {
    markReplaySucceeded(S, I, T);
    expect(isReplayAlreadyResolved(S, I, T)).toBe(true);
  });

  it('resolution is keyed precisely — a different tool/integration/session is unaffected', () => {
    markReplaySucceeded(S, I, T);
    expect(isReplayAlreadyResolved(S, I, 'other_tool')).toBe(false);
    expect(isReplayAlreadyResolved(S, 'lunchmoney', T)).toBe(false);
    expect(isReplayAlreadyResolved('sess-2', I, T)).toBe(false);
  });

  it('resolution TTL-expires — does not mask a genuinely new later request', () => {
    const t0 = 1_000_000;
    markReplaySucceeded(S, I, T, t0);
    expect(isReplayAlreadyResolved(S, I, T, t0 + 1)).toBe(true);
    expect(isReplayAlreadyResolved(S, I, T, t0 + REPLAY_RESOLUTION_TTL_MS + 1)).toBe(false);
  });
});
