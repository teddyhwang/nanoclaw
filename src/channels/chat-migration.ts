/**
 * Shared `onChatMigrated` handler used by both engine boot sites
 * (`src/index.ts` standalone CLI and `src/engine/host-boot.ts` embedded
 * host). Rewrites `messaging_groups.platform_id` and refreshes per-session
 * routing for every session bound to that messaging group, then emits
 * `channel.migrated` so host plugins with their own platform-id-keyed
 * state can rewrite their copies.
 *
 * Sole emitter today is the Telegram chat-sdk bridge on a
 * `migrate_to_chat_id` service event (basic-group → supergroup upgrade).
 * Without this hook the router would silently drop every inbound update
 * under the new id and delivery would bounce every outbound reply off
 * the dead old id ("Bad Request: group chat was upgraded to a
 * supergroup chat" — three retries then permanent give-up).
 */
import { emitEngineEvent } from '../engine/events.js';
import { log } from '../log.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  setMessagingGroupPlatformId,
} from '../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { writeSessionRouting } from '../session-manager.js';

export async function handleChatMigrated(
  channelType: string,
  oldPlatformId: string,
  newPlatformId: string,
): Promise<void> {
  try {
    const mg = await getMessagingGroupByPlatform(channelType, oldPlatformId);
    if (!mg) {
      log.warn('onChatMigrated: no messaging group for old platform id (already rewritten or never wired)', {
        channelType,
        oldPlatformId,
        newPlatformId,
      });
      return;
    }
    const changed = await setMessagingGroupPlatformId(mg.id, newPlatformId);
    if (!changed) return; // already at newPlatformId
    log.info('Rewrote messaging_groups.platform_id', {
      messagingGroupId: mg.id,
      channelType,
      oldPlatformId,
      newPlatformId,
    });
    // writeSessionRouting reads from the now-updated messaging_groups row,
    // so it picks up the new platform_id automatically.
    const mgas = await getMessagingGroupAgents(mg.id);
    let sessionsRefreshed = 0;
    for (const mga of mgas) {
      const sessions = await getSessionsByAgentGroup(mga.agent_group_id);
      for (const session of sessions) {
        try {
          await writeSessionRouting(mga.agent_group_id, session.id);
          sessionsRefreshed += 1;
        } catch (err) {
          log.warn('writeSessionRouting failed after migrate', {
            agentGroupId: mga.agent_group_id,
            sessionId: session.id,
            err,
          });
        }
      }
    }
    log.info('Refreshed session routing after chat migration', {
      messagingGroupId: mg.id,
      sessionsRefreshed,
    });
    emitEngineEvent('channel.migrated', {
      channelType,
      oldPlatformId,
      newPlatformId,
      messagingGroupId: mg.id,
      sessionsRefreshed,
    });
  } catch (err) {
    log.error('onChatMigrated failed', {
      channelType,
      oldPlatformId,
      newPlatformId,
      err,
    });
  }
}
