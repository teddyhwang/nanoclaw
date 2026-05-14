/**
 * Plugin migrations and read-only DAL.
 *
 * Two facilities exposed to plugins:
 *
 *   1. `registerPluginMigrations([...])` — extra migrations applied alongside
 *      core's barrel. Same uniqueness semantics: `name` is the key, so
 *      plugins can pick any string and rely on `runMigrations` to skip
 *      already-applied entries on subsequent boots.
 *
 *   2. `getReadDal()` — typed read-only views of agent_groups, messaging_groups,
 *      sessions, dropped_messages. Hosts (Optimus dashboard projector) consume
 *      this rather than opening the raw DB. Schema changes upstream stay
 *      contained behind this surface.
 *
 * Plugin migrations run *after* core migrations on each boot. Engine consumer
 * (`db/migrations/index.ts`) calls `getPluginMigrations()` after applying the
 * built-in array.
 */
import type Database from 'better-sqlite3';

import { getDb, hasTable } from '../db/connection.js';
import { getAgentGroup, getAllAgentGroups } from '../db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupWithAgentCount } from '../db/messaging-groups.js';
import { getActiveSessions, getRunningSessions, getSession } from '../db/sessions.js';
import { getContainerConfig } from '../db/container-configs.js';
import type { AgentGroup, ContainerConfigRow, MessagingGroup, MessagingGroupAgent, Session } from '../types.js';

export interface PluginMigration {
  /** Stable unique name. Rename = re-run, so don't. */
  name: string;
  up: (db: Database.Database) => void;
}

const pluginMigrations: PluginMigration[] = [];

export function registerPluginMigrations(migrations: PluginMigration[]): void {
  pluginMigrations.push(...migrations);
}

export function getPluginMigrations(): ReadonlyArray<PluginMigration> {
  return pluginMigrations;
}

/**
 * Apply pending plugin migrations to the central DB. Called from
 * `runMigrations` after core migrations. Idempotent — `schema_version`
 * already de-duplicates by name.
 */
export function applyPluginMigrations(db: Database.Database): void {
  if (pluginMigrations.length === 0) return;
  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );
  for (const m of pluginMigrations) {
    if (applied.has(m.name)) continue;
    db.transaction(() => {
      m.up(db);
      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number })
        .v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        next,
        m.name,
        new Date().toISOString(),
      );
    })();
  }
}

/** Read-only DAL — the surface plugins should use instead of touching SQL. */
export interface ReadDal {
  agentGroup(id: string): AgentGroup | undefined;
  listAgentGroups(): AgentGroup[];
  messagingGroupByPlatform(channelType: string, platformId: string): MessagingGroup | undefined;
  messagingGroupAgents(messagingGroupId: string): MessagingGroupAgent[];
  activeSessions(): Session[];
  runningSessions(): Session[];
  session(id: string): Session | undefined;
  containerConfig(agentGroupId: string): ContainerConfigRow | undefined;
  hasTable(name: string): boolean;
}

export function getReadDal(): ReadDal {
  return {
    agentGroup: (id) => getAgentGroup(id),
    listAgentGroups: () => getAllAgentGroups(),
    messagingGroupByPlatform: (channelType, platformId) => getMessagingGroupWithAgentCount(channelType, platformId)?.mg,
    messagingGroupAgents: (id) => getMessagingGroupAgents(id),
    activeSessions: () => getActiveSessions(),
    runningSessions: () => getRunningSessions(),
    session: (id) => getSession(id),
    containerConfig: (id) => getContainerConfig(id),
    hasTable: (name) => hasTable(getDb(), name),
  };
}

/** Test-only. */
export function _resetPluginMigrationsForTests(): void {
  pluginMigrations.length = 0;
}
