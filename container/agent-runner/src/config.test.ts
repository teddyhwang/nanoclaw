import { afterEach, describe, expect, it } from 'bun:test';

import { _resetConfigForTests, loadConfig } from './config.js';

// CONFIG_PATH (/workspace/agent/container.json) does not exist in the
// test environment, so loadConfig() falls back to its built-in defaults
// — exactly the surface we want for exercising the env-var override
// without writing a fixture file.

afterEach(() => {
  _resetConfigForTests();
  delete process.env.NANOCLAW_DREAM_HARNESS;
  delete process.env.NANOCLAW_AGENT_MODEL;
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

describe('loadConfig — NANOCLAW_AGENT_MODEL override', () => {
  it('leaves model undefined when no override and no config file', () => {
    expect(loadConfig().model).toBeUndefined();
  });

  it('overrides model with NANOCLAW_AGENT_MODEL when set', () => {
    process.env.NANOCLAW_AGENT_MODEL = 'gpt-5.5';
    expect(loadConfig().model).toBe('gpt-5.5');
  });

  it('ignores an empty / whitespace-only NANOCLAW_AGENT_MODEL', () => {
    process.env.NANOCLAW_AGENT_MODEL = '   ';
    // Whitespace trims to empty → falls through to the container.json
    // model (absent here) → undefined.
    expect(loadConfig().model).toBeUndefined();
  });

  it('overrides model independently of the provider override', () => {
    // A dream spawn injects BOTH vars — codex provider + its model.
    process.env.NANOCLAW_DREAM_HARNESS = 'codex';
    process.env.NANOCLAW_AGENT_MODEL = 'gpt-5.5';
    const cfg = loadConfig();
    expect(cfg.provider).toBe('codex');
    expect(cfg.model).toBe('gpt-5.5');
  });
});

describe('loadConfig — isDreamRun', () => {
  it('is false on a normal (non-dream) spawn', () => {
    expect(loadConfig().isDreamRun).toBe(false);
  });

  it('is true when NANOCLAW_DREAM_HARNESS is set', () => {
    process.env.NANOCLAW_DREAM_HARNESS = 'codex';
    expect(loadConfig().isDreamRun).toBe(true);
  });

  it('is false for a whitespace-only NANOCLAW_DREAM_HARNESS (matches provider fall-through)', () => {
    process.env.NANOCLAW_DREAM_HARNESS = '   ';
    expect(loadConfig().isDreamRun).toBe(false);
  });
});
