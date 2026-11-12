import { describe, expect, it } from 'bun:test';

import { classifyFailureCause, isUserFacingFailureChannel } from './failure-notice-alert.js';

describe('classifyFailureCause', () => {
  it('reads the structured provider diagnostic', () => {
    expect(
      classifyFailureCause(
        'Provider invocation failed (unknown); Provider diagnostic={"classification":"auth","code":"token_expired","status":401}',
      ),
    ).toBe('auth/token_expired');
    expect(
      classifyFailureCause('x Provider diagnostic={"classification":"unknown","noRetryReason":"no_output_deadline"}'),
    ).toBe('unknown/no_output_deadline');
  });

  it('falls back to coarse keyword classes and never echoes free text', () => {
    expect(classifyFailureCause('Both claude and codex have reached their usage limits. Please try again')).toBe(
      'quota/both_providers',
    );
    expect(classifyFailureCause('retryable provider error, no result: socket hang up')).toBe('retryable_no_result');
    expect(classifyFailureCause('Request timed out')).toBe('timeout');
    expect(classifyFailureCause('my private question')).toBe('unclassified');
    expect(classifyFailureCause('"classification":"Has Spaces <b>"')).toBe('unclassified');
  });
});

describe('isUserFacingFailureChannel', () => {
  it('skips agent-to-agent and local CLI routes', () => {
    expect(isUserFacingFailureChannel('telegram')).toBe(true);
    expect(isUserFacingFailureChannel('agent')).toBe(false);
    expect(isUserFacingFailureChannel('cli')).toBe(false);
    expect(isUserFacingFailureChannel(null)).toBe(false);
  });
});
