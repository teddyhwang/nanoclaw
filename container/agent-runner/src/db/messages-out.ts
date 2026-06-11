/**
 * Outbound message operations (container side).
 *
 * Writes to outbound.db (container-owned).
 * The host polls this DB (read-only) for undelivered messages.
 */
import { getInboundDb, getOutboundDb } from './connection.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/**
 * Write a new outbound message, auto-assigning an odd seq number.
 * Container uses odd seq (1, 3, 5...), host uses even (2, 4, 6...).
 *
 * The disjoint namespace is load-bearing, not just collision avoidance:
 * seq is the agent-facing message ID returned by send_message and accepted
 * by edit_message / add_reaction, and getMessageIdBySeq() below looks up
 * by seq across BOTH tables. If inbound and outbound could share a seq,
 * the agent's "edit message #5" could resolve to the wrong row.
 */
export function writeMessageOut(msg: WriteMessageOut): number {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();

  // Read max seq from both DBs to maintain global ordering.
  // Safe: each side only reads the other DB, never writes to it.
  const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  const max = Math.max(maxOut, maxIn);
  const nextSeq = max % 2 === 0 ? max + 1 : max + 2; // next odd

  // bun:sqlite requires named parameters to be passed with the prefix character
  // in the JS object keys (better-sqlite3 auto-stripped it, bun:sqlite does not).
  outbound
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES ($id, $seq, $in_reply_to, datetime('now'), $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
    )
    .run({
      $id: msg.id,
      $seq: nextSeq,
      $in_reply_to: msg.in_reply_to ?? null,
      $deliver_after: msg.deliver_after ?? null,
      $recurrence: msg.recurrence ?? null,
      $kind: msg.kind,
      $platform_id: msg.platform_id ?? null,
      $channel_type: msg.channel_type ?? null,
      $thread_id: msg.thread_id ?? null,
      $content: msg.content,
    });

  return nextSeq;
}

/**
 * Look up a message's platform ID by seq number.
 * Searches both inbound and outbound DBs since seq spans both.
 *
 * For inbound messages, the Chat SDK message ID is already the platform message ID
 * (e.g., "6037840640:42" for Telegram).
 *
 * For outbound messages, the internal ID (msg-xxx) won't work for edits/reactions.
 * Instead, look up the platform_message_id from the delivered table (host writes this
 * after successful delivery).
 */
export function getMessageIdBySeq(seq: number): string | null {
  const inbound = getInboundDb();

  // Inbound messages: ID is already the platform message ID
  const inRow = inbound.prepare('SELECT id FROM messages_in WHERE seq = ?').get(seq) as { id: string } | undefined;
  if (inRow) return inRow.id;

  // Outbound messages: look up platform message ID from delivered table
  const outRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (!outRow) return null;

  // Check if host has stored the platform message ID after delivery
  const deliveredRow = inbound
    .prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?')
    .get(outRow.id) as { platform_message_id: string | null } | undefined;
  if (deliveredRow?.platform_message_id) return deliveredRow.platform_message_id;

  // Fallback to internal ID (edits/reactions on undelivered messages won't work)
  return outRow.id;
}

/**
 * Resolve a seq to a platform message id suitable for `in_reply_to`.
 *
 * Unlike getMessageIdBySeq(), this never falls back to the container's
 * internal outbound id. A reply pill must target a real platform message;
 * using an internal `msg-*` id makes adapters post a broken/no-op reply.
 */
export function getReplyTargetMessageIdBySeq(seq: number): string | null {
  const inbound = getInboundDb();

  const inRow = inbound.prepare('SELECT id, trigger FROM messages_in WHERE seq = ?').get(seq) as
    | { id: string; trigger: number }
    | undefined;
  if (inRow && inRow.trigger !== 1) return null;
  if (inRow) return inRow.id;

  const outRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (!outRow) return null;

  const deliveredRow = inbound
    .prepare("SELECT platform_message_id FROM delivered WHERE message_out_id = ? AND status = 'delivered'")
    .get(outRow.id) as { platform_message_id: string | null } | undefined;
  return deliveredRow?.platform_message_id ?? null;
}

/**
 * Look up the routing fields for a message by seq (for edit/reaction targeting).
 * Returns the channel_type, platform_id, thread_id of the referenced message.
 */
export function getRoutingBySeq(
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const inbound = getInboundDb();
  const inRow = inbound
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  if (inRow) return inRow;

  const outRow = getOutboundDb()
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  return outRow ?? null;
}

/** Get undelivered messages (for host polling — reads from outbound.db). */
export function getUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}

/**
 * Count `kind='chat'` outbound rows written at or after `sinceIso`.
 *
 * Used by the poll-loop's addressed-turn safety net: a turn whose only
 * deliverable was sent via an MCP tool (`send_file`, `send_message`) —
 * not a `<message>` block in the result text — produces zero parsed
 * `<message>` blocks, so the safety net would otherwise mis-fire the
 * scary "addressed turn produced no output" degraded fallback even
 * though the agent DID reply. A non-zero count here means the turn
 * already delivered something; suppress the fallback.
 *
 * `sinceIso` must be SQLite-comparable against `timestamp`, which is
 * written by `datetime('now')` (`'YYYY-MM-DD HH:MM:SS'`, UTC). Callers
 * pass a turn-start stamp from `outboundDbNow()` so the formats match.
 */
export function countChatMessagesSince(sinceIso: string): number {
  const row = getOutboundDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM messages_out
       WHERE kind = 'chat' AND timestamp >= ?`,
    )
    .get(sinceIso) as { n: number };
  return row.n;
}

function normalizeMessageText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * True when this turn already wrote the same chat text through an MCP tool.
 *
 * Some models call `send_message` and then return the same answer as final
 * output. The tool row is already in outbound.db before the runner parses the
 * final text; without this guard the same message is delivered twice.
 *
 * This intentionally uses `timestamp > sinceIso` rather than `>=`: SQLite
 * timestamps are second-granularity, and a fast follow-up turn can start in the
 * same second as the previous turn's final outbound row. Treating equality as
 * in-scope would suppress a legitimate repeated answer in the next turn.
 */
export function hasChatMessageTextSince(sinceIso: string, text: string): boolean {
  const normalized = normalizeMessageText(text);
  if (!normalized) return false;

  const rows = getOutboundDb()
    .prepare(
      `SELECT content FROM messages_out
       WHERE kind = 'chat' AND timestamp > ?`,
    )
    .all(sinceIso) as Array<{ content: string }>;

  for (const row of rows) {
    try {
      const content = JSON.parse(row.content) as { text?: unknown };
      if (typeof content.text === 'string' && normalizeMessageText(content.text) === normalized) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * True when this turn already delivered a chat message to the given
 * destination (channel_type + platform_id + thread_id), regardless of text.
 *
 * Unlike `hasChatMessageTextSince`, this matches on destination alone. It
 * exists for task turns, where the contract is "exactly one message": the
 * agent is expected to deliver its content mid-turn via `send_message` /
 * `send_file`, then end silently. Models nonetheless often append a final
 * `<message to="X">…</message>` summary/ack ("Recap sent (#29021).") to the
 * SAME destination — different text, so the exact-text dedup misses it, and
 * the channel gets a second, unwanted message (AI Friends daily recap,
 * 2026-06-10). On a task turn we suppress any final block to a destination
 * that already received a tool-sent chat row this turn.
 *
 * Uses `timestamp > sinceIso` (not `>=`) for the same second-granularity
 * reason as `hasChatMessageTextSince`.
 */
export function hasChatMessageToDestinationSince(
  sinceIso: string,
  dest: { channel_type: string; platform_id: string },
): boolean {
  const row = getOutboundDb()
    .prepare(
      `SELECT 1 FROM messages_out
       WHERE kind = 'chat' AND timestamp > ?
         AND channel_type = ? AND platform_id = ?
       LIMIT 1`,
    )
    .get(sinceIso, dest.channel_type, dest.platform_id);
  // bun:sqlite returns null (not undefined) when no row matches.
  return row != null;
}

/**
 * Current SQLite UTC timestamp string — matches `messages_out.timestamp`
 * formatting (`datetime('now')`) so `countChatMessagesSince` comparisons
 * are exact. Capture this at turn start.
 */
export function outboundDbNow(): string {
  const row = getOutboundDb().prepare("SELECT datetime('now') AS ts").get() as { ts: string };
  return row.ts;
}
