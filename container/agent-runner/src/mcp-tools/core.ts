/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction,
 * remove_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { getCurrentInReplyTo } from '../current-batch.js';
import { getInboundDb, getOutboundDb } from '../db/connection.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

/**
 * Resolve in_reply_to for an outbound row.
 *
 * The upstream design uses module-level `currentInReplyTo` populated by
 * poll-loop's `setCurrentInReplyTo(routing.inReplyTo)`. That works when the
 * MCP tool runs in the same process as poll-loop (upstream tests do this),
 * but the nanoclaw built-in MCP server is configured as `type: 'stdio'`
 * (see container/agent-runner/src/index.ts), so it's spawned as a SEPARATE
 * bun subprocess. Module state in that subprocess is uninitialized — every
 * `send_message` call read `null` and outbounds went out with no reply
 * pill, even though poll-loop had correctly picked a target on its side.
 *
 * Fall back to a DB query (same shape as poll-loop's `resolveDestination-
 * Thread`): the newest trigger=1 non-task inbound row for the destination's
 * channel+platform. Filters out task rows (synthetic UUIDs) and trigger=0
 * accumulate rows for the same reasons documented in poll-loop.ts.
 *
 * Task-turn guard: poll-loop computes `taskOnlyWake` (the wake's only
 * trigger rows are kind='task') and, for those turns, `extractRouting`'s
 * `pickInReplyToMessage` correctly yields null — a scheduled task fire
 * is not answering any human message, so it must post as a plain
 * message, not a reply. But that null lives in poll-loop's process
 * module state and never reaches this stdio subprocess, so the bare
 * fallback below would still hunt up the newest human @mention and
 * reply-pill the task post onto a stale, unrelated message (observed
 * 2026-05-15: an RSS status post threaded under "@Teddy try again look
 * at the cybertron docs"). The DB-visible equivalent of `taskOnlyWake`
 * is processing_ack: poll-loop marks the in-flight batch 'processing'
 * before the agent runs, so during a task-only turn every 'processing'
 * row maps to a kind='task' messages_in row. If there is no
 * 'processing' NON-task row, this turn isn't answering a chat message
 * — suppress the reply target. A task that *wants* to reply still can
 * by passing an explicit in_reply_to through the tool call (handled by
 * the caller, not this fallback).
 *
 * Module state still takes precedence when populated — keeps in-process
 * tests deterministic and lets future in-process MCP wirings short-circuit
 * the DB hop.
 */
function isTaskOnlyTurn(): boolean {
  // True when at least one row is processing AND none of the
  // currently-processing rows is a non-task inbound row. Mirrors
  // poll-loop's `triggerRows.every((m) => m.kind === 'task')`. Fails
  // open (returns false → normal reply resolution) on any error so a
  // DB hiccup can't silently strip reply pills from real chat replies.
  try {
    const out = getOutboundDb();
    const processing = out
      .prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'")
      .all() as Array<{ message_id: string }>;
    if (processing.length === 0) return false;
    const ids = processing.map((r) => r.message_id);
    const placeholders = ids.map(() => '?').join(',');
    const inb = getInboundDb();
    const nonTask = inb
      .prepare(
        `SELECT 1 AS hit FROM messages_in
         WHERE id IN (${placeholders}) AND kind != 'task' LIMIT 1`,
      )
      .get(...ids) as { hit: number } | null | undefined;
    // bun:sqlite's .get() returns null (not undefined) on no-row, so
    // test nullish, not strict undefined — getting this wrong made the
    // guard silently no-op (the original 2026-05-15 mis-fix).
    return nonTask == null;
  } catch (err) {
    log(`isTaskOnlyTurn check failed (failing open): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function resolveInReplyTo(
  channelType: string,
  platformId: string,
): string | null {
  const fromBatch = getCurrentInReplyTo();
  if (fromBatch) return fromBatch;
  // Scheduled-task fires must not inherit a stale chat reply target.
  if (isTaskOnlyTurn()) return null;
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
           AND kind != 'task' AND trigger = 1
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { id: string } | undefined;
    return row?.id ?? null;
  } catch (err) {
    log(`resolveInReplyTo DB fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing (channel +
 * thread the conversation is in) — the agent replies in place.
 *
 * If `to` is specified, look up the named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string | undefined,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  if (!to) {
    // Default: reply to whatever thread/channel this session is bound to.
    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    // No session routing (e.g., agent-shared or internal-only agent) —
    // fall back to the legacy single-destination shortcut.
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1"). Optional if you have only one destination.',
        },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (!text) return err('text is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: resolveInReplyTo(routing.channel_type, routing.platform_id),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional if you have only one destination.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    if (!filePath) return err('path is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = (args.filename as string) || path.basename(resolvedPath);

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    writeMessageOut({
      id,
      in_reply_to: resolveInReplyTo(routing.channel_type, routing.platform_id),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

export const removeReaction: McpToolDefinition = {
  tool: {
    name: 'remove_reaction',
    description:
      'Remove an emoji reaction you previously added to a message. Use the same emoji name you reacted with.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name to remove (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'remove_reaction', messageId: platformId, emoji }),
    });

    log(`remove_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction removal queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction, removeReaction]);
