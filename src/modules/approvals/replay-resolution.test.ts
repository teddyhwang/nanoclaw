import { afterEach, describe, expect, it } from 'vitest';

import {
  markReplaySucceeded,
  isReplayAlreadyResolved,
  REPLAY_RESOLUTION_TTL_MS,
  _resetReplayResolutionForTesting,
} from './replay-resolution.js';

afterEach(() => _resetReplayResolutionForTesting());

const S = 'sess-1';
const A = 'cfm-approval-a';

describe('replay-resolution tracker', () => {
  it('treats an unrecorded approval as unresolved', () => {
    expect(isReplayAlreadyResolved(S, A)).toBe(false);
  });

  it('marks the same session and approval as resolved', () => {
    markReplaySucceeded(S, A);
    expect(isReplayAlreadyResolved(S, A)).toBe(true);
  });

  it('does not conflate concurrent approvals for the same tool', () => {
    markReplaySucceeded(S, A);
    expect(isReplayAlreadyResolved(S, 'cfm-approval-b')).toBe(false);
    expect(isReplayAlreadyResolved('sess-2', A)).toBe(false);
  });

  it('expires resolution state so it cannot mask a later request', () => {
    const t0 = 1_000_000;
    markReplaySucceeded(S, A, t0);
    expect(isReplayAlreadyResolved(S, A, t0 + 1)).toBe(true);
    expect(isReplayAlreadyResolved(S, A, t0 + REPLAY_RESOLUTION_TTL_MS + 1)).toBe(false);
  });
});
