/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Always add host.docker.internal explicitly — Linux never had it
  // built-in, and Docker Desktop on macOS no longer injects it via DNS
  // for containers spawned with no port mappings (regression observed
  // 2026-05). Forcing the mapping makes it work on every platform with
  // zero downside on platforms that already have it.
  return ['--add-host=host.docker.internal:host-gateway'];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/**
 * Stop a container by name. Name is regex-validated against shell injection.
 *
 * `gracePeriodSec` is the SIGTERM→SIGKILL window passed to `docker stop -t`.
 * The default of 1s is fine for an idle container with no in-flight work, but
 * an idle-timeout reap of a container whose agent is mid-turn needs a real
 * grace window: `docker stop -t 1` sends SIGTERM, waits 1s, then SIGKILLs.
 * The codex `app-server` (and the agent-runner that drives it) cannot finish
 * or checkpoint a turn in 1s, so it dies mid-turn (exit 137) — which leaves
 * codex's CODEX_HOME turn-state with a dangling/interrupted turn that the
 * NEXT container inherits and aborts (`<turn_aborted>` on a brand-new thread),
 * producing zero output and getting re-killed: a self-perpetuating poison on
 * busy groups (Degenerates AI-Friends, 2026-06-08 — Teddy's mention batched
 * into a fresh codex thread with tokens_used=0 and never answered). Callers
 * that reap a possibly-active container pass a longer grace so the
 * agent-runner's SIGTERM handler can wind the current turn down cleanly.
 */
export function stopContainer(name: string, gracePeriodSec = 1): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  const grace = Number.isInteger(gracePeriodSec) && gracePeriodSec >= 0 ? gracePeriodSec : 1;
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t ${grace} ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
