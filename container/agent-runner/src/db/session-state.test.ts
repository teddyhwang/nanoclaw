import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  clearAllSessionTrackingState,
  clearContinuation,
  clearContinuationStartedAt,
  getContinuation,
  getContinuationStartedAt,
  migrateLegacyContinuation,
  setContinuation,
  setContinuationStartedAt,
} from './session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

function seedLegacy(value: string): void {
  getOutboundDb()
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('sdk_session_id', value, new Date().toISOString());
}

describe('session-state — per-provider continuations', () => {
  test('set/get round-trip, case-insensitive provider key', () => {
    setContinuation('claude', 'claude-conv-1');
    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('Claude')).toBe('claude-conv-1');
    expect(getContinuation('CLAUDE')).toBe('claude-conv-1');
  });

  test('providers are isolated — switching reads the right slot', () => {
    setContinuation('claude', 'claude-conv-1');
    setContinuation('codex', 'codex-thread-xyz');

    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('codex')).toBe('codex-thread-xyz');
  });

  test('clearContinuation only affects the specified provider', () => {
    setContinuation('claude', 'keep-me');
    setContinuation('codex', 'drop-me');

    clearContinuation('codex');

    expect(getContinuation('claude')).toBe('keep-me');
    expect(getContinuation('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', () => {
    expect(getContinuation('never-used')).toBeUndefined();
  });

  test('clearAllSessionTrackingState wipes continuations + startedAt, leaves other state', () => {
    setContinuation('claude', 'c-1');
    setContinuation('codex', 'x-1');
    setContinuationStartedAt('claude', '2026-05-13');
    setContinuationStartedAt('codex', '2026-05-12');
    getOutboundDb()
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('last_user_seen', '2026-05-07', new Date().toISOString());

    const cleared = clearAllSessionTrackingState();

    expect(cleared).toBe(4);
    expect(getContinuation('claude')).toBeUndefined();
    expect(getContinuation('codex')).toBeUndefined();
    expect(getContinuationStartedAt('claude')).toBeUndefined();
    expect(getContinuationStartedAt('codex')).toBeUndefined();
    const remaining = getOutboundDb()
      .prepare('SELECT key FROM session_state ORDER BY key')
      .all() as { key: string }[];
    expect(remaining.map((r) => r.key)).toEqual(['last_user_seen']);
  });

  test('clearAllSessionTrackingState is a no-op on an empty session', () => {
    expect(clearAllSessionTrackingState()).toBe(0);
  });
});

describe('session-state — continuation startedAt', () => {
  test('set/get round-trip, case-insensitive provider key', () => {
    setContinuationStartedAt('claude', '2026-05-13');
    expect(getContinuationStartedAt('claude')).toBe('2026-05-13');
    expect(getContinuationStartedAt('Claude')).toBe('2026-05-13');
  });

  test('providers are isolated', () => {
    setContinuationStartedAt('claude', '2026-05-13');
    setContinuationStartedAt('codex', '2026-05-12');
    expect(getContinuationStartedAt('claude')).toBe('2026-05-13');
    expect(getContinuationStartedAt('codex')).toBe('2026-05-12');
  });

  test('clearContinuationStartedAt only affects the specified provider', () => {
    setContinuationStartedAt('claude', 'keep');
    setContinuationStartedAt('codex', 'drop');

    clearContinuationStartedAt('codex');

    expect(getContinuationStartedAt('claude')).toBe('keep');
    expect(getContinuationStartedAt('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', () => {
    expect(getContinuationStartedAt('never-used')).toBeUndefined();
  });
});

describe('session-state — legacy migration', () => {
  test('adopts legacy value into current provider when current is empty', () => {
    seedLegacy('old-session-id');

    const adopted = migrateLegacyContinuation('claude');

    expect(adopted).toBe('old-session-id');
    expect(getContinuation('claude')).toBe('old-session-id');
  });

  test('always deletes legacy row regardless of migration outcome', () => {
    seedLegacy('old-session-id');
    setContinuation('claude', 'existing');

    migrateLegacyContinuation('claude');

    // After migration the legacy key must be gone, whether or not it was adopted.
    // A subsequent migration for a different provider must not see it.
    const resultAfterSecondCall = migrateLegacyContinuation('codex');
    expect(resultAfterSecondCall).toBeUndefined();
  });

  test('prefers existing current-provider slot over legacy', () => {
    seedLegacy('legacy-value');
    setContinuation('claude', 'claude-value');

    const result = migrateLegacyContinuation('claude');

    expect(result).toBe('claude-value');
    expect(getContinuation('claude')).toBe('claude-value');
  });

  test('no legacy row — returns current provider value (possibly undefined)', () => {
    expect(migrateLegacyContinuation('claude')).toBeUndefined();

    setContinuation('codex', 'codex-value');
    expect(migrateLegacyContinuation('codex')).toBe('codex-value');
  });

  test('migration is idempotent on a second call (legacy already gone)', () => {
    seedLegacy('once');

    const first = migrateLegacyContinuation('claude');
    expect(first).toBe('once');

    const second = migrateLegacyContinuation('claude');
    expect(second).toBe('once');
  });
});
