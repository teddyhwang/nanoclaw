/**
 * Tests for handleApprovalsResponse clicker-authorization (Phase 0 of the
 * sensitive-action-approvals design).
 *
 * Invariant under test: a click on an approval card is only acted on when
 * the clicking user is an eligible approver for the row's agent group
 * (`pickApprover`). An unauthorized click — including one with no resolvable
 * user id, and including an unauthorized *Reject* — is ignored and the
 * pending_approvals row is LEFT PENDING so a real approver can still act and
 * a bystander cannot deny a legitimate request.
 *
 * container-runner + session-manager are mocked: the authorized paths call
 * wakeContainer / writeSessionMessage, which we don't want to exercise for
 * real in a unit test. The unauthorized path (the code added in Phase 0)
 * returns before touching either, so those assertions don't depend on the
 * mocks.
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
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { ResponsePayload } from '../../response-registry.js';
import { handleApprovalsResponse } from './response-handler.js';
import { registerApprovalHandler } from './primitive.js';

function now(): string {
  return new Date().toISOString();
}

const AG = 'ag-test';
const SESSION = 'sess-test';
const APPROVAL = 'appr-test';
const ACTION = 'test_clicker_auth';
const OWNER = 'discord:owner-1';
const BYSTANDER = 'discord:bystander-9';

let handlerCalls: number;

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  handlerCalls = 0;
  wakeContainer.mockClear();
  writeSessionMessage.mockClear();

  registerApprovalHandler(ACTION, async () => {
    handlerCalls += 1;
  });

  createAgentGroup({
    id: AG,
    name: 'Test',
    folder: 'test',
    agent_provider: null,
    created_at: now(),
  });
  createSession({
    id: SESSION,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: now(),
    created_at: now(),
  });
  // OWNER is an eligible approver (owner role, global). BYSTANDER has no role.
  createUser({ id: OWNER, kind: 'discord', display_name: 'Owner', created_at: now() });
  createUser({ id: BYSTANDER, kind: 'discord', display_name: 'Bystander', created_at: now() });
  grantRole({
    user_id: OWNER,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });

  createPendingApproval({
    approval_id: APPROVAL,
    session_id: SESSION,
    request_id: APPROVAL,
    action: ACTION,
    payload: JSON.stringify({ marker: 1 }),
    created_at: now(),
    agent_group_id: AG,
    status: 'pending',
    title: 'Test',
    options_json: '[]',
  });
});

afterEach(() => {
  closeDb();
});

function click(value: string, userId: string | null): ResponsePayload {
  return {
    questionId: APPROVAL,
    value,
    userId,
    channelType: 'discord',
    platformId: 'chan-1',
    threadId: null,
  };
}

describe('handleApprovalsResponse clicker authorization', () => {
  it('ignores an approve click from a non-approver and leaves the row pending', async () => {
    const claimed = await handleApprovalsResponse(click('approve', BYSTANDER));

    // The handler still claims the response (returns true — it owns this
    // questionId), but the registered approval handler must NOT run and the
    // row must survive for a real approver.
    expect(claimed).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(getPendingApproval(APPROVAL)).toBeDefined();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('ignores a reject click from a non-approver without consuming the row', async () => {
    const claimed = await handleApprovalsResponse(click('reject', BYSTANDER));

    expect(claimed).toBe(true);
    expect(handlerCalls).toBe(0);
    // Critical: an unauthorized Reject must not delete the row, or a
    // bystander could deny any legitimate pending request.
    expect(getPendingApproval(APPROVAL)).toBeDefined();
  });

  it('ignores a click with no resolvable user id and leaves the row pending', async () => {
    const claimed = await handleApprovalsResponse(click('approve', null));

    expect(claimed).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(getPendingApproval(APPROVAL)).toBeDefined();
  });

  it('acts on an approve click from an eligible approver and consumes the row', async () => {
    const claimed = await handleApprovalsResponse(click('approve', OWNER));

    expect(claimed).toBe(true);
    expect(handlerCalls).toBe(1);
    expect(getPendingApproval(APPROVAL)).toBeUndefined();
  });

  it('acts on a reject click from an eligible approver and consumes the row', async () => {
    const claimed = await handleApprovalsResponse(click('reject', OWNER));

    expect(claimed).toBe(true);
    // Reject does not invoke the registered handler, but it does consume
    // the row (the request was authoritatively denied by an approver).
    expect(handlerCalls).toBe(0);
    expect(getPendingApproval(APPROVAL)).toBeUndefined();
  });
});

// ── sensitive_golf_confirm: actor-keyed self-confirm (Phase 3) ──
//
// Golf booking rides the same self-confirm trust model as
// sensitive_mcp_confirm: the card is delivered IN-CHANNEL (every member
// sees it), so authorization is against the recorded payload.actorId — NOT
// pickApprover. A bystander tapping Confirm must be a no-op; only the
// triggering actor's Confirm fires the registered handler. The positive
// option is 'confirm' (not 'approve').
describe('handleApprovalsResponse — sensitive_golf_confirm actor-keyed auth', () => {
  const GOLF_APPROVAL = 'cfm-golf-test';
  const GOLF_ACTION = 'sensitive_golf_confirm';
  const ACTOR = 'discord:actor-7';
  let golfHandlerCalls: number;

  beforeEach(() => {
    golfHandlerCalls = 0;
    registerApprovalHandler(GOLF_ACTION, async () => {
      golfHandlerCalls += 1;
    });
    // ACTOR is NOT an approver (no role) — proving auth keys off actorId,
    // not pickApprover, for this action.
    createUser({ id: ACTOR, kind: 'discord', display_name: 'Actor', created_at: now() });
    createPendingApproval({
      approval_id: GOLF_APPROVAL,
      session_id: SESSION,
      request_id: GOLF_APPROVAL,
      action: GOLF_ACTION,
      payload: JSON.stringify({ actorId: ACTOR, token: 'golftok-x', booking: { index: 1 } }),
      created_at: now(),
      agent_group_id: AG,
      status: 'pending',
      title: 'Confirm golf booking',
      options_json: '[]',
    });
  });

  function golfClick(value: string, userId: string | null): ResponsePayload {
    return {
      questionId: GOLF_APPROVAL,
      value,
      userId,
      channelType: 'discord',
      platformId: 'chan-1',
      threadId: null,
    };
  }

  it('ignores a Confirm from a bystander (non-actor) and leaves the row pending', async () => {
    const claimed = await handleApprovalsResponse(golfClick('confirm', BYSTANDER));
    expect(claimed).toBe(true);
    expect(golfHandlerCalls).toBe(0);
    expect(getPendingApproval(GOLF_APPROVAL)).toBeDefined();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('ignores a Confirm even from an eligible approver who is not the actor', async () => {
    // OWNER is a global approver, but golf self-confirm authorizes against
    // actorId only — an approver who is not the actor must be a no-op.
    const claimed = await handleApprovalsResponse(golfClick('confirm', OWNER));
    expect(claimed).toBe(true);
    expect(golfHandlerCalls).toBe(0);
    expect(getPendingApproval(GOLF_APPROVAL)).toBeDefined();
  });

  it('fires the handler on the actor Confirm and consumes the row', async () => {
    const claimed = await handleApprovalsResponse(golfClick('confirm', ACTOR));
    expect(claimed).toBe(true);
    expect(golfHandlerCalls).toBe(1);
    expect(getPendingApproval(GOLF_APPROVAL)).toBeUndefined();
  });

  it('treats Cancel as the negative path: no handler, row consumed', async () => {
    const claimed = await handleApprovalsResponse(golfClick('cancel', ACTOR));
    expect(claimed).toBe(true);
    expect(golfHandlerCalls).toBe(0);
    expect(getPendingApproval(GOLF_APPROVAL)).toBeUndefined();
  });
});
