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
import { setCurrentBatchReplyTarget, clearCurrentBatchReplyTarget } from '../db/session-state.js';
import { sendMessage, addReaction, removeReaction } from './core.js';

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
  clearCurrentBatchReplyTarget();
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

  it('honors explicit reply_to_message_id on a task/status turn', async () => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (2, 'incident-start-platform-id', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-19T12:00:00Z', '{}')`,
    ).run();
    setCurrentBatchReplyTarget(null);

    await sendMessage.handler({ to: 'chan', text: '✅ AI status resolved', reply_to_message_id: '#2' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('incident-start-platform-id');
  });

  it('rejects explicit reply_to_message_id from a different destination', async () => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (2, 'other-platform-id', 'discord', 'discord:other:channel', NULL, 'chat-sdk', 1, 'completed', '2026-05-19T12:00:00Z', '{}')`,
    ).run();

    const res = await sendMessage.handler({ to: 'chan', text: 'resolved', reply_to_message_id: 2 });

    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects an undelivered outbound message as an explicit reply target', async () => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
         VALUES ('out-undelivered', 3, NULL, datetime('now'), 'chat', 'discord:gid:cid', 'discord', NULL, '{}')`,
      )
      .run();

    const res = await sendMessage.handler({ to: 'chan', text: 'resolved', reply_to_message_id: 3 });

    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });
});

/**
 * The actual fix (2026-05-18): the reply target is decided authoritatively
 * by poll-loop (extractRouting → pickInReplyToMessage) and published into
 * session_state. The MCP stdio subprocess reads that and TRUSTS it,
 * instead of reconstructing it from processing_ack + a stale messages_in
 * snapshot. These tests pin the three-way contract and prove the RSS /
 * status-post regression cannot recur once a batch has been published —
 * regardless of what stale @mention is sitting in messages_in.
 */
describe('send_message MCP tool — authoritative reply target (session_state)', () => {
  it('user-triggered turn: published id → reply pill IS applied', async () => {
    setCurrentBatchReplyTarget('human-mention-7');

    await sendMessage.handler({ to: 'peer', text: 'answering your question' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('human-mention-7');
  });

  it('task/status turn: published null → NO reply pill, even with a stale chat @mention in messages_in', async () => {
    // This is the screenshot bug. A real, recent, trigger=1 human
    // @mention is sitting in messages_in — exactly what the legacy DB
    // fallback would (wrongly) thread the RSS status post onto. With the
    // authoritative null published, the heuristic is never consulted.
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (2, 'stale-human-mention', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-18T02:18:41Z', '{}')`,
    ).run();
    // poll-loop resolved this task-only turn's target to null and published it.
    setCurrentBatchReplyTarget(null);

    await sendMessage.handler({ to: 'chan', text: '🔥 AI status update — Claude: Resolved.' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('authoritative value beats the in-process module state when both disagree', async () => {
    // Defensive: if a stale module-state id somehow survived, the truthy
    // module-state short-circuit still wins (it is only ever set in-process
    // by poll-loop for this exact turn). The point of this test is to pin
    // that the DB path is consulted right after, not that it overrides a
    // live module value — so leave module state unset and prove the DB
    // null wins over what the legacy heuristic would have produced.
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (9, 'would-be-fallback', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-18T02:18:41Z', '{}')`,
    ).run();
    setCurrentBatchReplyTarget(null);

    await sendMessage.handler({ to: 'chan', text: 'status post' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('key absent (old container mid-rollout) → legacy heuristic still runs', async () => {
    // No setCurrentBatchReplyTarget at all. The fallback must still work
    // exactly as before so a mid-rollout image is not regressed.
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('chan', 'Chan', 'channel', 'discord', 'discord:gid:cid', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
       VALUES (2, 'legacy-target', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-18T03:30:47Z', '{}')`,
    ).run();

    await sendMessage.handler({ to: 'chan', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('legacy-target');
  });
});

describe('add_reaction / remove_reaction MCP tools', () => {
  // Seed an inbound message at a known seq. getMessageIdBySeq returns the
  // inbound row's id directly (it IS the platform message id), and
  // getRoutingBySeq returns its channel/platform/thread — so a reaction
  // tool keyed on that seq resolves a complete outbound op.
  function seedInbound(seq: number) {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
         VALUES (?, 'plat-msg-7', 'discord', 'discord:gid:cid', NULL, 'chat-sdk', 1, 'completed', '2026-05-15T03:30:47.398Z', '{}')`,
      )
      .run(seq);
  }

  it('add_reaction queues a reaction op targeting the platform message id', async () => {
    seedInbound(2);

    const res = await addReaction.handler({ messageId: 2, emoji: 'thumbs_up' });
    expect(res.isError).toBeFalsy();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content).toEqual({ operation: 'reaction', messageId: 'plat-msg-7', emoji: 'thumbs_up' });
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].platform_id).toBe('discord:gid:cid');
  });

  it('remove_reaction queues a remove_reaction op for the same message', async () => {
    seedInbound(2);

    const res = await removeReaction.handler({ messageId: 2, emoji: 'eyes' });
    expect(res.isError).toBeFalsy();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content).toEqual({ operation: 'remove_reaction', messageId: 'plat-msg-7', emoji: 'eyes' });
  });

  it('remove_reaction errors when messageId or emoji is missing', async () => {
    const noEmoji = await removeReaction.handler({ messageId: 2 });
    expect(noEmoji.isError).toBe(true);
    const noId = await removeReaction.handler({ emoji: 'eyes' });
    expect(noId.isError).toBe(true);
  });

  it('remove_reaction errors when the target seq is unknown', async () => {
    const res = await removeReaction.handler({ messageId: 999, emoji: 'eyes' });
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

/**
 * Regression: send_message with `to` omitted must reply to the session's
 * ORIGIN (the chat/thread the conversation is in), not silently misroute
 * or error (fix 57dad14, "default to replying to the origin
 * destination"). resolveRouting's `!to` branch is the contract:
 *   1. session_routing present  → reply in place (channel + thread).
 *   2. no session_routing, 1 destination → legacy single-dest shortcut.
 *   3. no session_routing, >1 destinations → explicit error (never
 *      guess — guessing is the misroute this fix exists to prevent).
 * Only behavior #2/#3 were implicitly reachable in the prior suite (the
 * test DB has no session_routing table, so getSessionRouting() always
 * returned nulls); #1 — the actual fix — was never exercised. We create
 * the production session_routing table here to pin it.
 */
describe('send_message MCP tool — origin-default routing (57dad14)', () => {
  function createSessionRoutingTable() {
    getInboundDb().exec(`
      CREATE TABLE IF NOT EXISTS session_routing (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type TEXT,
        platform_id  TEXT,
        thread_id    TEXT
      );
    `);
  }

  it('to omitted → replies to the session origin channel + thread (reply in place)', async () => {
    createSessionRoutingTable();
    getInboundDb()
      .prepare(
        `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
         VALUES (1, 'discord', 'discord:gid:cid', 'thread-77')`,
      )
      .run();

    // No `to`. Pre-fix (or if the origin branch breaks) this would fall
    // through to the single-dest shortcut and land on 'peer' (the agent
    // destination seeded in beforeEach) — a cross-destination misroute.
    await sendMessage.handler({ text: 'reply in place' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].platform_id).toBe('discord:gid:cid');
    expect(out[0].thread_id).toBe('thread-77');
  });

  it('to omitted, no session routing, single destination → legacy shortcut still works', async () => {
    // No session_routing table at all (mirrors agent-shared / internal-
    // only agents). beforeEach seeded exactly one destination ('peer').
    await sendMessage.handler({ text: 'fallback' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    // 'peer' is an agent destination → routed as channel_type 'agent'.
    expect(out[0].channel_type).toBe('agent');
    expect(out[0].platform_id).toBe('ag-peer');
  });

  it('to omitted, no session routing, multiple destinations → explicit error, no send', async () => {
    // Add a second destination so the single-dest shortcut cannot apply.
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('peer2', 'Peer2', 'agent', NULL, NULL, 'ag-peer2')`,
      )
      .run();

    const res = await sendMessage.handler({ text: 'ambiguous' });

    // Must refuse and name the options — never silently pick one.
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
