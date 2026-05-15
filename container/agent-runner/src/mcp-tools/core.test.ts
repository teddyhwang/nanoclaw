/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  // Optimus fork patch: nanoclaw MCP server runs as a stdio subprocess, so
  // module-level `currentInReplyTo` set by poll-loop in the main process is
  // never visible to send_message handlers. Fall back to a DB lookup keyed
  // on the destination's channel + platform — same shape as poll-loop's
  // resolveDestinationThread, same exclusions (no task rows, no trigger=0).
  it('falls back to DB lookup when batch state is unset (cross-process gap)', async () => {
    // Seed a channel destination (the fallback only matches when the
    // destination has channel_type + platform_id) and a recent trigger=1
    // chat-sdk inbound row for that channel.
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (2, 'plat-msg-42', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-15T03:30:47.398Z', '{}')`,
    ).run();

    // No setCurrentInReplyTo — module state stays null, fallback kicks in.
    await sendMessage.handler({ to: 'chan', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('plat-msg-42');
  });

  it('DB fallback ignores task rows and trigger=0 accumulate rows', async () => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    // Newest row is a task (synthetic UUID, would be the wrong target) —
    // must be skipped.
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (4, 'task-9', 'discord', 'discord:gid:cid', NULL, 'task', 1, 'completed', '2026-05-15T03:30:50Z', '{}')`,
    ).run();
    // Older real chat — should be picked.
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (2, 'plat-msg-42', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-15T03:30:47.398Z', '{}')`,
    ).run();
    // trigger=0 accumulate row in between — must also be skipped.
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (3, 'plat-driveby', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 0, 'pending', '2026-05-15T03:30:48Z', '{}')`,
    ).run();

    await sendMessage.handler({ to: 'chan', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('plat-msg-42');
  });

  // Regression (2026-05-15): a scheduled-task fire (RSS status post) was
  // delivered as a Discord reply threaded under an unrelated stale human
  // @mention. poll-loop's taskOnlyWake → null reply target never crosses
  // into the stdio MCP subprocess, so the DB fallback re-introduced the
  // bug. isTaskOnlyTurn() reconstructs taskOnlyWake from processing_ack:
  // during a task-only turn the only 'processing' rows are kind='task'.
  function markProcessing(id: string): void {
    getOutboundDb()
      .prepare(
        "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
      )
      .run(id);
  }

  it('suppresses reply pill on a task-only turn even with a stale chat @mention present', async () => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    // A stale, completed human @mention that the bare fallback WOULD
    // wrongly reply-pill onto (this is the screenshot bug).
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (2, 'human-mention-1', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-15T03:30:47Z', '{}')`,
    ).run();
    // The RSS task row, currently firing this turn.
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (4, 'task-rss-1', 'discord', 'discord:gid:cid', NULL, 'task', 1, 'pending', '2026-05-15T16:11:00Z', '{}')`,
    ).run();
    // poll-loop marks the in-flight batch processing before the agent
    // runs; on a task-only wake only the task row is in the batch.
    markProcessing('task-rss-1');

    await sendMessage.handler({ to: 'chan', text: 'AI status update — OpenAI ...' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    // Must NOT thread under the stale human mention — plain message.
    expect(out[0].in_reply_to).toBeNull();
  });

  it('still resolves the chat target when a real chat row is processing alongside a task', async () => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (2, 'human-mention-1', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-15T03:30:47Z', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (4, 'task-rss-1', 'discord', 'discord:gid:cid', NULL, 'task', 1, 'pending', '2026-05-15T16:11:00Z', '{}')`,
    ).run();
    // A genuine chat trigger is also in-flight this turn → NOT task-only,
    // so normal reply resolution must still apply.
    markProcessing('task-rss-1');
    markProcessing('human-mention-1');

    await sendMessage.handler({ to: 'chan', text: 'answering you' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('human-mention-1');
  });

  it('no processing rows → not treated as task-only (ad-hoc fallback unchanged)', async () => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (2, 'plat-msg-42', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-15T03:30:47Z', '{}')`,
    ).run();
    // No markProcessing at all — isTaskOnlyTurn must fail open (false)
    // so the existing ad-hoc DB fallback behavior is preserved.
    await sendMessage.handler({ to: 'chan', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('plat-msg-42');
  });
});
