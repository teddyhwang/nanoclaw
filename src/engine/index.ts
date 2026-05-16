/**
 * Public engine entry — the surface embedders use.
 *
 * This barrel intentionally re-exports only the seams plugins/hosts should
 * touch. Internals (router.ts, delivery.ts, container-runner.ts) stay in
 * their own modules and are not re-exported, so plugin code can't accidentally
 * couple to upstream internals and create merge-conflict surface.
 */
export { createNanoClawHost, type NanoClawHost, type NanoClawHostOptions } from './host.js';
export type { NanoClawPlugin, PluginContext } from './plugin.js';

export { engineEvents, type EngineEventBus, type EngineEventMap, type EngineEventName } from './events.js';

export {
  setEnginePaths,
  getEnginePaths,
  resolveGroupDir,
  type EnginePaths,
  type EnginePathOverrides,
  type GroupRef,
  type GroupDirResolver,
} from './paths.js';

export {
  setCredentialProvider,
  getCredentialProvider,
  type CredentialProvider,
  type CredentialBundle,
  type CredentialContext,
} from './credentials.js';

export {
  setPlatformCredentialReader,
  getPlatformCredentialReader,
  type PlatformCredentialReader,
} from './platform-credentials.js';

export {
  registerSpawnContribution,
  collectSpawnContributions,
  type SpawnContribution,
  type SpawnContext,
} from './spawn-contrib.js';

export {
  addSkillRoot,
  getExtraSkillRoots,
  addContextFragmentProvider,
  getContextFragments,
  type ExtraSkillRoot,
  type ContextFragmentProvider,
} from './skill-roots.js';

export {
  setWorkspaceResolver,
  resolveWorkspace,
  type WorkspaceResolverFn,
  type WorkspaceContext,
} from './workspace.js';

export {
  addSenderResolver,
  addAccessGate,
  addSenderScopeGate,
  addMessageInterceptor,
  addChannelRequestGate,
} from './router-hooks.js';

export {
  addDestinationGuard,
  type DestinationGuardFn,
  type DestinationGuardCtx,
  type DestinationGuardResult,
} from './destination-guards.js';

export {
  registerMultiChannelAdapter,
  type MultiChannelFactory,
  type MultiChannelRegistration,
} from './channel-multi.js';

// Channel adapter surface for plugins that build their own adapters at runtime
// (e.g. Optimus' workspace-credential-driven multi-instance Discord/Telegram).
// Hosts that just want the upstream env-singleton channels do not need these.
export {
  registerChannelAdapter,
  unregisterChannelAdapter,
  addChannelAdapterAtRuntime,
  getActiveAdapters,
  getChannelAdapter,
  getRegisteredChannelNames,
} from '../channels/channel-registry.js';
export {
  createChatSdkBridge,
  splitForLimit,
  type ChatSdkBridgeConfig,
  type ReplyContext,
  type ReplyContextExtractor,
} from '../channels/chat-sdk-bridge.js';
export type {
  ChannelAdapter,
  ChannelRegistration,
  ChannelSetup,
  InboundMessage,
  InboundEvent,
  OutboundMessage,
  ConversationInfo,
  DeliveryAddress,
} from '../channels/adapter.js';

// Support utilities for out-of-tree channel adapters (channel plugins that
// live in the embedding host rather than src/channels/). A host that ships
// its own ChannelAdapter — e.g. Optimus' WhatsApp/Baileys plugin — needs the
// same primitives the in-tree adapters use: emit lifecycle events for host
// indexers, read the channel's env block, sanitize attachment filenames, and
// normalize interactive-question options. Re-exported so the plugin imports
// them via 'nanoclaw/engine' instead of reaching into engine internals.
export { emitEngineEvent } from './events.js';
export { readEnvFile } from '../env.js';
export { isSafeAttachmentName } from '../attachment-safety.js';
export { normalizeOptions, type NormalizedOption } from '../channels/ask-question.js';

export {
  registerPluginMigrations,
  applyPluginMigrations,
  getReadDal,
  type PluginMigration,
  type ReadDal,
} from './db-extensions.js';

// Delivery adapter accessor for plugins that need to send out-of-band
// messages (pause notices, system warnings, etc.) via the same adapter
// the engine uses for normal outbound. Read-only — plugins can't replace
// the adapter, only call deliver/setTyping on it.
export { getDeliveryAdapter, type ChannelDeliveryAdapter } from '../delivery.js';

// System-action registry for plugins that handle container-emitted
// `kind: 'system'` outbound messages (e.g. escalate_to_dev_agent,
// schedule_task). The handler runs in the host with the session row
// + inbound DB handle so it can write follow-up state without the
// container touching inbound.db directly.
export { registerDeliveryAction, type DeliveryActionHandler } from '../delivery.js';

// Session DB path + open helpers + scheduling primitives for plugins that
// need to seed recurring tasks at session-creation time (e.g. Optimus'
// daily maintenance/dream task). Plugins should treat the inbound.db as
// host-owned and only insert/update task rows via insertTask — direct
// schema manipulation belongs in the engine.
export { inboundDbPath, outboundDbPath, openInboundDb } from '../session-manager.js';
export {
  insertTask,
  cancelTask,
  pauseTask,
  resumeTask,
  updateTask,
  type TaskUpdate,
} from '../modules/scheduling/db.js';

// Messaging group queries for plugins that need to enumerate which
// platforms the host owns (e.g. channel-bots driving startup-time
// recoverMissedMessages over every wired chat). Read-only — write
// surface stays inside the router/setup paths.
export { getMessagingGroup, getMessagingGroupsByChannel } from '../db/messaging-groups.js';
export type { MessagingGroup } from '../types.js';

// Session row passed to delivery-action handlers via DeliveryActionHandler's
// second arg. Re-exporting the type here so plugin handler signatures can
// declare it directly without reaching into engine internals.
export type { Session } from '../types.js';

// Cross-group sharing — host registers a resolver that, given an agent
// group (typically a DM), returns the workspace-public groups whose
// memory + identity should be RO-mounted into the spawning container.
// See shared-groups.ts for the full contract.
export { setSharedGroupsResolver, type SharedGroupsResolver, type SharedGroupRef } from '../shared-groups.js';

// ─── Migration writers (host-side seed surface) ─────────────────────────
//
// Hosts that need to seed central + per-session state from a foreign source
// (Optimus' v1 → v2 importer) reuse the same library functions migrate-v2.sh
// drives. The writer surface stays narrow — only the constructors/getters
// migrate-v2 itself touches, plus the connection + migration primitives.
// Internals like update/delete helpers stay private; if a host needs them,
// add the export deliberately here, don't widen by reaching into '../db/...'.
//
// Read-only convenience getters are co-located so an importer that reuses
// these can stay in one engine import block.

export { initDb, closeDb } from '../db/connection.js';
export { runMigrations } from '../db/migrations/index.js';
export { createAgentGroup, getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../db/agent-groups.js';
export {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupsByAgentGroup,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
export type { AgentGroup } from '../types.js';
export type { MessagingGroupAgent } from '../types.js';
export type { ContainerConfigRow } from '../types.js';

// Container-config + media-pipeline primitives for out-of-tree channel
// plugins. The WhatsApp plugin reads per-group assistant-name/prefix
// (getContainerConfig + configFromDb) for shared-number prefixing, and
// resizes/transcodes inbound media (image-processing) before handing
// attachments to the engine. image-processing also has an in-tree consumer
// (chat-sdk-bridge), so it stays in the submodule and is re-exported here.
export { getContainerConfig } from '../db/container-configs.js';
export { configFromDb, type ContainerConfig } from '../container-config.js';
export { maybeResizeImage, shouldTranscodeAnimated, maybeTranscodeAnimated } from '../media/image-processing.js';

// Session lifecycle for importers seeding cold sessions (writes routing +
// initializes per-session DBs). Hosts that want to enqueue messages into an
// existing session should keep using the higher-level router instead.
//
// Exception: `writeSessionMessage` is exposed for deep-backfill plugins
// (e.g. discord_channel_history) that need to inject historical messages
// directly with `trigger: 0`. Backfill volumes (potentially tens of
// thousands of rows) make the engine's full per-message wake/access-gate
// evaluation excessive; direct write keeps the cost linear in row count.
// The `isBackfill` flag on InboundEvent remains the safety net for the
// `adapter.onInbound → routeInbound` path where engagement evaluation
// still runs.
export { resolveSession, writeSessionMessage, writeSessionRouting } from '../session-manager.js';

// Inbound entrypoint for hosts that synthesize events from non-channel
// sources (e.g. dashboard-driven trigger fires). Constructs an
// `InboundEvent` with channelType/platformId pointing at an existing
// wired `messaging_group` and routes it through the normal router —
// sender resolution, access gate, session resolution, write, wake all
// run identically to a real chat message.
export { routeInbound } from '../router.js';
