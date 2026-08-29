import { describe, expect, it } from 'bun:test';

import {
  extractAssistantText,
  isRejectedClaudeRateLimitEvent,
  isRetryableClaudeApiRateLimitResult,
  mcpTimeoutEnv,
} from './claude.js';

describe('ClaudeProvider streaming and rate-limit helpers', () => {
  it('joins SDK assistant text blocks in content order without inventing separators', () => {
    const text = extractAssistantText({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '<message to="chat">Done.</message>' },
          { type: 'tool_use', name: 'TodoWrite' },
          { type: 'text', text: '<internal>logged</internal>' },
        ],
      },
    });

    expect(text).toBe('<message to="chat">Done.</message><internal>logged</internal>');
  });

  it('classifies Claude SDK API rate-limit results as retryable', () => {
    expect(
      isRetryableClaudeApiRateLimitResult(
        "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
      ),
    ).toBe(true);
    expect(isRetryableClaudeApiRateLimitResult('API Error: Quota exceeded for this model.')).toBe(true);
  });

  it('does not classify ordinary unwrapped public text as a rate limit', () => {
    expect(isRetryableClaudeApiRateLimitResult('Please rate limit the invite list to 10 customers.')).toBe(false);
    expect(isRetryableClaudeApiRateLimitResult('Done but forgot the wrapper.')).toBe(false);
    expect(isRetryableClaudeApiRateLimitResult('API Error: Request rejected (400) · invalid model')).toBe(false);
  });

  it('only treats rejected SDK rate-limit info updates as failures', () => {
    expect(
      isRejectedClaudeRateLimitEvent({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', utilization: 0.9 },
      }),
    ).toBe(false);
    expect(
      isRejectedClaudeRateLimitEvent({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected' },
      }),
    ).toBe(true);
    expect(
      isRejectedClaudeRateLimitEvent({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', overageStatus: 'rejected' },
      }),
    ).toBe(true);
  });
});

describe('mcpTimeoutEnv', () => {
  it('applies default MCP timeouts when the inherited env has none', () => {
    const env = mcpTimeoutEnv({});
    // Defaults: 120s tool-call bound, 30s connect bound. A hung MCP call is
    // aborted by the CLI instead of wedging the turn for the host's 60-min
    // MCP_TOOL_CEILING_MS (the Cook-chat freeze, 2026-05-31).
    expect(env.MCP_TOOL_TIMEOUT).toBe('120000');
    expect(env.MCP_TIMEOUT).toBe('30000');
  });

  it('lets an explicit host/operator override win over the default', () => {
    const env = mcpTimeoutEnv({ MCP_TOOL_TIMEOUT: '5000', MCP_TIMEOUT: '1000' });
    expect(env.MCP_TOOL_TIMEOUT).toBe('5000');
    expect(env.MCP_TIMEOUT).toBe('1000');
  });

  it('extends MCP startup for the simultaneous nightly Dream wave', () => {
    const env = mcpTimeoutEnv({ NANOCLAW_DREAM_HARNESS: 'claude' });
    expect(env.MCP_TOOL_TIMEOUT).toBe('120000');
    expect(env.MCP_TIMEOUT).toBe('120000');
  });

  it('keeps an explicit Dream startup override authoritative', () => {
    const env = mcpTimeoutEnv({ NANOCLAW_DREAM_HARNESS: 'claude', MCP_TIMEOUT: '45000' });
    expect(env.MCP_TIMEOUT).toBe('45000');
  });

  it('defaults each var independently', () => {
    const env = mcpTimeoutEnv({ MCP_TOOL_TIMEOUT: '90000' });
    expect(env.MCP_TOOL_TIMEOUT).toBe('90000');
    expect(env.MCP_TIMEOUT).toBe('30000');
  });
});
