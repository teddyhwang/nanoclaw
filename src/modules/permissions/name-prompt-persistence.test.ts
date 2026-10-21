/**
 * The "Create new agent" name prompt survives a host restart.
 *
 * Each `boot()` resets the module graph and reopens the same file-backed
 * central DB, so nothing held in process memory carries over: only what was
 * persisted does. That is exactly what a restart between the approver's
 * "new agent" click and their name reply looks like.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDefaults, InboundEvent } from '../../channels/adapter.js';
import type { DbDriver } from '../../db/driver.js';
import type { ResponsePayload } from '../../response-registry.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
  registerDeliveryAction: vi.fn(),
}));

vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    return getDb().get(
      `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      userId,
    );
  }),
}));

const TEST_DIR = '/tmp/nanoclaw-test-name-prompt-persistence';
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-name-prompt-persistence',
    GROUPS_DIR: '/tmp/nanoclaw-test-name-prompt-persistence/groups',
  };
});

const DB_FILE = path.join(TEST_DIR, 'central.db');
const telegramDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

interface Host {
  db: DbDriver;
  closeDb: () => Promise<void>;
  routeInbound: (event: InboundEvent) => Promise<void>;
  getResponseHandlers: () => readonly ((payload: ResponsePayload) => Promise<boolean>)[];
  passedThrough: string[];
  count: (sql: string, ...params: unknown[]) => Promise<number>;
}
let host: Host | null = null;

/** Start a fresh "process" against the persisted central DB. */
async function boot(): Promise<Host> {
  if (host) await host.closeDb();
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  const db = await conn.initDb(DB_FILE, { role: 'test' });
  const { runMigrations } = await import('../../db/migrations/index.js');
  await runMigrations(db);
  const { registerChannelAdapter } = await import('../../channels/channel-registry.js');
  registerChannelAdapter('telegram', { factory: () => null, defaults: telegramDefaults });
  await import('./index.js'); // registers the response handler + interceptor
  const { routeInbound } = await import('../../router.js');
  const { getResponseHandlers } = await import('../../response-registry.js');
  const { addMessageInterceptor } = await import('../../engine/router-hooks.js');
  // Registered after the permissions interceptor: sees only unclaimed messages.
  const passedThrough: string[] = [];
  addMessageInterceptor(async (event: InboundEvent) => {
    passedThrough.push(event.message.id);
    return false;
  });
  const count = async (sql: string, ...params: unknown[]) => (await db.get<{ c: number }>(sql, ...params))!.c;
  host = { db, closeDb: conn.closeDb, routeInbound, getResponseHandlers, passedThrough, count };
  return host;
}

const now = () => new Date().toISOString();

async function seed(h: Host) {
  const { createAgentGroup } = await import('../../db/agent-groups.js');
  const { createMessagingGroup } = await import('../../db/messaging-groups.js');
  const { upsertUser } = await import('./db/users.js');
  const { grantRole } = await import('./db/user-roles.js');
  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await h.db.run(
    'INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)',
    'telegram:owner',
    'telegram',
    'mg-dm-owner',
    now(),
  );
}

function groupMention(platformId: string) {
  return {
    channelType: 'telegram',
    platformId,
    threadId: 'thread-1',
    message: {
      id: `msg-${platformId}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text: '@bot hello' }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };
}

function ownerDm(id: string, text: string) {
  return {
    channelType: 'telegram',
    platformId: 'dm-owner',
    threadId: null,
    message: {
      id,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text }),
      timestamp: now(),
    },
  };
}

async function click(h: Host, questionId: string, value: string) {
  for (const handler of h.getResponseHandlers()) {
    const claimed = await handler({
      questionId,
      value,
      userId: 'owner',
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
    });
    if (claimed) return;
  }
  throw new Error(`no handler claimed ${value}`);
}

/** Boot, raise a channel approval and click "new agent" (name prompt open). */
async function openNamePrompt(chatId: string) {
  const h = await boot();
  await seed(h);
  await h.routeInbound(groupMention(chatId));
  await vi.waitFor(async () => expect(await h.count('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(1));
  const approval = (await h.db.get<{ messaging_group_id: string; title: string; options_json: string }>(
    'SELECT messaging_group_id, title, options_json FROM pending_channel_approvals',
  ))!;
  await click(h, approval.messaging_group_id, 'new_agent');
  expect(deliverMock.mock.calls.some((c) => String(c[4]).includes('name for your new agent'))).toBe(true);
  return approval;
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  deliverMock.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  if (host) await host.closeDb();
  host = null;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('new-agent name prompt across a restart', () => {
  it('a restart between the prompt and the reply still creates the agent from the reply', async () => {
    const approval = await openNamePrompt('chat-restart-create');

    const h = await boot(); // restart
    await h.routeInbound(ownerDm('name-after-restart', 'Newbie'));

    const created = await h.db.get<{ id: string }>("SELECT id FROM agent_groups WHERE name = 'Newbie'");
    expect(created).toBeDefined();
    expect(
      await h.count(
        'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?',
        approval.messaging_group_id,
        created!.id,
      ),
    ).toBe(1);
    expect(await h.count('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(0);
    expect(await h.count('SELECT COUNT(*) AS c FROM pending_name_inputs')).toBe(0);
    expect(h.passedThrough).not.toContain('name-after-restart');
  });

  it('cancel after a restart re-shows the choices and creates nothing', async () => {
    const approval = await openNamePrompt('chat-restart-cancel');
    const agentsBefore = await host!.count('SELECT COUNT(*) AS c FROM agent_groups');

    const h = await boot(); // restart
    deliverMock.mockClear();
    await h.routeInbound(ownerDm('cancel-after-restart', 'Cancel'));

    expect(await h.count('SELECT COUNT(*) AS c FROM agent_groups')).toBe(agentsBefore);
    expect(await h.count('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(1);
    expect(await h.count('SELECT COUNT(*) AS c FROM pending_name_inputs')).toBe(0);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [channelType, platformId, , , content] = deliverMock.mock.calls[0]!;
    expect([channelType, platformId]).toEqual(['telegram', 'dm-owner']);
    expect(JSON.parse(String(content))).toMatchObject({
      type: 'ask_question',
      questionId: approval.messaging_group_id,
      title: approval.title,
      options: JSON.parse(approval.options_json),
    });

    // Back at the choices: the next DM is ordinary chat, not a name.
    await h.routeInbound(ownerDm('after-cancel', 'Jon'));
    expect(await h.count("SELECT COUNT(*) AS c FROM agent_groups WHERE name = 'Jon'")).toBe(0);
    expect(h.passedThrough).toContain('after-cancel');
  });

  it('an expired prompt (older than 24h) captures nothing and is dropped', async () => {
    await openNamePrompt('chat-expired');
    const agentsBefore = await host!.count('SELECT COUNT(*) AS c FROM agent_groups');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 60_000);
    const h = await boot();
    await h.routeInbound(ownerDm('late-name', 'Latecomer'));

    expect(await h.count('SELECT COUNT(*) AS c FROM agent_groups')).toBe(agentsBefore);
    expect(await h.count("SELECT COUNT(*) AS c FROM agent_groups WHERE name = 'Latecomer'")).toBe(0);
    expect(await h.count('SELECT COUNT(*) AS c FROM pending_name_inputs')).toBe(0);
    expect(await h.count('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(1);
    expect(h.passedThrough).toContain('late-name');
  });

  it('a prompt whose approval was resolved captures nothing and is cleared', async () => {
    const approval = await openNamePrompt('chat-resolved');
    // The approver connects an existing agent instead of typing a name.
    await click(host!, approval.messaging_group_id, 'connect:ag-1');
    const h = host!;
    expect(await h.count('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(0);
    expect(await h.count('SELECT COUNT(*) AS c FROM pending_name_inputs')).toBe(0);

    const agentsBefore = await h.count('SELECT COUNT(*) AS c FROM agent_groups');
    await h.routeInbound(ownerDm('after-resolve', 'Ghost'));
    expect(await h.count('SELECT COUNT(*) AS c FROM agent_groups')).toBe(agentsBefore);
    expect(h.passedThrough).toContain('after-resolve');
  });

  it('deleting the approval clears its prompt (cascade)', async () => {
    const approval = await openNamePrompt('chat-deleted');
    await host!.db.run(
      'DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?',
      approval.messaging_group_id,
    );
    expect(await host!.count('SELECT COUNT(*) AS c FROM pending_name_inputs')).toBe(0);
  });

  it('startup recovery after a restart does not re-route an already-consumed name reply', async () => {
    // Retained case: the name reply is consumed live, the host restarts, and
    // startup recovery re-fetches the same platform message from the DM.
    await openNamePrompt('chat-consumed-recovery');
    await host!.routeInbound(ownerDm('name-live', 'Jon'));
    expect(await host!.count("SELECT COUNT(*) AS c FROM agent_groups WHERE name = 'Jon'")).toBe(1);
    const agentsAfterConsume = await host!.count('SELECT COUNT(*) AS c FROM agent_groups');
    const wiringsAfterConsume = await host!.count('SELECT COUNT(*) AS c FROM messaging_group_agents');
    const sessionsAfterConsume = await host!.count('SELECT COUNT(*) AS c FROM sessions');

    const h = await boot(); // restart
    await h.routeInbound(ownerDm('name-live', 'Jon')); // recovered copy
    await h.routeInbound(ownerDm('name-live', 'Jon')); // reconnect recovery again

    // Not dispatched anywhere: no interceptor saw it, no agent, wiring or session was made.
    expect(h.passedThrough).not.toContain('name-live');
    expect(await h.count('SELECT COUNT(*) AS c FROM agent_groups')).toBe(agentsAfterConsume);
    expect(await h.count('SELECT COUNT(*) AS c FROM messaging_group_agents')).toBe(wiringsAfterConsume);
    expect(await h.count('SELECT COUNT(*) AS c FROM sessions')).toBe(sessionsAfterConsume);
    expect(
      await h.count(
        "SELECT COUNT(*) AS c FROM consumed_inbound_messages WHERE message_id = 'name-live' AND consumed_by = 'new-agent-name'",
      ),
    ).toBe(1);

    // A genuinely new DM in the same chat still routes normally.
    await h.routeInbound(ownerDm('after-recovery', 'hello'));
    expect(h.passedThrough).toContain('after-recovery');
  });

  it('a reply missed during the downtime is recovered exactly once', async () => {
    await openNamePrompt('chat-unconsumed-recovery');

    const h = await boot(); // restart before the reply was ever processed
    await h.routeInbound(ownerDm('name-missed', 'Missy')); // startup recovery
    expect(await h.count("SELECT COUNT(*) AS c FROM agent_groups WHERE name = 'Missy'")).toBe(1);
    expect(h.passedThrough).not.toContain('name-missed');

    const again = await boot(); // a second restart re-fetches it too
    await again.routeInbound(ownerDm('name-missed', 'Missy'));
    expect(await again.count("SELECT COUNT(*) AS c FROM agent_groups WHERE name = 'Missy'")).toBe(1);
    expect(again.passedThrough).not.toContain('name-missed');
  });

  it('a cancel reply is not replayed as chat after a restart, and the choices stay open', async () => {
    await openNamePrompt('chat-cancel-recovery');
    await host!.routeInbound(ownerDm('cancel-live', 'Cancel'));
    expect(await host!.count('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(1);

    const h = await boot();
    deliverMock.mockClear();
    await h.routeInbound(ownerDm('cancel-live', 'Cancel'));
    expect(h.passedThrough).not.toContain('cancel-live');
    expect(deliverMock).not.toHaveBeenCalled(); // choices are not re-shown twice
    expect(await h.count('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(1);
  });

  it('a reply the stale-prompt path let through is not marked consumed', async () => {
    await openNamePrompt('chat-stale-unmarked');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 60_000);
    const h = await boot();
    await h.routeInbound(ownerDm('late-chat', 'hi'));
    expect(h.passedThrough).toContain('late-chat');
    expect(await h.count('SELECT COUNT(*) AS c FROM consumed_inbound_messages')).toBe(0);
  });

  it('a claim that loses the race records nothing', async () => {
    await openNamePrompt('chat-claim-race');
    const { getPendingNameInput, claimPendingNameInput, claimPendingNameInputWithReply } =
      await import('./db/pending-name-inputs.js');
    const prompt = (await getPendingNameInput('telegram:owner'))!;
    expect(await claimPendingNameInput(prompt)).toBe(true); // someone else took it
    expect(await claimPendingNameInputWithReply(prompt, ownerDm('loser', 'Late'))).toBe(false);
    expect(await host!.count('SELECT COUNT(*) AS c FROM consumed_inbound_messages')).toBe(0);
  });

  it('migration 027 rolls back cleanly and re-applies', async () => {
    const h = await boot();
    const { rollbackMigration027 } = await import('../../db/migrations/027-consumed-inbound-messages.js');
    await rollbackMigration027(h.db);
    expect(
      await h.count(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'consumed_inbound_messages'",
      ),
    ).toBe(0);
    const again = await boot();
    expect(
      await again.count(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'consumed_inbound_messages'",
      ),
    ).toBe(1);
  });

  it('migration 026 rolls back cleanly and re-applies', async () => {
    const h = await boot();
    const { rollbackMigration026 } = await import('../../db/migrations/026-pending-name-inputs.js');
    const tableCount = (db: Host['db']) =>
      db.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'pending_name_inputs'",
      );
    await rollbackMigration026(h.db);
    expect((await tableCount(h.db))!.c).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS c FROM schema_version WHERE name = 'pending-name-inputs'")).toBe(0);
    const again = await boot();
    expect((await tableCount(again.db))!.c).toBe(1);
  });
});
