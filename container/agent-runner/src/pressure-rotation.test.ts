/**
 * pressure-rotation tests — the pure decision surface of the proactive
 * consolidate-then-rotate path. The poll-loop wiring (push handoff →
 * rotate on its result → end stream) is a thin state machine over these
 * functions; the failure modes worth pinning are threshold resolution
 * (operator env overrides), the fire-exactly-once decision, and the two
 * operator-facing prompt/notice texts keeping their load-bearing
 * directives.
 */
import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_PRESSURE_RATIO,
  buildPressureHandoffPrompt,
  buildRotationNotice,
  resolvePressureThresholdTokens,
  shouldRequestPressureHandoff,
} from './pressure-rotation.js';
import { contextTokensFromUsage } from './providers/claude.js';

describe('resolvePressureThresholdTokens', () => {
  it('defaults to 70% of the auto-compact window', () => {
    expect(resolvePressureThresholdTokens({}, 165_000)).toBe(Math.floor(165_000 * DEFAULT_PRESSURE_RATIO));
  });

  it('honors PRESSURE_ROTATION_RATIO within (0, 1]', () => {
    expect(resolvePressureThresholdTokens({ PRESSURE_ROTATION_RATIO: '0.5' }, 165_000)).toBe(82_500);
    expect(resolvePressureThresholdTokens({ PRESSURE_ROTATION_RATIO: '1' }, 100_000)).toBe(100_000);
  });

  it('ignores out-of-range or malformed ratios', () => {
    const dflt = Math.floor(165_000 * DEFAULT_PRESSURE_RATIO);
    expect(resolvePressureThresholdTokens({ PRESSURE_ROTATION_RATIO: '0' }, 165_000)).toBe(dflt);
    expect(resolvePressureThresholdTokens({ PRESSURE_ROTATION_RATIO: '1.5' }, 165_000)).toBe(dflt);
    expect(resolvePressureThresholdTokens({ PRESSURE_ROTATION_RATIO: 'nope' }, 165_000)).toBe(dflt);
  });

  it('absolute PRESSURE_ROTATION_TOKENS wins over the ratio', () => {
    expect(
      resolvePressureThresholdTokens({ PRESSURE_ROTATION_TOKENS: '90000', PRESSURE_ROTATION_RATIO: '0.5' }, 165_000),
    ).toBe(90_000);
  });

  it('zero or negative absolute override disables the feature', () => {
    expect(resolvePressureThresholdTokens({ PRESSURE_ROTATION_TOKENS: '0' }, 165_000)).toBeNull();
    expect(resolvePressureThresholdTokens({ PRESSURE_ROTATION_TOKENS: '-1' }, 165_000)).toBeNull();
  });

  it('returns null for an unusable window', () => {
    expect(resolvePressureThresholdTokens({}, 0)).toBeNull();
    expect(resolvePressureThresholdTokens({}, Number.NaN)).toBeNull();
  });
});

describe('shouldRequestPressureHandoff', () => {
  it('fires when idle and at/above threshold', () => {
    expect(shouldRequestPressureHandoff('idle', 120_000, 115_500)).toBe(true);
    expect(shouldRequestPressureHandoff('idle', 115_500, 115_500)).toBe(true);
  });

  it('does not fire below threshold', () => {
    expect(shouldRequestPressureHandoff('idle', 10_000, 115_500)).toBe(false);
  });

  it('disabled when threshold is null (dream runs, usage-less providers)', () => {
    expect(shouldRequestPressureHandoff('idle', 999_999, null)).toBe(false);
  });

  it('fires at most once per stream — never from requested/rotated states', () => {
    expect(shouldRequestPressureHandoff('handoff-requested', 200_000, 115_500)).toBe(false);
    expect(shouldRequestPressureHandoff('rotated', 200_000, 115_500)).toBe(false);
  });

  it('ignores results with no usable token signal', () => {
    expect(shouldRequestPressureHandoff('idle', undefined, 115_500)).toBe(false);
    expect(shouldRequestPressureHandoff('idle', Number.NaN, 115_500)).toBe(false);
  });
});

describe('buildPressureHandoffPrompt', () => {
  const prompt = buildPressureHandoffPrompt(120_000, 115_500);

  it('is a system-wrapped maintenance instruction', () => {
    expect(prompt.startsWith('<system>')).toBe(true);
    expect(prompt.endsWith('</system>')).toBe(true);
  });

  it('carries the load-bearing directives', () => {
    expect(prompt).toContain('notes/');
    expect(prompt).toContain('<internal>');
    expect(prompt).toContain('Do NOT send any channel messages');
    // Rotation must not depend on the agent calling the tool.
    expect(prompt).toContain('you do not need to call rotate_session');
  });
});

describe('buildRotationNotice', () => {
  const notice = buildRotationNotice('context pressure — proactive pre-compaction rotation');

  it('names the reason and points at both context bridges', () => {
    expect(notice).toContain('context pressure');
    expect(notice).toContain('notes/');
    expect(notice).toContain('conversations/');
  });

  it('tells the agent not to surface the housekeeping', () => {
    expect(notice).toContain('do not mention this housekeeping');
  });
});

describe('contextTokensFromUsage', () => {
  it('sums fresh, cache, and output tokens', () => {
    expect(
      contextTokensFromUsage({
        input_tokens: 1_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 110_000,
        output_tokens: 500,
      }),
    ).toBe(113_500);
  });

  it('tolerates missing fields', () => {
    expect(contextTokensFromUsage({ input_tokens: 5, output_tokens: 7 })).toBe(12);
  });

  it('returns undefined when there is nothing to read', () => {
    expect(contextTokensFromUsage(undefined)).toBeUndefined();
    expect(contextTokensFromUsage({})).toBeUndefined();
  });
});
