import { describe, expect, test } from 'bun:test';

import {
  computeRotationDate,
  evaluateRotation,
  SIZE_ROTATION_THRESHOLD_BYTES,
  TOKENS_ROTATION_THRESHOLD,
} from './session-rotation.js';
import type { SessionStats } from './session-stats.js';

const TZ = 'America/Toronto';

function statsFrom(partial: Partial<SessionStats>): SessionStats {
  return { compactCount: 0, sizeBytes: 0, turnCount: 0, ...partial };
}

describe('computeRotationDate', () => {
  test('shifts 03:00 local back across the rotation boundary', () => {
    // 2026-05-13 03:30 in Toronto (UTC-4 in May) is 07:30Z.
    const at0330 = new Date('2026-05-13T07:30:00Z');
    expect(computeRotationDate(at0330, TZ)).toBe('2026-05-12');
  });

  test('04:00 local is the new rotation day', () => {
    // 2026-05-13 04:00 in Toronto = 08:00Z. Shifting back 4h lands at 04:00Z
    // = 2026-05-13 00:00 local → rotation day 2026-05-13.
    const at0400 = new Date('2026-05-13T08:00:00Z');
    expect(computeRotationDate(at0400, TZ)).toBe('2026-05-13');
  });

  test('mid-afternoon stays on the same calendar day', () => {
    const at1500 = new Date('2026-05-13T19:00:00Z');
    expect(computeRotationDate(at1500, TZ)).toBe('2026-05-13');
  });
});

describe('evaluateRotation', () => {
  // Use 04:30 local on 2026-05-13 — past the rotation boundary so the
  // "today's rotation day" is 2026-05-13.
  const now = new Date('2026-05-13T08:30:00Z');

  test('no stamp + quiet session → no-session (preserve as-is)', () => {
    const decision = evaluateRotation(now, TZ, undefined, statsFrom({}));
    expect(decision).toEqual({ rotate: false, reason: 'no-session' });
  });

  test('no stamp + compacted disk evidence → rotate (pre-fix unstamped row)', () => {
    const decision = evaluateRotation(now, TZ, undefined, statsFrom({ compactCount: 1 }));
    expect(decision).toEqual({ rotate: true, reason: 'compacted' });
  });

  test('same rotation day → preserve even if compacted (mid-chat continuity)', () => {
    const decision = evaluateRotation(now, TZ, '2026-05-13', statsFrom({ compactCount: 5 }));
    expect(decision).toEqual({ rotate: false, reason: 'same-day' });
  });

  test('prior rotation day + no disk evidence → cross-day-stale (force rotate)', () => {
    // Regression: a stamped cross-day session with empty in-container stats
    // (transcript .jsonl absent/unreadable) must still rotate. Pre-fix this
    // fell through to quiet-session/rotate:false and stranded the Degenerates
    // Claude thread from 2026-05-30, emptying every 04:00 dream turn.
    const decision = evaluateRotation(now, TZ, '2026-05-12', statsFrom({}));
    expect(decision).toEqual({ rotate: true, reason: 'cross-day-stale' });
  });

  test('prior rotation day, one day back, still rotates with no evidence', () => {
    const decision = evaluateRotation(now, TZ, '2026-05-12', statsFrom({}));
    expect(decision.rotate).toBe(true);
  });

  test('prior day + one compact → rotate (chained-compaction risk)', () => {
    const decision = evaluateRotation(now, TZ, '2026-05-12', statsFrom({ compactCount: 1 }));
    expect(decision).toEqual({ rotate: true, reason: 'compacted' });
  });

  test('prior day + transcript over size threshold → rotate', () => {
    const decision = evaluateRotation(
      now,
      TZ,
      '2026-05-12',
      statsFrom({ sizeBytes: SIZE_ROTATION_THRESHOLD_BYTES + 1 }),
    );
    expect(decision).toEqual({ rotate: true, reason: 'size-threshold' });
  });

  test('prior day + size exactly at threshold → cross-day-stale (size guard is strict greater, but cross-day still rotates)', () => {
    // The size guard itself is strict-greater so it does NOT fire at exactly
    // the threshold, but the session is still cross-day with a stamp, so the
    // cross-day-stale guard rotates it anyway (reason is cross-day-stale, not
    // size-threshold).
    const decision = evaluateRotation(now, TZ, '2026-05-12', statsFrom({ sizeBytes: SIZE_ROTATION_THRESHOLD_BYTES }));
    expect(decision).toEqual({ rotate: true, reason: 'cross-day-stale' });
  });

  test('prior day + tokens over threshold → rotate (codex-style signal)', () => {
    const decision = evaluateRotation(now, TZ, '2026-05-12', statsFrom({ tokensUsed: TOKENS_ROTATION_THRESHOLD + 1 }));
    expect(decision).toEqual({ rotate: true, reason: 'tokens-threshold' });
  });

  test('compact-count takes precedence over size and tokens', () => {
    const decision = evaluateRotation(
      now,
      TZ,
      '2026-05-12',
      statsFrom({
        compactCount: 2,
        sizeBytes: SIZE_ROTATION_THRESHOLD_BYTES + 1,
        tokensUsed: TOKENS_ROTATION_THRESHOLD + 1,
      }),
    );
    expect(decision.reason).toBe('compacted');
  });

  test('size beats tokens when both trip', () => {
    const decision = evaluateRotation(
      now,
      TZ,
      '2026-05-12',
      statsFrom({
        sizeBytes: SIZE_ROTATION_THRESHOLD_BYTES + 1,
        tokensUsed: TOKENS_ROTATION_THRESHOLD + 1,
      }),
    );
    expect(decision.reason).toBe('size-threshold');
  });
});
