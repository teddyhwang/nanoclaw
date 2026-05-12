/**
 * Internal boot shim for the embeddable host.
 *
 * Mirrors the body of `src/index.ts`'s `main()` so that
 * `createNanoClawHost().start()` boots the same way the standalone CLI does.
 * Kept in its own file so `src/index.ts` stays a thin entrypoint and the
 * boot sequence is reachable from both standalone and embedded contexts.
 *
 * NOT part of the public plugin API. Hosts should use `createNanoClawHost`.
 */
import path from 'path';

import { getEnginePaths } from './paths.js';
import { engineEvents, emitEngineEvent } from './events.js';
import { enforceStartupBackoff, resetCircuitBreaker } from '../circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from '../claude-md-compose.js';
import { initDb } from '../db/connection.js';
import { backfillContainerConfigs } from '../backfill-container-configs.js';
import { runMigrations } from '../db/migrations/index.js';
import { applyPluginMigrations } from './db-extensions.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from '../container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from '../delivery.js';
import { startHostSweep, stopHostSweep } from '../host-sweep.js';
import { routeInbound } from '../router.js';
import { log } from '../log.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from '../channels/channel-registry.js';
import type { ChannelAdapter, ChannelSetup } from '../channels/adapter.js';
import { getResponseHandlers, getShutdownCallbacks, type ResponsePayload } from '../response-registry.js';

// Channel barrel — each enabled channel self-registers on import.
import '../channels/index.js';
// Modules barrel — registry-based modules self-register on import.
import '../modules/index.js';

let booted = false;
let signalsInstalled = false;

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

/**
 * Run the engine boot sequence. Idempotent — calling twice is a no-op.
 * The body mirrors `src/index.ts::main()`.
 */
export async function _bootForHost(opts: { managedSignals: boolean }): Promise<void> {
  if (booted) return;
  booted = true;

  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 1. Init central DB (path resolved through engine-paths so overrides apply)
  const dbPath = path.join(getEnginePaths().dataDir, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  applyPluginMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. One-time filesystem cutover — idempotent.
  migrateGroupsToClaudeLocal();

  // 1c. One-time backfill — seed container_configs rows from any pre-DB
  //     `groups/<folder>/container.json` files. Idempotent: rows that
  //     already exist are skipped. Runs here so embedded hosts (e.g.
  //     Optimus) get the same behaviour as the standalone src/index.ts.
  backfillContainerConfigs();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
            isBotMessage: message.isBotMessage,
            isBackfill: message.isBackfill,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
        emitEngineEvent('channel.metadata', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('../channels/adapter.js').OutboundFile[],
      inReplyTo?: string | null,
      assistantName?: string,
      assistantPrefixSeparator?: string,
      suppressEmbeds?: boolean,
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, {
        kind,
        content: JSON.parse(content),
        files,
        inReplyTo,
        assistantName,
        assistantPrefixSeparator,
        suppressEmbeds,
      });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // Optional: install SIGTERM/SIGINT handlers. Embedded hosts (Optimus) own
  // signals themselves and should pass managedSignals: false.
  if (opts.managedSignals && !signalsInstalled) {
    signalsInstalled = true;
    process.on('SIGTERM', () => void _shutdownForHost('SIGTERM').then(() => process.exit(0)));
    process.on('SIGINT', () => void _shutdownForHost('SIGINT').then(() => process.exit(0)));
  }

  log.info('NanoClaw running');
}

export async function _shutdownForHost(reason: string): Promise<void> {
  log.info('Shutdown requested', { reason });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  try {
    await teardownChannelAdapters();
  } finally {
    resetCircuitBreaker();
  }
  // Drop any event subscribers — host may be re-created in long-running tests.
  // (Note: in production process exits, this is a no-op.)
  // intentionally not clearing engineEvents — listeners may want shutdown
  // events; an external host can clear if needed.
  void engineEvents; // keep import alive for clarity
}

export async function _reloadForHost(): Promise<void> {
  // No-op for now. Future: re-read container.json across active sessions and
  // request a soft re-spawn on next idle. Plugins can subscribe to a future
  // 'host.reload' event to re-initialize their state.
  log.info('Reload requested (no-op)');
}
