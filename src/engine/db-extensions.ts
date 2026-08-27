/**
 * Plugin migrations and read-only DAL.
 *
 * Embedded hosts register portable central-DB migrations and consume a typed,
 * Promise-based read surface. Neither seam exposes the default SQLite
 * representation.
 */
import { getDb, hasTable } from '../db/connection.js';
import { getAgentGroup, getAllAgentGroups } from '../db/agent-groups.js';
import { getContainerConfig } from '../db/container-configs.js';
import type { DbDriver } from '../db/driver.js';
import { getMessagingGroupAgents, getMessagingGroupWithAgentCount } from '../db/messaging-groups.js';
import { getActiveSessions, getRunningSessions, getSession } from '../db/sessions.js';
import type { AgentGroup, ContainerConfigRow, MessagingGroup, MessagingGroupAgent, Session } from '../types.js';

export interface PluginMigration {
  /** Stable unique name. Rename = re-run, so don't. */
  name: string;
  up: (db: DbDriver) => void | Promise<void>;
}

const pluginMigrations: PluginMigration[] = [];

export function registerPluginMigrations(migrations: PluginMigration[]): void {
  for (const migration of migrations) {
    if (pluginMigrations.some((candidate) => candidate.name === migration.name)) {
      throw new Error(`Plugin migration "${migration.name}" already registered`);
    }
    pluginMigrations.push(migration);
  }
}

export function getPluginMigrations(): ReadonlyArray<PluginMigration> {
  return pluginMigrations;
}

/**
 * Compatibility entry point for older embedders. The normal boot path does
 * not call this: runMigrations automatically appends plugin migrations after
 * core. When invoked directly it still uses the unified DbDriver runner.
 */
export async function applyPluginMigrations(db: DbDriver): Promise<void> {
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(
    db,
    pluginMigrations.map((migration) => ({
      version: Number.MAX_SAFE_INTEGER,
      name: migration.name,
      up: migration.up,
    })),
    { mode: 'migrate' },
  );
}

/** Read-only DAL — the surface plugins should use instead of touching SQL. */
export interface ReadDal {
  agentGroup(id: string): Promise<AgentGroup | undefined>;
  listAgentGroups(): Promise<AgentGroup[]>;
  messagingGroupByPlatform(channelType: string, platformId: string): Promise<MessagingGroup | undefined>;
  messagingGroupAgents(messagingGroupId: string): Promise<MessagingGroupAgent[]>;
  activeSessions(): Promise<Session[]>;
  runningSessions(): Promise<Session[]>;
  session(id: string): Promise<Session | undefined>;
  containerConfig(agentGroupId: string): Promise<ContainerConfigRow | undefined>;
  hasTable(name: string): Promise<boolean>;
}

export function getReadDal(): ReadDal {
  return {
    agentGroup: (id) => getAgentGroup(id),
    listAgentGroups: () => getAllAgentGroups(),
    messagingGroupByPlatform: async (channelType, platformId) =>
      (await getMessagingGroupWithAgentCount(channelType, platformId))?.mg,
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
