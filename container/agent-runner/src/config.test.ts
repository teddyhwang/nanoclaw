import { afterEach, describe, expect, it } from 'bun:test';

import { _resetConfigForTests, loadConfig } from './config.js';

// CONFIG_PATH (/workspace/agent/container.json) does not exist in the
// test environment, so loadConfig() falls back to its built-in defaults
// — exactly the surface we want for exercising the env-var override
// without writing a fixture file.

afterEach(() => {
  _resetConfigForTests();
  delete process.env.NANOCLAW_DREAM_HARNESS;
});

describe('loadConfig — NANOCLAW_DREAM_HARNESS override', () => {
  it('defaults provider to "claude" when no override and no config file', () => {
    const cfg = loadConfig();
    expect(cfg.provider).toBe('claude');
  });

  it('overrides provider with NANOCLAW_DREAM_HARNESS when set', () => {
    process.env.NANOCLAW_DREAM_HARNESS = 'codex';
    const cfg = loadConfig();
    expect(cfg.provider).toBe('codex');
  });

  it('ignores an empty / whitespace-only NANOCLAW_DREAM_HARNESS', () => {
    process.env.NANOCLAW_DREAM_HARNESS = '   ';
    const cfg = loadConfig();
    // Whitespace trims to empty → falls through to the container.json
    // provider (absent here) → the "claude" default.
    expect(cfg.provider).toBe('claude');
  });

  it('memoizes — a later env change does not take effect without a reset', () => {
    const first = loadConfig();
    expect(first.provider).toBe('claude');
    process.env.NANOCLAW_DREAM_HARNESS = 'pi';
    // Same memoized object — no re-read.
    expect(loadConfig().provider).toBe('claude');
    _resetConfigForTests();
    expect(loadConfig().provider).toBe('pi');
  });
});
