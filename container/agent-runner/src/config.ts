/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

import type { McpServerConfig } from './providers/types.js';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  /** Discriminated union — see providers/types.ts:McpServerConfig. */
  mcpServers: Record<string, McpServerConfig>;
  model?: string;
  effort?: string;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 *
 * `NANOCLAW_DREAM_HARNESS` / `NANOCLAW_AGENT_MODEL` overrides:
 * container.json `provider` and `model` are the agent group's standing
 * harness + model. When a spawn is a Dream / maintenance pass, the host
 * injects `NANOCLAW_DREAM_HARNESS` (a provider name — `claude`, `codex`,
 * …) AND `NANOCLAW_AGENT_MODEL` (the model for that harness's provider
 * family) so the dream runs on the operator-selected harness+model
 * regardless of the group's normal config. Both env vars must override
 * here: a dream that switched provider to codex but kept the group's
 * standing claude `container.json` model would run codex on the wrong
 * model (observed 2026-05-22 — the codex provider's `options.model`
 * comes from this config and wins over its own env fallback). The vars
 * are dream-scoped by injection — the host only sets them on dream
 * spawns — so there is no risk of leaking into a normal turn.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  const dreamHarness = process.env.NANOCLAW_DREAM_HARNESS?.trim();
  const provider = dreamHarness || (raw.provider as string) || 'claude';
  if (dreamHarness) {
    console.error(`[config] NANOCLAW_DREAM_HARNESS set — Dream pass overriding provider to "${dreamHarness}"`);
  }

  // `NANOCLAW_AGENT_MODEL` overrides container.json `model` symmetrically
  // with the provider override above. The host injects it on dream
  // spawns alongside NANOCLAW_DREAM_HARNESS; it must win over the
  // group's standing model or the dream runs on the wrong model.
  const dreamModel = process.env.NANOCLAW_AGENT_MODEL?.trim();
  const model = dreamModel || (raw.model as string) || undefined;
  if (dreamModel) {
    console.error(`[config] NANOCLAW_AGENT_MODEL set — overriding model to "${dreamModel}"`);
  }

  _config = {
    provider,
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model,
    effort: (raw.effort as string) || undefined,
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}

/** Test-only: clear the memoized config so loadConfig() re-reads. */
export function _resetConfigForTests(): void {
  _config = null;
}
