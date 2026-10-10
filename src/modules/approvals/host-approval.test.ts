/**
 * Host-only owner approval (no Session): exact approver, Approve/Reject only,
 * durable CAS decision, never an agent wake or reason capture. Legacy
 * null-session rows of other actions keep their existing cleanup.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { registerHostApprovalHandler, requestHostOwnerApproval } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';

vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-approval' };
});
vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn().mockResolvedValue(undefined) };
});

const TEST_DIR = '/tmp/nanoclaw-test-host-approval';
const ACTION = 'auto_escalation_host_dream_gate';
const OWNER = 'slack:owner-1';
const ID = `appr-dream-${'a'.repeat(64)}`;
const now = () => new Date().toISOString();
const handler = vi.fn(async (_ctx: unknown) => undefined);
let delivered: string[];

const ask = (over: Partial<Parameters<typeof requestHostOwnerApproval>[0]> = {}) =>
  requestHostOwnerApproval({
    approvalId: ID,
    requestId: ID,
    approverUserId: OWNER,
    action: ACTION,
    payload: { reviewId: 'review-synth-0001', bindingHash: 'b'.repeat(64) },
    title: 'Dream escalation (scoped)',
    question: 'Metadata only.',
    ...over,
  });
const click = (value: string, userId = 'owner-1') =>
  handleApprovalsResponse({
    questionId: ID,
    value,
    userId,
    channelType: 'slack',
    platformId: 'D-owner',
    threadId: null,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  for (const [id, role] of [
    [OWNER, 'owner'],
    ['slack:admin-2', 'admin'],
  ] as const) {
    await upsertUser({ id, kind: 'slack', display_name: id, created_at: now() });
    await grantRole({ user_id: id, role, agent_group_id: null, granted_by: null, granted_at: now() });
  }
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'slack',
    platform_id: 'D-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({ user_id: OWNER, channel_type: 'slack', messaging_group_id: 'mg-dm-owner', resolved_at: now() });
  delivered = [];
  setDeliveryAdapter({
    async deliver(_c, platformId, _t, _k, content) {
      delivered.push(`${platformId}|${content}`);
      return 'pm-1';
    },
  });
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('host owner approval', () => {
  it('is unavailable until the host action is registered, and only that action can be registered', async () => {
    expect(await ask()).toBe('unavailable');
    expect(await getPendingApproval(ID)).toBeUndefined();
    expect(() => registerHostApprovalHandler('create_agent', handler)).toThrow();
    registerHostApprovalHandler(ACTION, handler);
    expect(await ask({ approvalId: 'appr-1' })).toBe('unavailable');
  });

  it('delivers one Approve/Reject card to the exact owner DM; re-asking is idempotent', async () => {
    registerHostApprovalHandler(ACTION, handler);
    expect(await ask()).toBe('pending');
    expect(await ask()).toBe('pending');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/^D-owner\|/);
    const card = JSON.parse(delivered[0].split('|').slice(1).join('|')) as { options: { value: string }[] };
    expect(card.options.map((o) => o.value)).toEqual(['approve', 'reject']);
    expect(await getPendingApproval(ID)).toMatchObject({
      session_id: null,
      agent_group_id: null,
      approver_user_id: OWNER,
      status: 'pending',
    });
    // Same id, different binding or approver: never reused.
    expect(await ask({ payload: { reviewId: 'review-other' } })).toBe('unavailable');
    expect(await ask({ approverUserId: 'slack:admin-2' })).toBe('unavailable');
  });

  it('a failed delivery leaves no row and returns no transport detail', async () => {
    registerHostApprovalHandler(ACTION, handler);
    setDeliveryAdapter({
      async deliver() {
        throw new Error('SENTINEL-transport-detail');
      },
    });
    expect(await ask()).toBe('unavailable');
    expect(await getPendingApproval(ID)).toBeUndefined();
  });

  it('only the exact owner decides; admin or reason-capture clicks are inert; the decision is a one-shot CAS', async () => {
    registerHostApprovalHandler(ACTION, handler);
    await ask();
    await click('approve', 'admin-2');
    await click('reject_with_reason');
    expect(handler).not.toHaveBeenCalled();
    expect((await getPendingApproval(ID))?.status).toBe('pending');
    await click('approve');
    await click('reject');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ userId: OWNER, outcome: 'approve' });
    // Durable decision kept for crash recovery; no agent wake.
    expect((await getPendingApproval(ID))?.status).toBe('approved');
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });

  it('a throwing host handler keeps the decision and does not surface the error', async () => {
    registerHostApprovalHandler(ACTION, async () => {
      throw new Error('SENTINEL');
    });
    await ask();
    await expect(click('reject')).resolves.toBe(true);
    expect((await getPendingApproval(ID))?.status).toBe('rejected');
  });

  it('legacy null-session rows of other actions keep their existing cleanup', async () => {
    registerHostApprovalHandler(ACTION, handler);
    await createPendingApproval({
      approval_id: ID,
      request_id: ID,
      action: 'legacy_action',
      payload: '{}',
      created_at: now(),
      title: 't',
      options_json: '[]',
      approver_user_id: OWNER,
    });
    await click('approve');
    expect(await getPendingApproval(ID)).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
