import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '../../drivers/types.js';

const mocks = vi.hoisted(() => ({
  groups: vi.fn(),
  rows: vi.fn(),
  activity: vi.fn(),
  list: vi.fn(),
  instance: vi.fn(),
}));
vi.mock('../../host-instance.js', () => ({ getHostInstanceId: mocks.instance }));
vi.mock('../../db/container-configs.js', () => ({ getContainerConfig: async () => ({ cli_scope: 'global' }) }));
vi.mock('../../db/agent-groups.js', () => ({ getAllAgentGroups: mocks.groups, getAgentGroup: vi.fn() }));
vi.mock('../../db/connection.js', () => ({ getDb: () => ({ all: mocks.rows }) }));
vi.mock('../../container-runner.js', () => ({ getHostSessionActivity: mocks.activity }));
vi.mock('../../drivers/index.js', () => ({ getSessionDriver: () => ({ listSessions: mocks.list }) }));

import { INSTALL_SLUG } from '../../config.js';
import { dispatch } from '../dispatch.js';
import './help.js';
import { readRuntimeStatus } from './runtime-status.js';

const idle = () => ({ active: [], waking: [], adopting: [] });
const group = { id: 'stanielle-id', name: 'Stanielle', folder: 'current-stanielle-folder', secret: 'DO_NOT_EXPOSE' };
const row = {
  id: 's1',
  agent_group_id: group.id,
  messaging_group_id: 'chat',
  thread_id: null,
  status: 'active',
  container_status: 'running',
};
function snapshot(sessionId = 's1', agentGroupId = group.id, phase = 'running'): SessionSnapshot {
  return {
    phase: 'running',
    handle: {
      key: { installSlug: INSTALL_SLUG, agentGroupId, sessionId },
      status: async () => ({ phase }),
    },
  } as SessionSnapshot;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.instance.mockReturnValue('actual-serving-instance');
  mocks.activity.mockImplementation(idle);
  mocks.groups.mockResolvedValue([group]);
  mocks.rows.mockResolvedValue([row]);
  mocks.list.mockResolvedValue([]);
});

describe('host-owned runtime-status', () => {
  it('enumerates all historical rows without mistaking persisted running for current runtime truth', async () => {
    mocks.rows.mockResolvedValue(
      Array.from({ length: 87 }, (_, i) => ({ ...row, id: `historical-${i}`, status: 'closed' })),
    );
    const result = await readRuntimeStatus();
    expect(result).toMatchObject({
      complete: true,
      pid: process.pid,
      instance_id: 'actual-serving-instance',
      atomic: false,
      session_gate: 'quiescent',
    });
    expect(result.sessions).toHaveLength(87);
    expect(result.sessions.every((session) => session.classification === 'not_running')).toBe(true);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledWith(INSTALL_SLUG);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
    expect(result.registry).toEqual([{ id: group.id, name: 'Stanielle', folder: group.folder }]);
    expect(result.registry.some((identity) => identity.name === 'Danielle')).toBe(false);
  });

  it('reports driver truth even without host tracking; never calls it idle', async () => {
    mocks.list.mockResolvedValue([snapshot()]);
    expect(await readRuntimeStatus()).toMatchObject({
      complete: true,
      session_gate: 'occupied',
      sessions: [{ classification: 'running', registry_identity: { id: group.id, name: 'Stanielle' } }],
    });
  });

  it('includes host waking/adoption work even when the driver list is empty', async () => {
    mocks.activity.mockReturnValue({ ...idle(), waking: ['s1'], adopting: ['adopting-without-row'] });
    const result = await readRuntimeStatus();
    expect(result.sessions.map((session) => session.session_id)).toEqual(['adopting-without-row', 's1']);
    expect(result.sessions.every((session) => session.classification === 'starting')).toBe(true);
    expect(result).toMatchObject({ complete: false, session_gate: 'unknown', problems: ['host_identity_unresolved'] });
  });

  it('refuses empty-list idle when the serving host still tracks a runtime', async () => {
    mocks.activity.mockReturnValue({ ...idle(), active: [{ session_id: 's1', agent_group_id: group.id }] });
    expect(await readRuntimeStatus()).toMatchObject({
      complete: false,
      session_gate: 'unknown',
      problems: ['host_runtime_disagreement'],
      sessions: [{ classification: 'unknown' }],
    });
  });

  it('flags a failed driver read and never exposes the raw exception', async () => {
    mocks.list.mockRejectedValue(new Error('DO_NOT_EXPOSE'));
    const result = await readRuntimeStatus();
    expect(result).toMatchObject({
      complete: false,
      session_gate: 'unknown',
      problems: ['runtime_list_failed'],
      sessions: [{ classification: 'unknown' }],
    });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
  });

  it('flags per-handle failures and wrong/unregistered runtime identities without guessing', async () => {
    const unknown = snapshot('unknown', 'unregistered');
    unknown.handle.status = async () => {
      throw new Error('DO_NOT_EXPOSE');
    };
    mocks.list.mockResolvedValue([unknown]);
    const result = await readRuntimeStatus();
    expect(result.complete).toBe(false);
    expect(result.problems).toEqual(['runtime_identity_unresolved', 'runtime_status_failed']);
    expect(result.sessions.find((session) => session.session_id === 'unknown')).toMatchObject({
      registry_identity: null,
      classification: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
  });

  it('flags inventory and host activity changes during the sampled read', async () => {
    mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([snapshot()]);
    mocks.activity.mockReturnValueOnce(idle()).mockReturnValueOnce({ ...idle(), waking: ['s1'] });
    expect(await readRuntimeStatus()).toMatchObject({
      complete: false,
      session_gate: 'unknown',
      problems: ['host_activity_changed', 'runtime_inventory_changed'],
    });
  });

  it('flags registry renames during readback rather than asserting an old name mapping', async () => {
    mocks.groups.mockResolvedValueOnce([group]).mockResolvedValueOnce([{ ...group, name: 'Changed' }]);
    expect(await readRuntimeStatus()).toMatchObject({
      complete: false,
      session_gate: 'unknown',
      problems: ['registry_changed'],
    });
  });

  it('whitelists runtime key fields and rejects foreign-install identities', async () => {
    const foreign = snapshot();
    Object.assign(foreign.handle.key, { installSlug: 'foreign-install', secret: 'DO_NOT_EXPOSE' });
    mocks.list.mockResolvedValue([foreign]);
    const result = await readRuntimeStatus();
    expect(result).toMatchObject({
      complete: false,
      session_gate: 'unknown',
      problems: ['runtime_identity_unresolved'],
    });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
  });

  it('fails closed on stable listed-running/per-handle-stopped contradiction, comparing coarse phases', async () => {
    mocks.list.mockResolvedValue([snapshot('s1', group.id, 'stopped')]);
    expect(await readRuntimeStatus()).toMatchObject({
      complete: false,
      session_gate: 'unknown',
      problems: ['runtime_phase_disagreement'],
      sessions: [
        {
          classification: 'unknown',
          runtimes: [{ listed_phase: 'running', phase: 'stopped', phase_consistent: false }],
        },
      ],
    });
    const compatible = snapshot('s1', group.id, 'preparing');
    compatible.phase = 'starting';
    mocks.list.mockResolvedValue([compatible]);
    expect(await readRuntimeStatus()).toMatchObject({
      complete: true,
      session_gate: 'occupied',
      sessions: [{ classification: 'starting' }],
    });
  });

  it('rejects registered host-group B when persisted/runtime identity is group A, without choosing either', async () => {
    const other = { id: 'other', name: 'Other', folder: 'other-folder' };
    mocks.groups.mockResolvedValue([group, other]);
    mocks.list.mockResolvedValue([snapshot()]);
    mocks.activity.mockReturnValue({ ...idle(), active: [{ session_id: 's1', agent_group_id: other.id }] });
    const result = await readRuntimeStatus();
    expect(result).toMatchObject({
      complete: false,
      session_gate: 'unknown',
      sessions: [{ classification: 'unknown', registry_identity: null }],
    });
    expect(result.problems).toContain('session_identity_disagreement');
  });

  it('sanitizes initial registry, session DB and registry-recheck failures into incomplete host responses', async () => {
    const cases = [
      {
        problem: 'registry_read_failed',
        fail: () => {
          mocks.groups.mockRejectedValueOnce(new Error('DO_NOT_EXPOSE'));
        },
      },
      {
        problem: 'session_read_failed',
        fail: () => {
          mocks.rows.mockRejectedValueOnce(new Error('DO_NOT_EXPOSE'));
        },
      },
      {
        problem: 'registry_recheck_failed',
        fail: () => {
          mocks.groups.mockResolvedValueOnce([group]).mockRejectedValueOnce(new Error('DO_NOT_EXPOSE'));
        },
      },
    ];
    for (const testCase of cases) {
      mocks.groups.mockReset().mockResolvedValue([group]);
      mocks.rows.mockReset().mockResolvedValue([row]);
      testCase.fail();
      const response = await dispatch({ id: 'failed-read', command: 'runtime-status', args: {} }, { caller: 'host' });
      expect(response).toMatchObject({
        ok: true,
        data: { complete: false, session_gate: 'unknown', problems: expect.arrayContaining([testCase.problem]) },
      });
      expect(JSON.stringify(response)).not.toContain('DO_NOT_EXPOSE');
      expect(JSON.stringify(response)).not.toContain('handler-error');
    }
  });

  it('rejects container callers before reading any cross-group identity or state', async () => {
    expect(
      await dispatch(
        { id: 'probe', command: 'runtime-status', args: {} },
        {
          caller: 'agent',
          sessionId: 's',
          agentGroupId: 'g',
          messagingGroupId: 'm',
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(mocks.groups).not.toHaveBeenCalled();
    expect(mocks.rows).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('is available to host callers but hidden from public help', async () => {
    expect(await dispatch({ id: 'probe', command: 'runtime-status', args: {} }, { caller: 'host' })).toMatchObject({
      ok: true,
      data: { complete: true },
    });
    const response = await dispatch({ id: 'help', command: 'help', args: {} }, { caller: 'host' });
    expect(response.ok && response.data).not.toContain('runtime-status');
  });
});
