/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getExtraSkillRoots } from './engine/skill-roots.js';
import { getSharedBaseSource, getDocsRoot, getSharedDreamSource } from './engine/composer-hooks.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { emitEngineEvent } from './engine/events.js';
import { resolveGroupDir } from './engine/paths.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { resolveSharedGroups } from './shared-groups.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** How many trailing stderr lines to retain per container for crash diagnostics. */
const STDERR_TAIL_LINES = 50;

/**
 * Classify a container exit so a genuine crash is logged loudly and tagged
 * accurately, instead of every exit being silently reported as 'idle' with
 * its stderr swallowed at debug level (the diagnostic gap that forced manual
 * `docker logs` repro during the 2026-05-16 crash-loop incidents).
 *
 * Pure so the precedence can be unit-tested without spawning a process.
 *
 * @param code     close-event exit code (null when killed by a signal)
 * @param signal   close-event signal name (null on a normal code exit)
 * @param intentional  true when the host deliberately stopped this container
 *                      (idle sweep, model/harness switch, shutdown) — such an
 *                      exit is expected, not a crash, even though it arrives
 *                      as a SIGKILL/non-zero code.
 */
export function classifyExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  intentional: boolean,
): { reason: 'idle' | 'killed' | 'crashed'; level: 'info' | 'warn' } {
  // Host-initiated stop via killContainer(): expected (idle sweep,
  // absolute-ceiling, claim-stuck, self-mod rebuild).
  if (intentional) return { reason: 'killed', level: 'info' };
  // Clean exit: the agent-runner's poll loop ended normally.
  if (code === 0) return { reason: 'idle', level: 'info' };
  // Graceful external termination. `docker stop` (the dashboard
  // model/harness-switch path `stopV2ContainersForFolder`, and any
  // orchestrator) sends SIGTERM; a container that exits on SIGTERM —
  // directly (signal) or relayed by the `docker run` client as 143
  // (128+15) — was asked to shut down, it did not crash. Crashes do not
  // arrive as SIGTERM.
  if (signal === 'SIGTERM' || code === 143) return { reason: 'killed', level: 'info' };
  // Killed by a signal we did NOT initiate and is NOT a graceful term —
  // SIGKILL/137 (OOM), SIGSEGV, SIGABRT. The EXIT:137 crash-loop shape.
  if (signal != null) return { reason: 'crashed', level: 'warn' };
  // Non-zero exit code we did not initiate — the SQLITE_CANTOPEN /
  // readSessionStats process.exit(1) shape.
  return { reason: 'crashed', level: 'warn' };
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<
  string,
  {
    process: ChildProcess;
    containerName: string;
    /** Set by killContainer so an intentional stop isn't mislabeled a crash. */
    intentionalStop: boolean;
    /** Bounded ring of the most recent stderr lines, for crash diagnostics. */
    stderrTail: string[];
  }
>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file (via the
  // engine's resolveGroupDir) and returns the config object, threaded
  // through provider resolution, buildMounts, and buildContainerArgs so
  // we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  // Engine plugin spawn contributions — extra mounts/env from plugins that
  // need per-spawn customization (per-channel auth folders, MCP token mounts,
  // workspace-specific config). Merged into the provider contribution so the
  // existing buildMounts/buildContainerArgs surface stays unchanged.
  const { collectSpawnContributions } = await import('./engine/spawn-contrib.js');
  const pluginContrib = await collectSpawnContributions({
    sessionId: session.id,
    agentGroupId: agentGroup.id,
    agentGroupFolder: agentGroup.folder,
    sessionDir: sessionDir(agentGroup.id, session.id),
    channelTypes: [],
  });
  if (pluginContrib.mounts.length > 0) {
    contribution.mounts = [...(contribution.mounts ?? []), ...pluginContrib.mounts];
  }
  if (Object.keys(pluginContrib.env).length > 0) {
    contribution.env = { ...(contribution.env ?? {}), ...pluginContrib.env };
  }

  const mounts = await buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const entry = {
    process: container,
    containerName,
    intentionalStop: false,
    stderrTail: [] as string[],
  };
  activeContainers.set(session.id, entry);
  markContainerRunning(session.id);
  emitEngineEvent('container.spawn', { sessionId: session.id, agentGroupId: agentGroup.id });

  // Optional per-container log capture. The agent-runner's own `log()`
  // calls (provider cold-start, codex app-server init, keepalive, dream
  // thread decisions) write to the container's STDOUT, which v2 otherwise
  // discards (all functional IO is via the session DB). When a host sets
  // NANOCLAW_CONTAINER_LOG_DIR, tee both streams to
  // <dir>/container-<name>.log so a stalled/empty-fire spawn can be
  // diagnosed after the fact without a live `docker logs` repro — the gap
  // that made the 2026-06-04 codex dream startup-stall un-debuggable.
  // Unset (the standalone default) ⇒ unchanged behavior.
  const containerLogDir = process.env.NANOCLAW_CONTAINER_LOG_DIR;
  let containerLogStream: fs.WriteStream | null = null;
  if (containerLogDir) {
    try {
      fs.mkdirSync(containerLogDir, { recursive: true });
      containerLogStream = fs.createWriteStream(path.join(containerLogDir, `container-${containerName}.log`), {
        flags: 'a',
      });
      containerLogStream.write(`=== spawn ${new Date().toISOString()} session=${session.id} ===\n`);
    } catch (err) {
      // A logging-setup failure must never abort the spawn.
      log.debug(`container log capture disabled: ${err instanceof Error ? err.message : String(err)}`, {
        container: agentGroup.folder,
      });
      containerLogStream = null;
    }
  }

  // Stream stderr to debug as before, but also retain a bounded tail so a
  // crash exit can log WHY the container died without a manual `docker logs`
  // repro (the 2026-05-16 diagnostic gap).
  container.stderr?.on('data', (data) => {
    containerLogStream?.write(data);
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      log.debug(line, { container: agentGroup.folder });
      entry.stderrTail.push(line);
      if (entry.stderrTail.length > STDERR_TAIL_LINES) entry.stderrTail.shift();
    }
  });

  // stdout is unused for functional IO in v2 (all IO is via session DB),
  // but it carries the agent-runner's diagnostic log() output — capture it
  // when NANOCLAW_CONTAINER_LOG_DIR is set, otherwise discard as before.
  container.stdout?.on('data', (data) => {
    containerLogStream?.write(data);
  });
  if (containerLogStream) {
    container.on('close', () => containerLogStream?.end());
  }

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code, signal) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    cleanupSeededDream(agentGroup);

    const { reason, level } = classifyExit(code, signal, entry.intentionalStop);
    if (level === 'warn') {
      // A genuine crash. Surface the exit + the retained stderr tail at WARN
      // so the cause is in the host log, not swallowed at debug.
      log.warn('Container crashed', {
        sessionId: session.id,
        agentGroup: agentGroup.name,
        containerName,
        code,
        signal,
        reason,
        stderrTail: entry.stderrTail.length ? entry.stderrTail.join('\n') : '(no stderr captured)',
      });
    } else {
      log.info('Container exited', { sessionId: session.id, code, signal, reason, containerName });
    }
    emitEngineEvent('container.stop', {
      sessionId: session.id,
      agentGroupId: agentGroup.id,
      reason,
    });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    cleanupSeededDream(agentGroup);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/**
 * Remove the per-group DREAM.md if it still matches the canonical source —
 * i.e., it's our seeded mount-target file, not genuine fallback content the
 * operator left behind. Safe to call when no canonical source is configured;
 * a non-empty divergent file is preserved as fallback.
 */
function cleanupSeededDream(agentGroup: AgentGroup): void {
  try {
    const sharedDream = getSharedDreamSource();
    if (!sharedDream || !fs.existsSync(sharedDream.hostPath)) return;
    const perGroupDream = path.join(resolveGroupDir(agentGroup), 'DREAM.md');
    if (!fs.existsSync(perGroupDream)) return;
    const canonical = fs.readFileSync(sharedDream.hostPath);
    const current = fs.readFileSync(perGroupDream);
    if (canonical.equals(current) || current.byteLength === 0) {
      fs.rmSync(perGroupDream, { force: true });
    }
  } catch (err) {
    log.warn('Failed to clean up seeded DREAM.md', {
      agentGroupId: agentGroup.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * SIGTERM→SIGKILL grace (seconds) for a reaped container that may have an
 * agent mid-turn. `docker stop -t <grace>` gives the agent-runner's SIGTERM
 * handler time to wind the current turn down cleanly (so the provider — codex
 * especially — finishes/checkpoints instead of dying mid-turn and poisoning
 * its CODEX_HOME state for the next run; see stopContainer's note). Sized to
 * cover a normal turn's tail (a tool call + final generation), not an
 * arbitrarily long turn — the absolute-ceiling reaper still bounds the worst
 * case. The agent-runner's own SIGTERM drain is capped below this so the
 * process exits before docker's SIGKILL fires in the common case.
 */
const REAP_GRACE_SEC = 12;

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  // Mark BEFORE terminating so the close handler classifies the resulting
  // SIGKILL/non-zero exit as an expected 'killed', not a 'crashed' WARN.
  entry.intentionalStop = true;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName, REAP_GRACE_SEC);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

async function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): Promise<VolumeMount[]> {
  // NANOCLAW_PROJECT_ROOT lets embedded hosts (e.g. Optimus) declare the
  // checkout root explicitly. Without it we fall back to process.cwd(),
  // which is the standalone-NanoClaw assumption — but hosts that chdir
  // away (Optimus chdirs to dataDir so channel adapters read the right
  // .env) would otherwise resolve mount sources under the data dir and
  // fail with "Module not found /app/src/index.ts".
  const projectRoot = process.env.NANOCLAW_PROJECT_ROOT
    ? path.resolve(process.env.NANOCLAW_PROJECT_ROOT)
    : process.cwd();

  // NANOCLAW_CONTAINER_SOURCE_DIR lets embedded hosts override where the
  // `container/` directory (CLAUDE.md, agent-runner/, skills/) lives —
  // standalone NanoClaw keeps it at `<projectRoot>/container/`, but
  // embedded forks like Optimus carry it inside their submodule (e.g.
  // `<projectRoot>/packages/nanoclaw/container/`). Same pattern as
  // NANOCLAW_DATA_DIR / NANOCLAW_GROUPS_DIR — env var first, projectRoot
  // default second.
  const containerSourceDir = process.env.NANOCLAW_CONTAINER_SOURCE_DIR
    ? path.resolve(process.env.NANOCLAW_CONTAINER_SOURCE_DIR)
    : path.join(projectRoot, 'container');

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig, agentGroup);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  await composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = resolveGroupDir(agentGroup);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Canonical DREAM.md — nested RO mount on top of the RW group dir, so
  // every group sees the same consolidation protocol at
  // /workspace/agent/DREAM.md without keeping a per-group copy that would
  // drift from the canonical. Hosts supply the source via
  // composer.setSharedDreamProvider; when no provider is registered the
  // mount is skipped and (if a per-group DREAM.md happens to exist on
  // disk under groupDir) the agent sees that file as a fallback.
  //
  // Docker requires the bind-mount target to exist on the host; if it
  // doesn't, Docker creates an empty file there as a side effect. That
  // empty file then sticks around in the group dir after the container
  // exits, looks like agent-authored noise, and (worse) silently becomes
  // the fallback the next time the canonical source goes missing. So we
  // pre-seed the target with the canonical content before spawn and
  // clean it up on exit if it still matches.
  const sharedDream = getSharedDreamSource();
  const perGroupDream = path.join(groupDir, 'DREAM.md');
  if (sharedDream && fs.existsSync(sharedDream.hostPath)) {
    try {
      fs.copyFileSync(sharedDream.hostPath, perGroupDream);
    } catch (err) {
      log.warn('Failed to seed per-group DREAM.md before mount', {
        groupDir,
        hostPath: sharedDream.hostPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    mounts.push({
      hostPath: sharedDream.hostPath,
      containerPath: '/workspace/agent/DREAM.md',
      readonly: true,
    });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir. Hosts can override
  // the source via composer.setSharedBaseProvider (see composer-hooks.ts);
  // when no provider is registered the default container/CLAUDE.md applies.
  const sharedBaseOverride = getSharedBaseSource();
  const sharedClaudeMd = sharedBaseOverride ? sharedBaseOverride.hostPath : path.join(containerSourceDir, 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Lazy-load docs root — optional, host-supplied. When a docsRootProvider
  // is registered the directory mounts RO at /app/docs/ so the shared base
  // can reference docs via `@/app/docs/<topic>.md` for progressive
  // disclosure. The eager kernel stays small; deep references load only
  // when the agent navigates into them.
  const docsRoot = getDocsRoot();
  if (docsRoot && fs.existsSync(docsRoot.hostPath)) {
    mounts.push({
      hostPath: fs.realpathSync(docsRoot.hostPath),
      containerPath: '/app/docs',
      readonly: true,
    });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  // Resolve symlinks: Docker Desktop on macOS does NOT follow host-side
  // symlinks when bind-mounting (the symlink itself is passed to the VM,
  // which sees nothing), so embedded forks like Optimus that point
  // `<root>/container -> packages/<sub>/container` would mount an empty
  // dir without realpath. Standalone NanoClaw is unaffected since
  // `<root>/container` is already a real dir.
  const agentRunnerSrc = fs.realpathSync(path.join(containerSourceDir, 'agent-runner', 'src'));
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(containerSourceDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: fs.realpathSync(skillsSrc), containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  // Cross-group sharing — host plugin resolves which workspace-public groups
  // this DM container's user is a member of, returns SharedGroupRef[].
  // Mount their memory + identity RO at /workspace/shared-groups/<folder>/.
  // Resolver returns [] for non-DM containers and when no host registered.
  // See packages/nanoclaw/src/shared-groups.ts.
  const sharedGroups = resolveSharedGroups(agentGroup);
  if (sharedGroups.length > 0) {
    // Docker Desktop's virtiofs cannot create a bind mountpoint inside
    // an outer bind unless the parent directory physically exists on the
    // host source. `/workspace` is bound from `<sessDir>`; if the host
    // doesn't have `<sessDir>/shared-groups/<folder>/` pre-created, runc
    // fails with `mountpoint … is outside of rootfs` when it tries to
    // place the per-file binds (IDENTITY.md, CLAUDE.md) inside the
    // not-yet-existing folder dir. Pre-create the dirs here — same shape
    // as the `outbox/` pre-create in session-manager.ts.
    const sessSharedRoot = path.join(sessDir, 'shared-groups');
    fs.mkdirSync(sessSharedRoot, { recursive: true });
    for (const shared of sharedGroups) {
      fs.mkdirSync(path.join(sessSharedRoot, shared.folder), { recursive: true });
    }
  }
  for (const shared of sharedGroups) {
    // Falls back to flat <groupsDir>/<folder> when shared.id is absent
    // or the resolver returns null — matches standalone NanoClaw layout.
    const sharedDir = resolveGroupDir({ id: shared.id ?? '', folder: shared.folder });
    const memoryPath = path.join(sharedDir, 'memory');
    if (fs.existsSync(memoryPath)) {
      mounts.push({
        hostPath: memoryPath,
        containerPath: `/workspace/shared-groups/${shared.folder}/memory`,
        readonly: true,
      });
    }
    const identityPath = path.join(sharedDir, 'IDENTITY.md');
    if (fs.existsSync(identityPath)) {
      mounts.push({
        hostPath: identityPath,
        containerPath: `/workspace/shared-groups/${shared.folder}/IDENTITY.md`,
        readonly: true,
      });
    }
    const claudeMdPath = path.join(sharedDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      mounts.push({
        hostPath: claudeMdPath,
        containerPath: `/workspace/shared-groups/${shared.folder}/CLAUDE.md`,
        readonly: true,
      });
    }
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
export function syncSkillSymlinks(
  claudeDir: string,
  containerConfig: import('./container-config.js').ContainerConfig,
  group: AgentGroup | null = null,
): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set from built-in /app/skills + extra skill roots
  // (plugin-registered). The Claude SDK only discovers skills via
  // ~/.claude/skills/ symlinks — directories merely bind-mounted into the
  // container don't surface as skills. Hosts like Optimus that ship skills
  // outside container/skills/ register them via `addSkillRoot`, and we have
  // to link those targets here too. Skipping the extra roots was an
  // invisible footgun: tools mounted, MCP servers registered, but the
  // agent's skill_listing was empty for the entire integration set, so the
  // agent had no idea those tools existed and fell through to onecli-gateway
  // / Bash for tasks the dedicated skills should have handled.
  const containerSourceDir = process.env.NANOCLAW_CONTAINER_SOURCE_DIR
    ? path.resolve(process.env.NANOCLAW_CONTAINER_SOURCE_DIR)
    : path.join(
        process.env.NANOCLAW_PROJECT_ROOT ? path.resolve(process.env.NANOCLAW_PROJECT_ROOT) : process.cwd(),
        'container',
      );
  const sharedSkillsDir = path.join(containerSourceDir, 'skills');

  // Map skill name → container path. Built-in /app/skills/<name> wins on
  // duplicate names so a host can't accidentally shadow a NanoClaw skill.
  const skillTargets = new Map<string, string>();
  if (containerConfig.skills === 'all') {
    if (fs.existsSync(sharedSkillsDir)) {
      for (const entry of fs.readdirSync(sharedSkillsDir)) {
        try {
          if (fs.statSync(path.join(sharedSkillsDir, entry)).isDirectory()) {
            skillTargets.set(entry, `/app/skills/${entry}`);
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
    for (const root of getExtraSkillRoots()) {
      if (!fs.existsSync(root.hostPath)) continue;
      for (const entry of fs.readdirSync(root.hostPath)) {
        if (skillTargets.has(entry)) continue;
        if (root.skillFilter && !root.skillFilter(entry, group)) continue;
        try {
          if (fs.statSync(path.join(root.hostPath, entry)).isDirectory()) {
            skillTargets.set(entry, `${root.containerPath}/${entry}`);
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
    // Per-group local skills + generated skills authored from inside the
    // container live under `<claudeDir>/{local-skills,generated-skills}/`.
    // The Claude SDK only discovers skills via `~/.claude/skills/` symlinks,
    // so without an entry here `local-skill-author` produces files that the
    // agent can never load on its next session — exactly the v1→v2 regression
    // that masked AI Friends' `daily-recap` (Teddy's RSS-incident exclusion
    // rule lived there). Built-in /app/skills/<name> and plugin extra-roots
    // still win on duplicate names; per-group customizations only register
    // when they don't collide.
    for (const subdir of ['local-skills', 'generated-skills']) {
      const groupSkillsRoot = path.join(claudeDir, subdir);
      if (!fs.existsSync(groupSkillsRoot)) continue;
      for (const entry of fs.readdirSync(groupSkillsRoot)) {
        if (skillTargets.has(entry)) continue;
        try {
          if (fs.statSync(path.join(groupSkillsRoot, entry)).isDirectory()) {
            // claudeDir maps to /home/node/.claude in the container, so the
            // symlink target is the in-container path.
            skillTargets.set(entry, `/home/node/.claude/${subdir}/${entry}`);
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
  } else {
    for (const skill of containerConfig.skills) {
      skillTargets.set(skill, `/app/skills/${skill}`);
    }
  }

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !skillTargets.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const [skill, target] of skillTargets) {
    const linkPath = path.join(skillsDir, skill);
    let existingTarget: string | null = null;
    try {
      existingTarget = fs.readlinkSync(linkPath);
    } catch {
      /* missing or not a symlink */
    }
    if (existingTarget === target) continue;
    if (existingTarget !== null) {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* fall through, symlink call below will surface the error */
      }
    }
    fs.symlinkSync(target, linkPath);
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Shared-groups manifest — agent-runner reads this to know which groups
  // are mounted under /workspace/shared-groups/. Empty array when no host
  // resolver registered or container is not a DM.
  const sharedGroups = resolveSharedGroups(agentGroup);
  if (sharedGroups.length > 0) {
    args.push('-e', `NANOCLAW_SHARED_GROUPS_JSON=${JSON.stringify(sharedGroups)}`);
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Plugin credential provider — if a host has registered one, layer its env
  // contributions on top before OneCLI runs. The provider is additive only
  // (extra env vars / gateway URL hints); OneCLI remains the default vault
  // flow, so standalone v2 behavior is unchanged when no provider is set.
  const { getCredentialProvider } = await import('./engine/credentials.js');
  const credProvider = getCredentialProvider();
  if (credProvider) {
    const bundle = await credProvider.resolve({ agentGroupId: agentGroup.id });
    if (bundle.env) {
      for (const [key, value] of Object.entries(bundle.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Treated as
  // a transient hard failure: if we can't wire the gateway, we don't spawn.
  // The caller (router or host-sweep) catches the throw, leaves the inbound
  // message pending, and the next sweep tick retries.
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  // OneCLI injects ANTHROPIC_API_KEY=placeholder, which the Claude SDK turns
  // into an `x-api-key` header. Anthropic prefers `x-api-key` over
  // `Authorization` when both are present, so the proxy's Bearer-token
  // injection (required for OAuth tokens, sk-ant-oat01-...) is ignored and
  // the literal "placeholder" reaches Anthropic, which rejects it with
  // `invalid x-api-key`. Swap to ANTHROPIC_AUTH_TOKEN so the SDK emits
  // `Authorization: Bearer placeholder` instead, which the proxy replaces.
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && args[i + 1] === 'ANTHROPIC_API_KEY=placeholder') {
      args[i + 1] = 'ANTHROPIC_AUTH_TOKEN=placeholder';
    }
  }
  log.info('OneCLI gateway applied', { containerName });

  // Host gateway
  args.push(...hostGatewayArgs());

  // Bypass the OneCLI HTTP proxy for internal MCP / dashboard / qmd
  // traffic. The proxy is for credential injection on outbound calls
  // to public APIs (api.anthropic.com etc); without NO_PROXY, Node's
  // undici routes ALL HTTP through it and silently breaks every MCP
  // server hosted on the embedding host. Symptom is the agent saying
  // "MCP offline" and tools mysteriously disappearing.
  args.push('-e', 'NO_PROXY=host.docker.internal,localhost,127.0.0.1');
  args.push('-e', 'no_proxy=host.docker.internal,localhost,127.0.0.1');

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  // Optimus fork: invoke the in-image wrapper that starts camofox-server
  // (and any future sidecars) before exec'ing the agent. The wrapper is
  // baked into apps/agent-runner/Dockerfile.custom and ends with the same
  // `exec bun run /app/src/index.ts` upstream uses, so signal forwarding
  // through tini is unchanged.
  args.push('-c', 'exec /app/start-with-camofox.sh');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
