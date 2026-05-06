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

export { setEnginePaths, getEnginePaths, type EnginePaths, type EnginePathOverrides } from './paths.js';

export {
  setCredentialProvider,
  getCredentialProvider,
  type CredentialProvider,
  type CredentialBundle,
  type CredentialContext,
} from './credentials.js';

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
  DeliveryAddress,
} from '../channels/adapter.js';

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
export { getMessagingGroupsByChannel } from '../db/messaging-groups.js';
export type { MessagingGroup } from '../types.js';
