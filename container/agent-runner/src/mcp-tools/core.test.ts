/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
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
});
