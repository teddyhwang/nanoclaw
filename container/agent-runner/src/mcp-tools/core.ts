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
import { getCurrentBatchReplyTarget } from '../db/session-state.js';
import { getInboundDb, getOutboundDb } from '../db/connection.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

/**
 * Resolve in_reply_to for an outbound row.
 *
 * PRIMARY mechanism (see resolveInReplyTo): poll-loop publishes the
 * batch's already-resolved reply target into `session_state`
 * (outbound.db) via `setCurrentBatchReplyTarget`. The built-in MCP
 * server runs as a SEPARATE stdio subprocess (index.ts spawns
 * `bun run mcp-tools/index.ts`), so poll-loop's in-process
 * `setCurrentInReplyTo` module state is invisible here — the DB row is
 * the cross-process transport. That value already went through
 * `extractRouting → pickInReplyToMessage`, so it is authoritatively
 * `null` for task-only / accumulate-only turns and the triggering
 * message id for a user-addressed turn. When the key is present we
 * trust it and never reconstruct.
 *
 * `isTaskOnlyTurn()` below is the DEMOTED legacy fallback, reached only
 * when the session_state key is entirely absent (an old container image
 * mid-rollout). It reconstructs `taskOnlyWake` from processing_ack:
 * during a task-only turn the only 'processing' rows are kind='task',
 * so if there is no 'processing' NON-task row this turn isn't answering
 * a chat message and the reply target is suppressed. This heuristic
 * races poll-loop's cross-process markProcessing/markCompleted and was
 * the source of the recurring RSS/status reply-pill regression
 * (2026-05-11/15/18) precisely because it was load-bearing; it is no
 * longer the mechanism, only a safety net. Do not "improve" it — the
 * fix was to stop relying on it.
 */
function isTaskOnlyTurn(): boolean {
  // True when at least one row is processing AND none of the
  // currently-processing rows is a non-task inbound row. Mirrors
  // poll-loop's `triggerRows.every((m) => m.kind === 'task')`. Fails
  // open (returns false → normal reply resolution) on any error so a
  // DB hiccup can't silently strip reply pills from real chat replies.
  try {
    const out = getOutboundDb();
    const processing = out.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
      message_id: string;
    }>;
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

function resolveInReplyTo(channelType: string, platformId: string): string | null {
  const fromBatch = getCurrentInReplyTo();
  if (fromBatch) return fromBatch;

  // Authoritative path. poll-loop publishes the batch's resolved reply
  // target into session_state (outbound.db) precisely because this MCP
  // server runs as a separate stdio subprocess and can't see poll-loop's
  // module state. That value already went through extractRouting →
  // pickInReplyToMessage, which yields:
  //   - a triggering message id  → a real user-addressed turn: reply-pill it.
  //   - null                     → a task-only / accumulate-only turn:
  //                                 NO reply pill (this is the fix for the
  //                                 recurring RSS/status post threading onto
  //                                 a stale @mention — 2026-05-11/15/18).
  //   - undefined (key absent)   → no batch published (old container
  //                                 mid-rollout) → fall through to legacy.
  // When the key is present we TRUST it absolutely and never reconstruct —
  // the reconstruction is exactly what kept regressing.
  const published = getCurrentBatchReplyTarget();
  if (published !== undefined) return published; // string → reply; null → no pill

  // ---- Legacy fallback (key absent only) -------------------------------
  // Reached on a container that predates the session_state transport.
  // Kept intact so a mid-rollout old image still suppresses task-turn
  // pills as well as it did before; new images never get here.
  //
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
