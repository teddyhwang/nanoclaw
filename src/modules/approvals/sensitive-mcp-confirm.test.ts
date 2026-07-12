/**
 * Phase 1 — sensitive-action confirmation gate.
 *
 * Covers: confirmation_grants accessors (lifecycle, per-(session,actor)
 * key, session-clear cascade), requestConfirmation() (in-channel delivery,
 * NO pickApprover/ensureUserDm, actorId force-merged onto the row), and
 * the confirm/cancel/clicker-auth path through handleApprovalsResponse
 * (actor-keyed authorization for sensitive_mcp_confirm rows; Confirm
 * creates the grant; Cancel does not).
 *
 * container-runner + session-manager are mocked (the authorized paths
 * call wakeContainer / writeSessionMessage); a stub delivery adapter is
 * registered so requestConfirmation's card can be asserted.
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

// Fix B: the confirm handler now calls dashboard-server to replay the
// held MCP call. Mock the client so the suite is hermetic (no real
// localhost fetch) and so we can assert the engine-driven replay path.
const replayConfirmedMcpCall = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => ({
    status: 'ok',
    content: [{ type: 'text', text: 'CALENDAR-RESULT' }],
    isError: false,
  }),
);
vi.mock('./mcp-replay-client.js', () => ({
  replayConfirmedMcpCall: (...args: unknown[]) => replayConfirmedMcpCall(...args),
}));

import { createAgentGroup, closeDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  createSession,
  deleteSession,
  getPendingApproval,
  upsertConfirmationGrant,
  getConfirmationGrant,
  touchConfirmationGrant,
  deleteConfirmationGrantsForSession,
} from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import type { ResponsePayload } from '../../response-registry.js';
import { handleApprovalsResponse } from './response-handler.js';
import { requestConfirmation } from './primitive.js';
import { _resetReplayResolutionForTesting } from './replay-resolution.js';
// Import for the registration side effect (registers sensitive_mcp_confirm).
import './index.js';

function now(): string {
  return new Date().toISOString();
}

const AG = 'ag-test';
const SESSION = 'sess-test';
const MG = 'mg-test';
const ACTOR = 'discord:actor-1';
const BYSTANDER = 'discord:bystander-9';

const delivered: Array<{ channelType: string; platformId: string; body: string }> = [];

const stubAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _format, body) {
    delivered.push({ channelType, platformId, body });
    return `pmid-${delivered.length}`;
  },
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  wakeContainer.mockClear();
  writeSessionMessage.mockClear();
  _resetReplayResolutionForTesting();
  delivered.length = 0;
  setDeliveryAdapter(stubAdapter);

  createAgentGroup({ id: AG, name: 'Test', folder: 'test', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: MG,
    channel_type: 'discord',
    platform_id: 'chan-public',
    name: 'Public',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createSession({
    id: SESSION,
    agent_group_id: AG,
    messaging_group_id: MG,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: now(),
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
});

describe('confirmation_grants accessors', () => {
  it('upsert → get → touch lifecycle, per-(session,actor) keyed', () => {
    expect(getConfirmationGrant(SESSION, ACTOR)).toBeUndefined();

    const t0 = '2026-05-17T10:00:00.000Z';
    upsertConfirmationGrant(SESSION, ACTOR, t0);
    const g = getConfirmationGrant(SESSION, ACTOR);
    expect(g).toMatchObject({ session_id: SESSION, actor_id: ACTOR, granted_at: t0, last_used_at: t0 });

    // A different actor in the SAME session has no grant (no cross-user leak).
    expect(getConfirmationGrant(SESSION, BYSTANDER)).toBeUndefined();

    // touch bumps last_used_at only, NOT granted_at (hard cap unchanged).
    const t1 = '2026-05-17T10:05:00.000Z';
    touchConfirmationGrant(SESSION, ACTOR, t1);
    const g2 = getConfirmationGrant(SESSION, ACTOR);
    expect(g2?.granted_at).toBe(t0);
    expect(g2?.last_used_at).toBe(t1);

    // re-upsert (re-confirm after expiry) refreshes BOTH.
    const t2 = '2026-05-17T11:00:00.000Z';
    upsertConfirmationGrant(SESSION, ACTOR, t2);
    const g3 = getConfirmationGrant(SESSION, ACTOR);
    expect(g3?.granted_at).toBe(t2);
    expect(g3?.last_used_at).toBe(t2);
  });

  it('deleteConfirmationGrantsForSession drops only that session', () => {
    // A real second session row — confirmation_grants.session_id has a
    // FOREIGN KEY to sessions(id), which is intentional schema design.
    createSession({
      id: 'sess-other',
      agent_group_id: AG,
      messaging_group_id: MG,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: now(),
      created_at: now(),
    });
    upsertConfirmationGrant(SESSION, ACTOR, now());
    upsertConfirmationGrant('sess-other', ACTOR, now());
    deleteConfirmationGrantsForSession(SESSION);
    expect(getConfirmationGrant(SESSION, ACTOR)).toBeUndefined();
    expect(getConfirmationGrant('sess-other', ACTOR)).toBeDefined();
  });

  it('deleteSession cascades the grant drop', () => {
    upsertConfirmationGrant(SESSION, ACTOR, now());
    deleteSession(SESSION);
    expect(getConfirmationGrant(SESSION, ACTOR)).toBeUndefined();
  });
});

describe('requestConfirmation', () => {
  it('delivers the card in-channel to the originating messaging group and records actorId', async () => {
    await requestConfirmation({
      session: { id: SESSION, agent_group_id: AG, messaging_group_id: MG } as never,
      agentName: 'Test',
      action: 'sensitive_mcp_confirm',
      actorId: ACTOR,
      actorName: 'Actor',
      payload: { integration: 'google', tool: 'google_call' },
      title: 'Confirm: make Drive file public',
      question: 'Make "Q3 plan" public?',
    });

    expect(delivered).toHaveLength(1);
    // In-channel: delivered to the ORIGINATING group's channel/platform,
    // NOT a DM resolved via pickApprover/ensureUserDm.
    expect(delivered[0].channelType).toBe('discord');
    expect(delivered[0].platformId).toBe('chan-public');
    const card = JSON.parse(delivered[0].body);
    expect(card.type).toBe('ask_question');
    expect(card.options.map((o: { value: string }) => o.value)).toEqual(['confirm', 'cancel']);
    expect(card.question).toContain('Actor');

    // Row recorded with actorId force-merged onto the payload.
    const row = getPendingApproval(card.questionId);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payload)).toMatchObject({ actorId: ACTOR, integration: 'google' });
  });

  it('fails closed (notifies, no card) when the session has no originating chat', async () => {
    await requestConfirmation({
      session: { id: SESSION, agent_group_id: AG, messaging_group_id: null } as never,
      agentName: 'Test',
      action: 'sensitive_mcp_confirm',
      actorId: ACTOR,
      payload: {},
      title: 'x',
      question: 'y',
    });
    expect(delivered).toHaveLength(0);
    expect(writeSessionMessage).toHaveBeenCalled();
  });
});

describe('handleApprovalsResponse — sensitive_mcp_confirm confirm/cancel/clicker-auth', () => {
  async function seedConfirmCard(): Promise<string> {
    await requestConfirmation({
      session: { id: SESSION, agent_group_id: AG, messaging_group_id: MG } as never,
      agentName: 'Test',
      action: 'sensitive_mcp_confirm',
      actorId: ACTOR,
      payload: { integration: 'google', tool: 'google_call' },
      title: 'Confirm',
      question: 'ok?',
    });
    return JSON.parse(delivered[0].body).questionId as string;
  }

  function click(questionId: string, value: string, userId: string | null, channelType = 'discord'): ResponsePayload {
    return { questionId, value, userId, channelType, platformId: 'chan-public', threadId: null };
  }

  it('bystander Confirm is ignored, row left pending, NO grant', async () => {
    const qid = await seedConfirmCard();
    const claimed = await handleApprovalsResponse(click(qid, 'confirm', BYSTANDER));
    expect(claimed).toBe(true);
    expect(getPendingApproval(qid)).toBeDefined();
    expect(getConfirmationGrant(SESSION, ACTOR)).toBeUndefined();
    expect(getConfirmationGrant(SESSION, BYSTANDER)).toBeUndefined();
  });

  it('actor Confirm creates the (session,actor) grant and consumes the row', async () => {
    const qid = await seedConfirmCard();
    const claimed = await handleApprovalsResponse(click(qid, 'confirm', ACTOR));
    expect(claimed).toBe(true);
    expect(getPendingApproval(qid)).toBeUndefined();
    expect(getConfirmationGrant(SESSION, ACTOR)).toBeDefined();
  });

  it('actor Cancel consumes the row but creates NO grant', async () => {
    const qid = await seedConfirmCard();
    const claimed = await handleApprovalsResponse(click(qid, 'cancel', ACTOR));
    expect(claimed).toBe(true);
    expect(getPendingApproval(qid)).toBeUndefined();
    expect(getConfirmationGrant(SESSION, ACTOR)).toBeUndefined();
  });

  // ── Fix B (2026-05-18): engine-driven replay on Confirm ───────────
  async function seedConfirmCardWithGroup(): Promise<string> {
    await requestConfirmation({
      session: {
        id: SESSION,
        agent_group_id: AG,
        messaging_group_id: MG,
      } as never,
      agentName: 'Test',
      action: 'sensitive_mcp_confirm',
      actorId: ACTOR,
      // groupFolder present ⇒ the new engine-driven replay path is used.
      payload: {
        integration: 'google',
        tool: 'google_call',
        groupFolder: 'fam',
      },
      title: 'Confirm',
      question: 'ok?',
    });
    // Latest delivered card — robust when several are seeded in one
    // test (delivered[] is append-only; the Fix-B ordering tests seed
    // two). Single-seed tests are unaffected (latest === [0]).
    return JSON.parse(delivered[delivered.length - 1].body).questionId as string;
  }

  it('Fix B: Confirm replays the call engine-side and injects the REAL result (no model re-issue)', async () => {
    replayConfirmedMcpCall.mockResolvedValueOnce({
      status: 'ok',
      content: [{ type: 'text', text: 'CALENDAR-RESULT' }],
      isError: false,
    });
    const qid = await seedConfirmCardWithGroup();
    await handleApprovalsResponse(click(qid, 'confirm', ACTOR));

    // Grant still created (defense-in-depth for OTHER sensitive calls).
    expect(getConfirmationGrant(SESSION, ACTOR)).toBeDefined();
    // The replay client was called with the exact gate identity.
    expect(replayConfirmedMcpCall).toHaveBeenCalledWith({
      groupFolder: 'fam',
      integration: 'google',
      tool: 'google_call',
    });
    // The REAL tool result was injected back into the session as a
    // system message — NOT a "re-issue the call" instruction.
    const injected = writeSessionMessage.mock.calls
      .map((c) => JSON.parse((c[2] as { content: string }).content).text)
      .join('\n');
    expect(injected).toMatch(/CALENDAR-RESULT/);
    expect(injected).not.toMatch(/re-issue the call and it will go through/);
  });

  it('Fix B: replay expired (3-min TTL elapsed) → definitive non-looping message', async () => {
    replayConfirmedMcpCall.mockResolvedValueOnce({ status: 'expired' });
    const qid = await seedConfirmCardWithGroup();
    await handleApprovalsResponse(click(qid, 'confirm', ACTOR));
    const injected = writeSessionMessage.mock.calls
      .map((c) => JSON.parse((c[2] as { content: string }).content).text)
      .join('\n');
    expect(injected).toMatch(/could not be auto-completed/);
    expect(injected).toMatch(/confirmation window elapsed/);
  });

  it('Fix B: replay round-trip error → surfaces the failure, grant still on record', async () => {
    replayConfirmedMcpCall.mockResolvedValueOnce({
      status: 'error',
      message: 'dashboard unreachable',
    });
    const qid = await seedConfirmCardWithGroup();
    await handleApprovalsResponse(click(qid, 'confirm', ACTOR));
    expect(getConfirmationGrant(SESSION, ACTOR)).toBeDefined();
    const injected = writeSessionMessage.mock.calls
      .map((c) => JSON.parse((c[2] as { content: string }).content).text)
      .join('\n');
    expect(injected).toMatch(/dashboard unreachable/);
  });

  it('Fix-B ordering: a SUCCESS then a stale EXPIRED for the same call suppresses the contradictory failure note', async () => {
    // 2026-05-18 regression: a stale container returned `expired` for
    // the same call a successful fresh-container replay had just
    // delivered; both appr-notes landed and the agent answered from the
    // failure ("approval window elapsed") — the real calendar result
    // never reached the user. The success must win: the later/duplicate
    // expired handler must NOT write a contradictory failure note.
    replayConfirmedMcpCall.mockResolvedValueOnce({
      status: 'ok',
      content: [{ type: 'text', text: 'CALENDAR-RESULT' }],
      isError: false,
    });
    const qid1 = await seedConfirmCardWithGroup();
    await handleApprovalsResponse(click(qid1, 'confirm', ACTOR));

    replayConfirmedMcpCall.mockResolvedValueOnce({ status: 'expired' });
    const qid2 = await seedConfirmCardWithGroup();
    await handleApprovalsResponse(click(qid2, 'confirm', ACTOR));

    const injected = writeSessionMessage.mock.calls
      .map((c) => JSON.parse((c[2] as { content: string }).content).text)
      .join('\n');
    expect(injected).toMatch(/CALENDAR-RESULT/);
    expect(injected).not.toMatch(/confirmation window elapsed/);
    expect(injected).not.toMatch(/could not be auto-completed/);
  });

  it('Fix-B ordering: a SUCCESS then a stale ERROR for the same call suppresses the failure note', async () => {
    replayConfirmedMcpCall.mockResolvedValueOnce({
      status: 'ok',
      content: [{ type: 'text', text: 'CALENDAR-RESULT' }],
      isError: false,
    });
    const qa = await seedConfirmCardWithGroup();
    await handleApprovalsResponse(click(qa, 'confirm', ACTOR));

    replayConfirmedMcpCall.mockResolvedValueOnce({
      status: 'error',
      message: 'dashboard unreachable',
    });
    const qb = await seedConfirmCardWithGroup();
    await handleApprovalsResponse(click(qb, 'confirm', ACTOR));

    const injected = writeSessionMessage.mock.calls
      .map((c) => JSON.parse((c[2] as { content: string }).content).text)
      .join('\n');
    expect(injected).toMatch(/CALENDAR-RESULT/);
    expect(injected).not.toMatch(/dashboard unreachable/);
    expect(injected).not.toMatch(/auto-running .* failed/);
  });

  it('Fix-B ordering: `already_done` never emits a failure note (call ran elsewhere)', async () => {
    replayConfirmedMcpCall.mockResolvedValueOnce({ status: 'already_done' });
    const qid = await seedConfirmCardWithGroup();
    await handleApprovalsResponse(click(qid, 'confirm', ACTOR));
    const injected = writeSessionMessage.mock.calls
      .map((c) => JSON.parse((c[2] as { content: string }).content).text)
      .join('\n');
    expect(injected).not.toMatch(/could not be auto-completed/);
    expect(injected).not.toMatch(/failed/);
  });

  it('bystander Cancel does NOT consume the row (cannot deny the actor)', async () => {
    const qid = await seedConfirmCard();
    await handleApprovalsResponse(click(qid, 'cancel', BYSTANDER));
    expect(getPendingApproval(qid)).toBeDefined();
    expect(getConfirmationGrant(SESSION, ACTOR)).toBeUndefined();
  });

  // ── Bug C regression (2026-05-17): WhatsApp /confirm reproduction ──
  //
  // decideSensitiveGate records the card's actorId in the NAMESPACED
  // form (`whatsapp:<jid>` via namespaceActorId — confirmed in prod
  // logs). The WhatsApp slash-reply path (whatsapp-channel.ts:1429)
  // calls onAction(questionId, value, sender) with the RAW JID (no
  // `whatsapp:` prefix). Clicker-auth does a strict `userId === actorId`
  // equality, so raw `<jid>` !== `whatsapp:<jid>` → the actor's own
  // Confirm is treated as a bystander click → row left pending, NO
  // grant, agent never told → the task never executes and the next
  // request re-prompts. This is exactly the screenshot.
  const WA_NAMESPACED = 'whatsapp:159867859914790@lid';
  const WA_RAW = '159867859914790@lid';

  async function seedWaConfirmCard(): Promise<string> {
    await requestConfirmation({
      session: { id: SESSION, agent_group_id: AG, messaging_group_id: MG } as never,
      agentName: 'Test',
      action: 'sensitive_mcp_confirm',
      actorId: WA_NAMESPACED,
      payload: { integration: 'google', tool: 'google_call' },
      title: 'Confirm',
      question: 'ok?',
    });
    return JSON.parse(delivered[0].body).questionId as string;
  }

  it('Bug C regression: WhatsApp /confirm with the RAW jid grants under the NAMESPACED key', async () => {
    // The fix namespaces the clicker id (channelType:rawId) before
    // clicker-auth, so the WhatsApp raw jid authorizes against the
    // recorded namespaced actorId and the grant lands under the
    // namespaced key — exactly the key decideSensitiveGate later looks
    // up. The raw key must NOT be used (would never be found by the gate).
    const qid = await seedWaConfirmCard();
    await handleApprovalsResponse(click(qid, 'confirm', WA_RAW, 'whatsapp'));
    expect(getConfirmationGrant(SESSION, WA_NAMESPACED)).toBeDefined();
    expect(getConfirmationGrant(SESSION, WA_RAW)).toBeUndefined();
    expect(getPendingApproval(qid)).toBeUndefined();
  });

  it('FIX TARGET: clicker-auth must namespace the clicker id before comparing', async () => {
    // After the fix, the same raw-jid click MUST authorize against the
    // recorded namespaced actorId and create the grant under the
    // namespaced key (the form decideSensitiveGate later looks up).
    const qid = await seedWaConfirmCard();
    await handleApprovalsResponse(click(qid, 'confirm', WA_RAW, 'whatsapp'));
    expect(getConfirmationGrant(SESSION, WA_NAMESPACED)).toBeDefined();
    expect(getPendingApproval(qid)).toBeUndefined();
  });

  it('already-namespaced clicker (Discord button path) still works', async () => {
    const qid = await seedWaConfirmCard();
    await handleApprovalsResponse(click(qid, 'confirm', WA_NAMESPACED, 'whatsapp'));
    expect(getConfirmationGrant(SESSION, WA_NAMESPACED)).toBeDefined();
  });
});
