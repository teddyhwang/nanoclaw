/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import type { Destination } from '../../mailbox/index.js';
import { log } from '../../log.js';
import { retryWhileBusy } from '../../mailbox/sqlite/busy.js';
import { serializeSessionProjection, withMailboxSession } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

/** Serialized per session (serializeSessionProjection): a slow retried write
 * never lands after a newer projection. */
export function writeDestinations(agentGroupId: string, sessionId: string): Promise<void> {
  return serializeSessionProjection(`destinations:${agentGroupId}:${sessionId}`, () =>
    writeDestinationsNow(agentGroupId, sessionId),
  );
}

async function writeDestinationsNow(agentGroupId: string, sessionId: string): Promise<void> {
  const rows = await getDestinations(agentGroupId);
  const resolved: Destination[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = await getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        displayName: mg.name ?? row.local_name,
        type: 'channel',
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        agentGroupId: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = await getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        displayName: ag.name,
        type: 'agent',
        channelType: null,
        platformId: null,
        agentGroupId: ag.id,
      });
    }
  }

  // Runs on every wake: a brief runner lock must not fail the wake or leave
  // a stale destination map. One replace transaction, so retry (busy.ts).
  await retryWhileBusy(() =>
    withMailboxSession(agentGroupId, sessionId, (db) => {
      db.replaceDestinations(resolved);
    }),
  );
  log.debug('Destination map written', { sessionId, count: resolved.length });
}
