/**
 * Phase 1 — engine-side sensitive-action gate decision.
 *
 * Covers the bridge-decides orchestrator `decideSensitiveGate()`:
 *   - fail-closed on every resolution miss (no agent group / no active
 *     session / no originating chat) — NEVER a silent allow;
 *   - actor-id namespacing matches clicker-auth (prefix only when no `:`);
 *   - live `(session, actor)` grant short-circuits to allow + bumps
 *     last_used_at; expired grant (past the 30-min hard cap) does not;
 *   - empty registry ⇒ every tool unmapped ⇒ require_confirmation, and
 *     a Confirm/Cancel card is delivered in-channel with the actor woven
 *     in and `{integration,tool,groupFolder,actorId}` on the row;
 *   - the pure policy (write/destructive any chat; pii-read public only;
 *     unmapped fail-closed) via a temporarily-seeded registry.
 *
 * container-runner + session-manager are mocked (requestConfirmation's
 * notify path can reach them); a stub delivery adapter captures the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wakeContainer = vi.fn(async (..._args: unknown[]) => {});
const writeSessionMessage = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => wakeContainer(...args),
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => writeSessionMessage(...args),
}));

import { createAgentGroup, closeDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  ensureContainerConfig,
  getSensitiveGateMode,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import { createSession, getConfirmationGrant, upsertConfirmationGrant } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import {
  decideSensitiveGate,
  namespaceActorId,
  evaluatePolicy,
  CLASSIFICATION_REGISTRY,
  HARD_TTL_MS,
} from './sensitive-gate.js';

function now(): string {
  return new Date().toISOString();
}

const AG = 'ag-gate';
const FOLDER = 'gate-folder';
const SESSION = 'sess-gate';
const MG_PUBLIC = 'mg-pub';

const delivered: Array<{ channelType: string; platformId: string; body: string }> = [];
const stubAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _format, body) {
    delivered.push({ channelType, platformId, body });
    return `pmid-${delivered.length}`;
  },
};

function seedGroupAndSession(isGroup: 0 | 1, withChat = true): void {
  createAgentGroup({ id: AG, name: 'Gate', folder: FOLDER, agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: MG_PUBLIC,
    channel_type: 'discord',
    platform_id: 'chan-x',
    name: 'C',
    is_group: isGroup,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createSession({
    id: SESSION,
    agent_group_id: AG,
    messaging_group_id: withChat ? MG_PUBLIC : null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: now(),
    created_at: now(),
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  wakeContainer.mockClear();
  writeSessionMessage.mockClear();
  delivered.length = 0;
  setDeliveryAdapter(stubAdapter);
});

afterEach(() => {
  closeDb();
  // Tests that mutate the registry restore it; belt-and-suspenders.
  for (const k of Object.keys(CLASSIFICATION_REGISTRY)) delete CLASSIFICATION_REGISTRY[k];
});

describe('namespaceActorId — must match clicker-auth', () => {
  it('prefixes channel only when the raw id has no colon', () => {
    expect(namespaceActorId('discord', '1234567890')).toBe('discord:1234567890');
    // Already-namespaced (Teams 29:xxx, channel-prefixed @lid) passes through.
    expect(namespaceActorId('teams', '29:abc')).toBe('29:abc');
    expect(namespaceActorId('whatsapp', 'whatsapp:159@lid')).toBe('whatsapp:159@lid');
  });
});

describe('evaluatePolicy — ordered rules + fail-closed', () => {
  it('unmapped tool → require_confirmation (empty registry)', () => {
    expect(evaluatePolicy({ integration: 'google', tool: 'anything', args: {}, isPublicChannel: false })).toBe(
      'require_confirmation',
    );
  });
  it('write/destructive → require_confirmation in ANY chat; read non-pii → allow; pii read public-only', () => {
    CLASSIFICATION_REGISTRY.t = {
      w: { classification: 'write' },
      d: { classification: 'destructive' },
      r: { classification: 'read' },
      rp: { classification: 'read', pii: true },
    };
    expect(evaluatePolicy({ integration: 't', tool: 'w', args: {}, isPublicChannel: false })).toBe(
      'require_confirmation',
    );
    expect(evaluatePolicy({ integration: 't', tool: 'd', args: {}, isPublicChannel: false })).toBe(
      'require_confirmation',
    );
    expect(evaluatePolicy({ integration: 't', tool: 'r', args: {}, isPublicChannel: true })).toBe('allow');
    expect(evaluatePolicy({ integration: 't', tool: 'rp', args: {}, isPublicChannel: false })).toBe('allow');
    expect(evaluatePolicy({ integration: 't', tool: 'rp', args: {}, isPublicChannel: true })).toBe(
      'require_confirmation',
    );
  });
});

describe('decideSensitiveGate — fail-closed resolution', () => {
  const base = {
    groupFolder: FOLDER,
    integration: 'google',
    tool: 'google_call',
    args: {},
    rawSenderId: '999',
  };

  it('no agent group → fail_closed, no card', async () => {
    const r = await decideSensitiveGate(base);
    expect(r.decision).toBe('fail_closed');
    expect(delivered).toHaveLength(0);
  });

  it('agent group but no active session → fail_closed', async () => {
    createAgentGroup({ id: AG, name: 'G', folder: FOLDER, agent_provider: null, created_at: now() });
    const r = await decideSensitiveGate(base);
    expect(r.decision).toBe('fail_closed');
  });

  it('session with no originating chat → fail_closed (in-channel only)', async () => {
    seedGroupAndSession(1, /* withChat */ false);
    const r = await decideSensitiveGate(base);
    expect(r.decision).toBe('fail_closed');
    expect(delivered).toHaveLength(0);
  });
});

describe('decideSensitiveGate — grant + policy path', () => {
  const base = {
    groupFolder: FOLDER,
    integration: 'google',
    tool: 'google_call',
    args: {},
    rawSenderId: '777',
    senderDisplayName: 'Actor',
  };

  it('unmapped tool, no grant → confirm + in-channel card with actor + row payload', async () => {
    seedGroupAndSession(1);
    const r = await decideSensitiveGate(base);
    expect(r.decision).toBe('confirm');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].channelType).toBe('discord');
    expect(delivered[0].platformId).toBe('chan-x');
    const card = JSON.parse(delivered[0].body);
    expect(card.type).toBe('ask_question');
    expect(card.options.map((o: { value: string }) => o.value)).toEqual(['confirm', 'cancel']);
    expect(card.question).toContain('Actor');
  });

  it('live grant → allow (live_grant), no card, last_used_at bumped', async () => {
    seedGroupAndSession(1);
    const actorId = namespaceActorId('discord', '777'); // discord:777
    const t0 = new Date(Date.now() - 60_000).toISOString();
    upsertConfirmationGrant(SESSION, actorId, t0);
    const r = await decideSensitiveGate(base);
    expect(r).toEqual({ decision: 'allow', reason: 'live_grant' });
    expect(delivered).toHaveLength(0);
    const g = getConfirmationGrant(SESSION, actorId);
    expect(g!.granted_at).toBe(t0); // hard cap unchanged
    expect(Date.parse(g!.last_used_at)).toBeGreaterThan(Date.parse(t0)); // bumped
  });

  it('grant past the 30-min hard cap → not live → confirm (re-prompts)', async () => {
    seedGroupAndSession(1);
    const actorId = namespaceActorId('discord', '777');
    const stale = new Date(Date.now() - HARD_TTL_MS - 1000).toISOString();
    upsertConfirmationGrant(SESSION, actorId, stale);
    const r = await decideSensitiveGate(base);
    expect(r.decision).toBe('confirm');
    expect(delivered).toHaveLength(1);
  });

  it('mapped allow tool, no grant → allow (policy_allow), no card', async () => {
    seedGroupAndSession(0); // private chat
    CLASSIFICATION_REGISTRY.google = { google_call: { classification: 'read' } };
    const r = await decideSensitiveGate(base);
    expect(r).toEqual({ decision: 'allow', reason: 'policy_allow' });
    expect(delivered).toHaveLength(0);
  });
});

describe('Phase 5 — admin-controlled per-agent gate disable', () => {
  const base = {
    groupFolder: FOLDER,
    integration: 'google',
    tool: 'google_call', // unmapped ⇒ would normally require_confirmation
    args: {},
    rawSenderId: '777',
    senderDisplayName: 'Actor',
  };

  it('getSensitiveGateMode: no config row ⇒ enforce (fail-safe)', () => {
    seedGroupAndSession(1);
    expect(getSensitiveGateMode(AG)).toBe('enforce');
  });

  it('getSensitiveGateMode: NULL column ⇒ enforce; explicit enforce ⇒ enforce', () => {
    seedGroupAndSession(1);
    ensureContainerConfig(AG); // row exists, sensitive_gate_mode NULL
    expect(getSensitiveGateMode(AG)).toBe('enforce');
    updateContainerConfigScalars(AG, { sensitive_gate_mode: 'enforce' });
    expect(getSensitiveGateMode(AG)).toBe('enforce');
  });

  it('getSensitiveGateMode: any junk value ⇒ enforce (only literal "off" disables)', () => {
    seedGroupAndSession(1);
    ensureContainerConfig(AG);
    // Simulate a bad/legacy value sneaking in — must still fail safe.
    updateContainerConfigScalars(AG, {
      sensitive_gate_mode: 'disabled' as unknown as 'off',
    });
    expect(getSensitiveGateMode(AG)).toBe('enforce');
  });

  it('mode unset ⇒ gate still runs (unmapped tool ⇒ confirm + card)', async () => {
    seedGroupAndSession(1);
    const r = await decideSensitiveGate(base);
    expect(r.decision).toBe('confirm');
    expect(delivered).toHaveLength(1);
  });

  it('mode "off" ⇒ allow with reason gate_disabled_by_admin, BEFORE policy, no card', async () => {
    seedGroupAndSession(1);
    ensureContainerConfig(AG);
    updateContainerConfigScalars(AG, { sensitive_gate_mode: 'off' });
    // Tool is unmapped — without the bypass this is a guaranteed confirm.
    const r = await decideSensitiveGate(base);
    expect(r).toEqual({ decision: 'allow', reason: 'gate_disabled_by_admin' });
    expect(delivered).toHaveLength(0); // short-circuited before requestConfirmation
  });

  it('mode "off" short-circuits even a write-classified tool (before policy eval)', async () => {
    seedGroupAndSession(1); // public channel — a write here would always confirm
    CLASSIFICATION_REGISTRY.google = { google_call: { classification: 'write' } };
    ensureContainerConfig(AG);
    updateContainerConfigScalars(AG, { sensitive_gate_mode: 'off' });
    const r = await decideSensitiveGate(base);
    expect(r).toEqual({ decision: 'allow', reason: 'gate_disabled_by_admin' });
    expect(delivered).toHaveLength(0);
  });

  it('disable is keyed per agent group: an unresolvable folder still fail-closes', async () => {
    // No agent group seeded at all. 'off' cannot be reached because there
    // is no group to carry the setting — the resolution miss wins. Proves
    // the bypass requires a real, admin-configured group (not a forged or
    // missing folder).
    const r = await decideSensitiveGate({ ...base, groupFolder: 'no-such-folder' });
    expect(r.decision).toBe('fail_closed');
    expect(delivered).toHaveLength(0);
  });

  it('flipping "off" → "enforce" re-arms the gate on the next call', async () => {
    seedGroupAndSession(1);
    ensureContainerConfig(AG);
    updateContainerConfigScalars(AG, { sensitive_gate_mode: 'off' });
    const off = await decideSensitiveGate(base);
    expect(off).toEqual({ decision: 'allow', reason: 'gate_disabled_by_admin' });
    updateContainerConfigScalars(AG, { sensitive_gate_mode: 'enforce' });
    delivered.length = 0;
    const reenforced = await decideSensitiveGate(base);
    expect(reenforced.decision).toBe('confirm');
    expect(delivered).toHaveLength(1);
  });
});
