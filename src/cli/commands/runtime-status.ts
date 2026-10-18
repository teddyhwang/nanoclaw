/* eslint-disable no-catch-all/no-catch-all -- Readback fails closed without exposing raw driver errors. */
import { realpathSync } from 'node:fs';

import { INSTALL_SLUG } from '../../config.js';
import { getHostSessionActivity } from '../../container-runner.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getSessionDriver } from '../../drivers/index.js';
import type { SessionSnapshot } from '../../drivers/types.js';
import { getHostInstanceId } from '../../host-instance.js';
import type { Session } from '../../types.js';
import { register } from '../registry.js';

type SessionIdentity = Pick<
  Session,
  'id' | 'agent_group_id' | 'messaging_group_id' | 'thread_id' | 'status' | 'container_status'
>;

const signature = (rows: SessionSnapshot[]) =>
  JSON.stringify(
    rows
      .map(({ handle, phase }) => ({ ...handle.key, phase }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );

/** Uses only this serving host's existing connection, driver and memory.
 * This is a sampled readback, NOT a lock or a claim that delivery work is idle.
 * Persisted lifecycle labels are returned separately and never prove liveness.
 */
export async function readRuntimeStatus() {
  const observedFrom = new Date().toISOString();
  const instanceId = getHostInstanceId();
  const before = getHostSessionActivity();
  const registry = (await getAllAgentGroups()).map(({ id, name, folder }) => ({ id, name, folder }));
  const persisted = await getDb().all<SessionIdentity>(
    'SELECT id, agent_group_id, messaging_group_id, thread_id, status, container_status FROM sessions ORDER BY id',
  );
  const driver = getSessionDriver();
  const problems: string[] = [];
  if (!instanceId) problems.push('host_not_ready');
  let snapshots: SessionSnapshot[] = [];
  let listed = false;
  try {
    snapshots = await driver.listSessions(INSTALL_SLUG);
    listed = true;
  } catch {
    // Driver errors can contain commands/environment: expose no raw detail.
    problems.push('runtime_list_failed');
  }
  const runtimes = await Promise.all(
    snapshots.map(async ({ handle, phase }) => {
      let currentPhase: string = 'unknown';
      try {
        currentPhase = (await handle.status()).phase;
      } catch {
        problems.push('runtime_status_failed');
      }
      const { installSlug, agentGroupId, sessionId } = handle.key;
      return { key: { installSlug, agentGroupId, sessionId }, listed_phase: phase, phase: currentPhase };
    }),
  );
  if (listed) {
    try {
      if (signature(snapshots) !== signature(await driver.listSessions(INSTALL_SLUG))) {
        problems.push('runtime_inventory_changed');
      }
    } catch {
      problems.push('runtime_recheck_failed');
    }
  }
  const registryAfter = (await getAllAgentGroups()).map(({ id, name, folder }) => ({ id, name, folder }));
  if (JSON.stringify(registry) !== JSON.stringify(registryAfter)) problems.push('registry_changed');
  const after = getHostSessionActivity();
  if (JSON.stringify(before) !== JSON.stringify(after)) problems.push('host_activity_changed');
  if (instanceId !== getHostInstanceId()) problems.push('host_instance_changed');
  for (const runtime of runtimes) {
    const row = persisted.find((session) => session.id === runtime.key.sessionId);
    if (
      runtime.key.installSlug !== INSTALL_SLUG ||
      !row ||
      row.agent_group_id !== runtime.key.agentGroupId ||
      !registry.some((group) => group.id === runtime.key.agentGroupId)
    ) {
      problems.push('runtime_identity_unresolved');
    }
  }
  const ids = [
    ...new Set([
      ...persisted.map((row) => row.id),
      ...runtimes.map((runtime) => runtime.key.sessionId),
      ...before.active.map((row) => row.session_id),
      ...after.active.map((row) => row.session_id),
      ...before.waking,
      ...after.waking,
      ...before.adopting,
      ...after.adopting,
    ]),
  ].sort();
  const sessions = ids.map((id) => {
    const row = persisted.find((session) => session.id === id);
    const live = runtimes.filter((runtime) => runtime.key.sessionId === id);
    const active = after.active.find((runtime) => runtime.session_id === id);
    const waking = after.waking.includes(id);
    const adopting = after.adopting.includes(id);
    const identity =
      registry.find(
        (group) => group.id === (active?.agent_group_id ?? live[0]?.key.agentGroupId ?? row?.agent_group_id),
      ) ?? null;
    if ((active || waking || adopting) && !identity) problems.push('host_identity_unresolved');
    if (active && !live.some((runtime) => runtime.phase === 'running')) problems.push('host_runtime_disagreement');
    // A discovered runtime with no host tracking remains occupied; never idle.
    const classification =
      waking || adopting
        ? 'starting'
        : live.some((runtime) => runtime.phase === 'running')
          ? 'running'
          : live.some((runtime) => runtime.phase === 'ready' || runtime.phase === 'preparing')
            ? 'starting'
            : active || !listed || live.some((runtime) => runtime.phase === 'unknown')
              ? 'unknown'
              : 'not_running';
    return {
      session_id: id,
      registry_identity: identity,
      persisted: row ?? null,
      host: { active: active ?? null, waking, adopting },
      runtimes: live,
      classification,
    };
  });
  const complete = problems.length === 0;
  return {
    pid: process.pid,
    started_at: new Date(performance.timeOrigin).toISOString(),
    instance_id: instanceId,
    project_root: realpathSync(process.cwd()),
    install_slug: INSTALL_SLUG,
    observed_from: observedFrom,
    observed_to: new Date().toISOString(),
    atomic: false,
    scope:
      'All persisted session identities, current registry, install runtime inventory and host active/waking/adopting sets. No message/delivery-idle assertion.',
    complete,
    problems: [...new Set(problems)].sort(),
    session_gate: !complete
      ? 'unknown'
      : sessions.some((row) => row.classification !== 'not_running')
        ? 'occupied'
        : 'quiescent',
    registry,
    sessions,
  };
}

register({
  name: 'runtime-status',
  description:
    'Read complete host-owned session inventory and current registered identities (sampled, not an idle lock).',
  access: 'hidden',
  hostOnly: true,
  parseArgs: () => ({}),
  handler: readRuntimeStatus,
});
