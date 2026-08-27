import { afterEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, initTestSessionDb, withInboundDb } from './connection.js';
import { SqliteAgentMailbox } from './index.js';

afterEach(() => {
  closeSessionDb();
  new SqliteAgentMailbox().resetPendingMessageSchemaCacheForTesting();
});

describe('SQLite runner mailbox canonical serialization', () => {
  test('classifies only corruption errors as requiring a fresh runner', () => {
    const mailbox = new SqliteAgentMailbox();
    expect(mailbox.shouldRestartAfter(new Error('database disk image is malformed'))).toBe(true);
    expect(mailbox.shouldRestartAfter('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(mailbox.shouldRestartAfter('file is not a database')).toBe(true);
    expect(mailbox.shouldRestartAfter('database is locked')).toBe(false);
    expect(mailbox.shouldRestartAfter('no such table: messages_in')).toBe(false);
  });

  test('round-trips full inbound and outbound lifecycle records', async () => {
    const { inbound, outbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
            platform_id, channel_type, thread_id, content, on_wake)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'in-1',
        2,
        'chat',
        '2026-01-01 00:00:00',
        'pending',
        null,
        null,
        'in-1',
        0,
        1,
        'room',
        'test',
        'thread',
        '{"text":"hello"}',
        1,
      );
    inbound
      .prepare(
        `INSERT INTO destinations
           (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('test-room', null, 'channel', 'test', 'room', null);
    outbound
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('continuation', 'token', '2026-01-01 00:00:00');

    const mailbox = new SqliteAgentMailbox();
    await mailbox.start({ agentGroupId: 'agent', sessionId: 'session', mailbox: null });
    expect(mailbox.getPendingMessages(10, true)).toEqual([
      {
        id: 'in-1',
        sequence: 2,
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        status: 'pending',
        processAfter: null,
        recurrence: null,
        seriesId: 'in-1',
        tries: 0,
        trigger: true,
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"hello"}',
        sourceSessionId: null,
        onWake: true,
      },
    ]);
    expect(mailbox.getState('continuation')).toEqual({
      value: 'token',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(mailbox.getDestinations()).toEqual([
      {
        name: 'test-room',
        displayName: null,
        type: 'channel',
        channelType: 'test',
        platformId: 'room',
        agentGroupId: null,
      },
    ]);

    for (const invalidTimeout of [-1, 1.5]) {
      mailbox.setContainerToolInFlight('Bash', invalidTimeout);
      expect(outbound.prepare('SELECT current_tool, tool_declared_timeout_ms FROM container_state').get()).toEqual({
        current_tool: 'Bash',
        tool_declared_timeout_ms: null,
      });
    }

    expect(
      await mailbox.writeMessageOut({
        id: 'out-1',
        inReplyTo: 'in-1',
        deliverAfter: '2026-01-01T00:00:01.000Z',
        recurrence: '0 * * * *',
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"reply"}',
      }),
    ).toBe(3);
    expect(mailbox.getUndeliveredMessages()).toEqual([
      {
        id: 'out-1',
        sequence: 3,
        inReplyTo: 'in-1',
        timestamp: expect.any(String),
        deliverAfter: '2026-01-01T00:00:01.000Z',
        recurrence: '0 * * * *',
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"reply"}',
      },
    ]);
  });

  test('skips malformed pending inbound rows instead of crashing the runner', () => {
    const { inbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
            platform_id, channel_type, thread_id, content, on_wake)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'bad-row',
        2,
        'not-a-kind',
        new Date().toISOString(),
        'pending',
        null,
        null,
        null,
        0,
        1,
        null,
        null,
        null,
        '{}',
        0,
      );

    const mailbox = new SqliteAgentMailbox();
    expect(mailbox.getPendingMessages(10, false)).toEqual([]);
  });
});

type TestInboundDb = ReturnType<typeof initTestSessionDb>['inbound'];

function insertInbound(
  db: TestInboundDb,
  values: {
    id: string;
    sequence: number;
    kind?: string;
    timestamp?: string;
    trigger?: 0 | 1;
    channelType?: string | null;
    platformId?: string | null;
    threadId?: string | null;
    onWake?: 0 | 1;
    content?: string;
  },
): void {
  db.prepare(
    `INSERT INTO messages_in
       (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
        platform_id, channel_type, thread_id, content, on_wake)
     VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.id,
    values.sequence,
    values.kind ?? 'chat',
    values.timestamp ?? new Date().toISOString(),
    values.id,
    values.trigger ?? 1,
    values.platformId ?? null,
    values.channelType ?? null,
    values.threadId ?? null,
    values.content ?? '{}',
    values.onWake ?? 0,
  );
}

describe('SQLite runner mailbox Optimus semantics', () => {
  test.each([
    'unable to open database file',
    'SQLITE_CANTOPEN: unable to open database file',
    'SQLITE_NOTADB: file is not a database',
  ])('classifies VirtioFS torn-open errors for runner restart: %s', (message) => {
    expect(new SqliteAgentMailbox().shouldRestartAfter(message)).toBe(true);
  });

  test.each(['SQLITE_CANTOPEN: unable to open database file', 'SQLITE_NOTADB: file is not a database'])(
    'retries the VirtioFS torn-open family before succeeding: %s',
    (message) => {
      initTestSessionDb();
      let attempts = 0;
      expect(
        withInboundDb(() => {
          attempts++;
          if (attempts === 1) throw new Error(message);
          return 'recovered';
        }),
      ).toBe('recovered');
      expect(attempts).toBe(2);
    },
  );

  test('accepts reaction inbound rows through canonical parsing', () => {
    const { inbound } = initTestSessionDb();
    insertInbound(inbound, {
      id: 'reaction-1',
      sequence: 2,
      kind: 'reaction',
      channelType: 'discord',
      platformId: 'room-a',
      content: '{"emoji":"👍","action":"add"}',
    });

    expect(new SqliteAgentMailbox().getPendingMessages(10, false)).toMatchObject([
      { id: 'reaction-1', kind: 'reaction', trigger: true },
    ]);
  });

  test('excludes system and stale accumulated rows before cap accounting', () => {
    const { inbound } = initTestSessionDb();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertInbound(inbound, { id: 'system', sequence: 2, kind: 'system' });
    insertInbound(inbound, {
      id: 'stale-context',
      sequence: 4,
      trigger: 0,
      timestamp: stale,
      channelType: 'discord',
      platformId: 'room-a',
    });
    insertInbound(inbound, {
      id: 'old-wake',
      sequence: 6,
      timestamp: stale,
      channelType: 'discord',
      platformId: 'room-a',
    });
    insertInbound(inbound, {
      id: 'fresh-context',
      sequence: 8,
      trigger: 0,
      channelType: 'discord',
      platformId: 'room-a',
    });

    expect(new SqliteAgentMailbox().getPendingMessages(2, false).map(({ id }) => id)).toEqual([
      'old-wake',
      'fresh-context',
    ]);
  });

  test('filters claims before windowing and never lets context crowd a wake row', () => {
    const { inbound } = initTestSessionDb();
    const mailbox = new SqliteAgentMailbox();
    for (let sequence = 2; sequence <= 20; sequence += 2) {
      insertInbound(inbound, { id: `claimed-${sequence}`, sequence });
    }
    mailbox.markMessages(
      Array.from({ length: 10 }, (_, index) => `claimed-${(index + 1) * 2}`),
      'processing',
    );
    for (let sequence = 22; sequence <= 44; sequence += 2) {
      insertInbound(inbound, { id: `context-${sequence}`, sequence, trigger: 0 });
    }
    insertInbound(inbound, { id: 'due-task', sequence: 46, kind: 'task' });

    const selected = mailbox.getPendingMessages(10, false).map(({ id }) => id);
    expect(selected).toContain('due-task');
    expect(selected).toHaveLength(10);
    expect(selected).not.toContain('claimed-2');
  });

  test('selects one newest chat route before cap accounting', () => {
    const { inbound } = initTestSessionDb();
    const routeA = { channelType: 'discord', platformId: 'room-a', threadId: 'thread-a' };
    const routeB = { channelType: 'discord', platformId: 'room-b', threadId: 'thread-b' };
    insertInbound(inbound, { id: 'wake-a', sequence: 2, ...routeA });
    insertInbound(inbound, { id: 'context-b-1', sequence: 4, trigger: 0, ...routeB });
    insertInbound(inbound, { id: 'context-b-2', sequence: 6, trigger: 0, ...routeB });
    insertInbound(inbound, { id: 'context-a-new-1', sequence: 8, trigger: 0, ...routeA });
    insertInbound(inbound, { id: 'context-a-new-2', sequence: 10, trigger: 0, ...routeA });
    insertInbound(inbound, { id: 'wake-b', sequence: 12, ...routeB });

    expect(new SqliteAgentMailbox().getPendingMessages(4, false).map(({ id }) => id)).toEqual([
      'context-b-1',
      'context-b-2',
      'wake-b',
    ]);
  });

  test('does not route-scope accumulated context for a task wake', () => {
    const { inbound } = initTestSessionDb();
    insertInbound(inbound, {
      id: 'context-a',
      sequence: 2,
      trigger: 0,
      channelType: 'discord',
      platformId: 'room-a',
    });
    insertInbound(inbound, {
      id: 'context-b',
      sequence: 4,
      trigger: 0,
      channelType: 'slack',
      platformId: 'room-b',
    });
    insertInbound(inbound, { id: 'task', sequence: 6, kind: 'task' });

    expect(new SqliteAgentMailbox().getPendingMessages(3, false).map(({ id }) => id)).toEqual([
      'context-a',
      'context-b',
      'task',
    ]);
  });

  test('gracefully reads a pre-on_wake schema', () => {
    const { inbound } = initTestSessionDb();
    inbound.exec('ALTER TABLE messages_in DROP COLUMN on_wake');
    const mailbox = new SqliteAgentMailbox();
    mailbox.resetPendingMessageSchemaCacheForTesting();
    inbound
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES ('legacy', 2, 'chat', ?, 'pending', 1, '{}')`,
      )
      .run(new Date().toISOString());

    expect(mailbox.getPendingMessages(10, false).map(({ id }) => id)).toEqual(['legacy']);
  });

  test('reply targets reject accumulated/undelivered rows and require delivered platform ids', async () => {
    const { inbound } = initTestSessionDb();
    const mailbox = new SqliteAgentMailbox();
    insertInbound(inbound, { id: 'ambient', sequence: 2, trigger: 0 });
    insertInbound(inbound, { id: 'trigger', sequence: 4 });

    expect(mailbox.getReplyTargetMessageIdBySeq(2)).toBeNull();
    expect(mailbox.getReplyTargetMessageIdBySeq(4)).toBe('trigger');

    const outboundSequence = await mailbox.writeMessageOut({ id: 'outbound', kind: 'chat', content: '{}' });
    expect(outboundSequence).toBe(5);
    expect(mailbox.getMessageIdBySeq(outboundSequence)).toBe('outbound');
    expect(mailbox.getReplyTargetMessageIdBySeq(outboundSequence)).toBeNull();

    inbound
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
         VALUES ('outbound', 'platform-outbound', 'failed', ?)`,
      )
      .run(new Date().toISOString());
    expect(mailbox.getReplyTargetMessageIdBySeq(outboundSequence)).toBeNull();
    inbound.prepare("UPDATE delivered SET status = 'delivered' WHERE message_out_id = 'outbound'").run();
    expect(mailbox.getReplyTargetMessageIdBySeq(outboundSequence)).toBe('platform-outbound');
  });

  test('latest inbound route excludes tasks and accumulated rows but keeps the latest eligible thread', () => {
    const { inbound } = initTestSessionDb();
    const route = { channelType: 'discord', platformId: 'room-a' };
    insertInbound(inbound, { id: 'eligible-old', sequence: 2, threadId: 'thread-old', ...route });
    insertInbound(inbound, { id: 'task-newer', sequence: 4, kind: 'task', threadId: 'thread-task', ...route });
    insertInbound(inbound, {
      id: 'ambient-newer',
      sequence: 6,
      trigger: 0,
      threadId: 'thread-ambient',
      ...route,
    });
    insertInbound(inbound, { id: 'eligible-new', sequence: 8, kind: 'reaction', threadId: 'thread-new', ...route });

    expect(new SqliteAgentMailbox().getLatestInboundRoute('discord', 'room-a')).toEqual({
      threadId: 'thread-new',
      inReplyTo: 'eligible-new',
    });
  });

  test('uses a sequence cursor for turn-scoped chat count/text/destination dedupe', async () => {
    initTestSessionDb();
    const mailbox = new SqliteAgentMailbox();
    await mailbox.writeMessageOut({ id: 'before', kind: 'chat', content: '{"text":"same"}' });
    const cursor = mailbox.getOutboundCursor();
    await mailbox.writeMessageOut({
      id: 'after',
      kind: 'chat',
      channelType: 'discord',
      platformId: 'room-a',
      content: '{"text":"hello   world"}',
    });

    expect(mailbox.countChatMessagesSince(cursor)).toBe(1);
    expect(mailbox.hasChatMessageTextSince(cursor, ' hello world ')).toBe(true);
    expect(mailbox.hasChatMessageToDestinationSince(cursor, { channelType: 'discord', platformId: 'room-a' })).toBe(
      true,
    );
    expect(mailbox.hasChatMessageToDestinationSince(cursor, { channelType: 'discord', platformId: 'room-b' })).toBe(
      false,
    );
    expect(mailbox.hasIdenticalSend('room-a', 'discord', 'hello   world')).toBe(true);
  });

  test('propagates async outbound write failures and leaves the transaction usable', async () => {
    initTestSessionDb();
    const mailbox = new SqliteAgentMailbox();
    await mailbox.writeMessageOut({ id: 'duplicate', kind: 'chat', content: '{}' });
    await expect(mailbox.writeMessageOut({ id: 'duplicate', kind: 'chat', content: '{}' })).rejects.toThrow();
    await expect(mailbox.writeMessageOut({ id: 'after-failure', kind: 'chat', content: '{}' })).resolves.toBe(3);
  });

  test('deletes state prefixes together and atomically consumes one-shot state', () => {
    initTestSessionDb();
    const mailbox = new SqliteAgentMailbox();
    mailbox.setState('continuation:claude', 'c-1');
    mailbox.setState('continuation_started_at:claude', '2026-01-01');
    mailbox.setState('continuationXstartedYat:claude', 'must-stay');
    mailbox.setState('rotation_notice', 'rotated');

    expect(mailbox.deleteStateByPrefixes(['continuation:', 'continuation_started_at:'])).toBe(2);
    expect(mailbox.getState('continuation:claude')).toBeUndefined();
    expect(mailbox.getState('continuationXstartedYat:claude')?.value).toBe('must-stay');
    expect(mailbox.consumeState('rotation_notice')?.value).toBe('rotated');
    expect(mailbox.consumeState('rotation_notice')).toBeUndefined();
  });
});
