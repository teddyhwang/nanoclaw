import type { ContainerConfigRow, SensitiveGateMode } from '../types.js';
import { getDb } from './connection.js';

const SCALAR_COLUMNS = new Set([
  'provider',
  'model',
  'effort',
  'image_tag',
  'assistant_name',
  'max_messages_per_prompt',
  'cli_scope',
  // Optimus fork patch (migration 016).
  'suppress_embeds',
  'assistant_prefix_separator',
  // Optimus fork patch (migration 017).
  'sensitive_gate_mode',
]);
const JSON_COLUMNS = new Set(['skills', 'mcp_servers', 'packages_apt', 'packages_npm', 'additional_mounts']);

export function getContainerConfig(agentGroupId: string): ContainerConfigRow | undefined {
  return getDb().prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(agentGroupId) as
    ContainerConfigRow | undefined;
}

export function getAllContainerConfigs(): ContainerConfigRow[] {
  return getDb().prepare('SELECT * FROM container_configs').all() as ContainerConfigRow[];
}

/**
 * The single source of truth for "is the sensitive gate on for this agent
 * group?". NULL, missing row, or any unrecognized value ⇒ `'enforce'`
 * (fail-safe default — see migration 017). Only an explicit, deliberate
 * admin `'off'` disables the gate. The gate decision fn and any UI/CLI that
 * reports the mode MUST go through this so the NULL⇒enforce normalization
 * lives in exactly one place.
 */
export function getSensitiveGateMode(agentGroupId: string): SensitiveGateMode {
  const row = getContainerConfig(agentGroupId);
  return row?.sensitive_gate_mode === 'off' ? 'off' : 'enforce';
}

/** Insert a new config row. Caller must supply all JSON fields (use defaults for empty). */
export function createContainerConfig(config: ContainerConfigRow): void {
  getDb()
    .prepare(
      `INSERT INTO container_configs (
        agent_group_id, provider, model, effort, image_tag, assistant_name,
        max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm,
        additional_mounts, cli_scope, suppress_embeds, assistant_prefix_separator,
        updated_at
      ) VALUES (
        @agent_group_id, @provider, @model, @effort, @image_tag, @assistant_name,
        @max_messages_per_prompt, @skills, @mcp_servers, @packages_apt, @packages_npm,
        @additional_mounts, @cli_scope, @suppress_embeds, @assistant_prefix_separator,
        @updated_at
      )`,
    )
    .run(config);
}

/** Create an empty config row with sensible defaults. Idempotent — no-ops if row exists. */
export function ensureContainerConfig(agentGroupId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO container_configs (agent_group_id, updated_at)
       VALUES (?, ?)`,
    )
    .run(agentGroupId, new Date().toISOString());
}

/** Update scalar fields on a config row. Only touches fields present in `updates`. */
export function updateContainerConfigScalars(
  agentGroupId: string,
  updates: Partial<
    Pick<
      ContainerConfigRow,
      | 'provider'
      | 'model'
      | 'effort'
      | 'image_tag'
      | 'assistant_name'
      | 'max_messages_per_prompt'
      | 'cli_scope'
      | 'suppress_embeds'
      | 'assistant_prefix_separator'
      | 'sensitive_gate_mode'
    >
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agent_group_id: agentGroupId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (!SCALAR_COLUMNS.has(key)) throw new Error(`Invalid scalar column: ${key}`);
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = @updated_at');
  values.updated_at = new Date().toISOString();

  getDb()
    .prepare(`UPDATE container_configs SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`)
    .run(values);
}

/** Overwrite a JSON column wholesale. Used for skills, mcp_servers, packages_*, additional_mounts. */
export function updateContainerConfigJson(
  agentGroupId: string,
  column: 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts',
  value: unknown,
): void {
  if (!JSON_COLUMNS.has(column)) throw new Error(`Invalid JSON column: ${column}`);
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE container_configs SET ${column} = ?, updated_at = ? WHERE agent_group_id = ?`)
    .run(JSON.stringify(value), now, agentGroupId);
}

export function deleteContainerConfig(agentGroupId: string): void {
  getDb().prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(agentGroupId);
}
