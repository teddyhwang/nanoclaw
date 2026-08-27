/**
 * SQL operations on per-session inbound/outbound DBs.
 *
 * These are NOT the central app DB — they're the cross-mount SQLite files
 * shared between host and container. Callers own the connection lifecycle
 * (open-write-close per op). See session-manager.ts header for invariants.
 */
import Database from 'better-sqlite3';

import { createInboundRecord } from '../model.js';
import type { InboundWrite } from '../model.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';

/** Apply the inbound or outbound schema to a DB file. Idempotent. */
export function ensureSchema(dbPath: string, schema: 'inbound' | 'outbound'): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.exec(schema === 'inbound' ? INBOUND_SCHEMA : OUTBOUND_SCHEMA);
  db.close();
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open the outbound DB for a session with write access. Only safe to call when no container is running. */
export function openOutboundDbRw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function upsertSessionRouting(
  db: Database.Database,
  routing: { channel_type: string | null; platform_id: string | null; thread_id: string | null },
): void {
  db.prepare(
    `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
     VALUES (1, @channel_type, @platform_id, @thread_id)
     ON CONFLICT(id) DO UPDATE SET
       channel_type = excluded.channel_type,
       platform_id  = excluded.platform_id,
       thread_id    = excluded.thread_id`,
  ).run(routing);
}

export interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

export function replaceDestinations(db: Database.Database, entries: DestinationRow[]): void {
  const tx = db.transaction((rows: DestinationRow[]) => {
    db.prepare('DELETE FROM destinations').run();
    const stmt = db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (@name, @display_name, @type, @channel_type, @platform_id, @agent_group_id)`,
    );
    for (const row of rows) stmt.run(row);
  });
  tx(entries);
}

// ---------------------------------------------------------------------------
// messages_in
// ---------------------------------------------------------------------------

/**
 * Next even seq number for host-owned inbound.db.
 *
 * Exported so the scheduling module's task helpers can maintain the
 * host-writes-even-seq invariant without duplicating the logic. Not part of
 * the general public API — used only by this SQLite driver.
 */
export function nextEvenSeq(db: Database.Database): number {
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
}

export function insertMessage(db: Database.Database, message: InboundWrite, sequence = nextEvenSeq(db)): void {
  const record = createInboundRecord(message, sequence);
  // Duplicate channel delivery and startup replay are idempotent by message id.
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger, source_session_id, on_wake)
     VALUES (@id, @sequence, @kind, @timestamp, @status, @platformId, @channelType, @threadId, @content, @processAfter, @recurrence, @seriesId, @trigger, @sourceSessionId, @onWake)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    ...record,
    trigger: record.trigger ? 1 : 0,
    onWake: record.onWake ? 1 : 0,
  });
}

export function countDueMessages(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM messages_in
       WHERE status = 'pending'
         AND kind != 'system'
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
      )
      .get() as { count: number }
  ).count;
}

/**
 * Enumerate the due task rows for a session. Used by host-sweep to emit
 * one `task.fired` event per due task before waking the container, so
 * plugins (e.g. per-task sender identity) can stamp pre-wake state.
 *
 * Filtered to `kind='task'` because non-task wakes (channel inbound, agent-
 * to-agent replies) don't need per-task identity. Pending + trigger=1 +
 * `process_after` elapsed mirrors `countDueMessages`.
 */
export function getDueTaskRows(db: Database.Database): { id: string; series_id: string | null; content: string }[] {
  return db
    .prepare(
      `SELECT id, series_id, content FROM messages_in
       WHERE status = 'pending'
         AND kind = 'task'
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
    )
    .all() as { id: string; series_id: string | null; content: string }[];
}

export interface PendingTriggeringChatRow {
  id: string;
  kind: 'chat' | 'chat-sdk';
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  process_after: string | null;
  recurrence: string | null;
  trigger: number;
  source_session_id: string | null;
  on_wake: number;
}

export function getRecentPendingTriggeringChats(db: Database.Database, since: string): PendingTriggeringChatRow[] {
  return db
    .prepare(
      `SELECT id, kind, timestamp, platform_id, channel_type, thread_id,
              content, process_after, recurrence, trigger, source_session_id, on_wake
         FROM messages_in
        WHERE status = 'pending'
          AND kind IN ('chat', 'chat-sdk')
          AND trigger = 1
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
          AND datetime(timestamp) >= datetime(?)
        ORDER BY seq ASC`,
    )
    .all(since) as PendingTriggeringChatRow[];
}

export function markMessagesCompleted(db: Database.Database, messageIds: readonly string[]): void {
  if (messageIds.length === 0) return;
  const mark = db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status = 'pending'");
  db.transaction(() => {
    for (const id of messageIds) mark.run(id);
  })();
}

export function getLatestTriggeringChatRouting(
  db: Database.Database,
): { channel_type: string; platform_id: string } | undefined {
  return db
    .prepare(
      `SELECT channel_type, platform_id FROM messages_in
        WHERE kind IN ('chat', 'chat-sdk') AND trigger = 1
          AND channel_type IS NOT NULL AND channel_type != 'agent'
          AND platform_id IS NOT NULL
        ORDER BY seq DESC LIMIT 1`,
    )
    .get() as { channel_type: string; platform_id: string } | undefined;
}

/**
 * Epoch-ms of the most recent HUMAN/channel inbound message for this
 * session, or 0 if none. "Human" = kind='chat-sdk' (a real chat message
 * from a person/channel) — deliberately EXCLUDES kind='task',
 * 'reflection', 'appr-note' and other engine-internal rows, which fire
 * on schedules/internally and must NOT make a background session look
 * like a live conversation (that would keep idle task-only sessions warm
 * forever, defeating the point). Used by the adaptive keep-warm idle
 * decision: a recent chat-sdk turn ⇒ the operator is actively
 * conversing ⇒ keep the container warm so the next turn reuses the warm
 * (codex) app-server + already-handshaked MCP servers instead of paying
 * a full cold start. messages_in.timestamp is an ISO-8601 string.
 */
export function getLatestTriggeringInbound(db: Database.Database): { kind: string; content: string } | undefined {
  return db
    .prepare(
      `SELECT kind, content FROM messages_in
       WHERE trigger = 1 AND kind != 'system'
       ORDER BY seq DESC LIMIT 1`,
    )
    .get() as { kind: string; content: string } | undefined;
}

export function hasUserConversationMessages(db: Database.Database, messageIds: readonly string[]): boolean {
  if (messageIds.length === 0) return false;
  const placeholders = messageIds.map(() => '?').join(',');
  return (
    db
      .prepare(
        `SELECT 1 AS hit FROM messages_in
         WHERE id IN (${placeholders})
           AND kind IN ('chat', 'chat-sdk') LIMIT 1`,
      )
      .get(...messageIds) !== undefined
  );
}

export function getLatestHumanInboundMs(db: Database.Database): number {
  const row = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages_in WHERE kind = 'chat-sdk'`).get() as
    | { ts: string | null }
    | undefined;
  if (!row?.ts) return 0;
  const ms = Date.parse(row.ts);
  return Number.isFinite(ms) ? ms : 0;
}

export function markMessageFailed(db: Database.Database, messageId: string): void {
  db.prepare("UPDATE messages_in SET status = 'failed' WHERE id = ?").run(messageId);
}

/**
 * Routing + classification fields for a message the host is about to give up
 * on, so the caller can decide whether to notify the user and where. Used by
 * host-sweep's failed-message user notification: without this, a message that
 * exhausts MAX_TRIES (or is force-failed by the claim-stuck breaker) flips to
 * `failed` and logs a warning, but the user who sent it hears *nothing* — the
 * request just evaporates (Nicole Paik doodle request, 2026-07-03: repeated
 * Claude-API 429s exhausted retries, no response ever delivered).
 *
 * `trigger` distinguishes an addressed request (1) from an accumulate-only
 * context row (0) — we only apologize for the former. `kind='chat'` is the
 * only user-facing kind; system round-trips and task rows are not something a
 * human is waiting on in-channel.
 */
export function getFailedMessageNotifyInfo(
  db: Database.Database,
  messageId: string,
):
  | {
      kind: string;
      trigger: number;
      channel_type: string | null;
      platform_id: string | null;
      thread_id: string | null;
    }
  | undefined {
  return db
    .prepare(
      `SELECT kind, trigger, channel_type, platform_id, thread_id
         FROM messages_in
        WHERE id = ?`,
    )
    .get(messageId) as
    | {
        kind: string;
        trigger: number;
        channel_type: string | null;
        platform_id: string | null;
        thread_id: string | null;
      }
    | undefined;
}

export function retryWithBackoff(db: Database.Database, messageId: string, backoffSec: number): void {
  // Normalize status back to 'pending'. The wake path (countDueMessages /
  // getDueTaskRows) only picks up status='pending' rows. A claim-stuck
  // codex deadlock leaves the row at 'processing'; bumping tries without
  // resetting status would re-strand it (it'd never be re-dispatched).
  // For an already-'pending' row this is a harmless no-op on status.
  const processAfter = new Date(Date.now() + backoffSec * 1000).toISOString();
  db.prepare(
    "UPDATE messages_in SET status = 'pending', tries = tries + 1, process_after = ? WHERE id = ? AND status IN ('pending', 'processing')",
  ).run(processAfter, messageId);
}

/**
 * @deprecated Superseded by getRecoverableMessage for the claim-stuck
 * reset path. A single-status lookup is the wrong contract there: the
 * stuck row may be 'processing', not 'pending'. Kept for any external
 * caller that genuinely wants an exact-status match; do not use it for
 * stuck-claim recovery.
 */
export function getMessageForRetry(
  db: Database.Database,
  messageId: string,
  status: string,
): { id: string; tries: number; processAfter: string | null } | undefined {
  return db
    .prepare('SELECT id, tries, process_after as processAfter FROM messages_in WHERE id = ? AND status = ?')
    .get(messageId, status) as { id: string; tries: number; processAfter: string | null } | undefined;
}

/**
 * Like getMessageForRetry but matches a message in ANY non-terminal state
 * — both 'pending' AND 'processing'. The claim-stuck reset path must use
 * this, not the 'pending'-only variant.
 *
 * Why: the engine never flips messages_in.status to 'processing' (only the
 * in-container agent-runner does, when it claims a message to work it).
 * When a container is killed claim-stuck AFTER the agent-runner claimed a
 * message but BEFORE it finished (the exact shape of a codex resume
 * deadlock: tool call issued, turn hung, container reaped), the
 * messages_in row is left at 'processing'. getMessageForRetry(...,
 * 'pending') then returns undefined, the reset loop skips it, the orphan
 * processing_ack is deleted, and the message is stranded at 'processing'
 * forever — no path picks up a 'processing' message, so the session wedges
 * silently (observed: a Teddy DM wedged ~4h, 2026-05-18). Recovering both
 * states closes that strand-forever hole. 'completed'/'failed' are terminal
 * and intentionally excluded — a finished message must not be resurrected.
 */
export function getRecoverableMessage(
  db: Database.Database,
  messageId: string,
): { id: string; tries: number; processAfter: string | null; status: 'pending' | 'processing' } | undefined {
  return db
    .prepare(
      `SELECT id, tries, process_after as processAfter, status
         FROM messages_in
        WHERE id = ? AND status IN ('pending', 'processing')`,
    )
    .get(messageId) as
    | { id: string; tries: number; processAfter: string | null; status: 'pending' | 'processing' }
    | undefined;
}

export function syncProcessingAcks(inDb: Database.Database, outDb: Database.Database): void {
  const completed = outDb
    .prepare(
      "SELECT message_id, status FROM processing_ack WHERE status IN ('completed', 'failed', 'script-skip:error')",
    )
    .all() as Array<{ message_id: string; status: string }>;

  if (completed.length === 0) return;

  // `script-skip:error` (pre-task script crashed) lands as a FAILED run —
  // semantically true, and it lets recurrence derive the trailing failed
  // streak from the occurrence rows themselves (no stored counter).
  const completeStmt = inDb.prepare(
    "UPDATE messages_in SET status = 'completed' WHERE id = ? AND status NOT IN ('completed', 'failed')",
  );
  const failStmt = inDb.prepare(
    "UPDATE messages_in SET status = 'failed' WHERE id = ? AND status NOT IN ('completed', 'failed')",
  );
  inDb.transaction(() => {
    for (const { message_id, status } of completed) {
      (status === 'script-skip:error' ? failStmt : completeStmt).run(message_id);
    }
  })();
}

/**
 * Garbage-collect stranded `kind='system'` rows.
 *
 * System rows are MCP-tool round-trip responses (search_conversations,
 * ask_user_question, generate_image) the host writes into messages_in for
 * the in-container tool to consume and then ack via processing_ack. If the
 * consumer hits its poll timeout in the gap before the (slow) host response
 * lands — or throws mid-poll — it returns without acking and the row
 * strands as pending forever. `countDueMessages` excludes kind='system' so
 * these never trigger a wake, but they accumulate unbounded (observed
 * 2026-06-04: 136 stranded across 32 sessions) and pollute debugging.
 *
 * The robust fix is structural and lives here, not in each tool's timeout
 * path: any system row still pending past a grace window longer than the
 * longest consumer timeout (ask_user_question polls 300s) cannot still be
 * awaited by a live turn, so mark it completed. Self-healing for current
 * and future system-row producers alike.
 */
const STALE_SYSTEM_ROW_MS = 15 * 60 * 1000;
export function gcStaleSystemRows(inDb: Database.Database, now: number = Date.now()): number {
  const cutoff = new Date(now - STALE_SYSTEM_ROW_MS).toISOString();
  return inDb
    .prepare(
      "UPDATE messages_in SET status = 'completed' WHERE kind = 'system' AND status = 'pending' AND timestamp <= ?",
    )
    .run(cutoff).changes;
}

export function getStuckProcessingIds(outDb: Database.Database): string[] {
  return (
    outDb.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
      message_id: string;
    }>
  ).map((r) => r.message_id);
}

export interface ProcessingClaim {
  message_id: string;
  status_changed: string;
}

/** Return processing_ack rows still in 'processing' with their claim timestamps. */
export function getProcessingClaims(outDb: Database.Database): ProcessingClaim[] {
  return outDb
    .prepare("SELECT message_id, status_changed FROM processing_ack WHERE status = 'processing'")
    .all() as ProcessingClaim[];
}

/**
 * Delete orphan 'processing' rows. Called by the host after killing a
 * container so the leftover claim doesn't trip claim-stuck on the next sweep
 * tick (which would kill the freshly respawned container before its
 * agent-runner can run its own startup cleanup).
 *
 * Safe because the host only writes to outbound.db when no container is
 * running (we just killed it). Returns the number of rows deleted.
 */
export function deleteOrphanProcessingClaims(outDb: Database.Database): number {
  return outDb.prepare("DELETE FROM processing_ack WHERE status = 'processing'").run().changes;
}

export interface ContainerState {
  current_tool: string | null;
  tool_declared_timeout_ms: number | null;
  tool_started_at: string | null;
  updated_at: string;
}

/**
 * Read the container's current tool-in-flight state, if any. Returns null
 * when either the table doesn't exist yet (older session DB) or no tool is
 * active. Host sweep reads this to widen stuck-detection tolerance while
 * Bash is running with a long declared timeout.
 */
export function getContainerState(outDb: Database.Database): ContainerState | null {
  try {
    const row = outDb
      .prepare(
        `SELECT current_tool, tool_declared_timeout_ms, tool_started_at, updated_at
           FROM container_state WHERE id = 1`,
      )
      .get() as ContainerState | undefined;
    return row ?? null;
  } catch {
    // Table not present on older session DBs — treat as "no tool in flight".
    return null;
  }
}

// ---------------------------------------------------------------------------
// messages_out (read-only from host)
// ---------------------------------------------------------------------------

export interface OutboundMessage {
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

export function getDueOutboundMessages(db: Database.Database): OutboundMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR datetime(deliver_after) <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as OutboundMessage[];
}

// ---------------------------------------------------------------------------
// delivered
// ---------------------------------------------------------------------------

export function getDeliveredIds(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>).map(
      (r) => r.message_out_id,
    ),
  );
}

/**
 * True if `platformMessageId` was delivered by us as a bot outbound for this
 * session. Used by the router to detect "user replied to a bot message" and
 * fire engagement in mention / mention-sticky modes — matches v1's
 * `requires_trigger` behavior where reply-to-bot is a valid trigger.
 */
export function wasDeliveredByBot(db: Database.Database, platformMessageId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM delivered WHERE platform_message_id = ? AND status = 'delivered' LIMIT 1")
    .get(platformMessageId) as { '1': number } | undefined;
  return row !== undefined;
}

export function markDelivered(db: Database.Database, messageOutId: string, platformMessageId: string | null): void {
  db.prepare(
    "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, ?, 'delivered', ?)",
  ).run(messageOutId, platformMessageId ?? null, new Date().toISOString());
}

export function markDeliveryFailed(db: Database.Database, messageOutId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'failed', ?)",
  ).run(messageOutId, new Date().toISOString());
}

/** Ensure the delivered table has columns added after initial schema. */
export function migrateDeliveredTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('platform_message_id')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN platform_message_id TEXT').run();
  }
  if (!cols.has('status')) {
    db.prepare("ALTER TABLE delivered ADD COLUMN status TEXT NOT NULL DEFAULT 'delivered'").run();
  }
}

// LEGACY-COMPAT(v1-tasks): adds columns added to messages_in after the initial
// v2 schema to pre-existing session DBs — this lazy, on-open migration IS the
// upgrade path for old installs (there is no central migration for session
// DBs). No-op on fresh installs where the columns are in the baseline schema.
// Backfills existing rows so invariants hold (series_id = id).
export function migrateMessagesInTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('series_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN series_id TEXT').run();
    db.prepare('UPDATE messages_in SET series_id = id WHERE series_id IS NULL').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id)').run();
  }
  if (!cols.has('trigger')) {
    // All pre-existing rows got written with the old "every inbound wakes
    // the agent" semantics, so backfill 1 and default 1 for new inserts.
    db.prepare('ALTER TABLE messages_in ADD COLUMN trigger INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.has('source_session_id')) {
    // For agent-to-agent return-path routing. NULL on existing rows is fine —
    // their replies fall back to the legacy "newest active session" lookup.
    db.prepare('ALTER TABLE messages_in ADD COLUMN source_session_id TEXT').run();
  }
  if (!cols.has('on_wake')) {
    // 1 = only deliver on the container's first poll (fresh start).
    // All existing rows are normal messages, so default 0.
    db.prepare('ALTER TABLE messages_in ADD COLUMN on_wake INTEGER NOT NULL DEFAULT 0').run();
  }
}

/**
 * Look up an inbound row's source_session_id by its message id. Returns null
 * if the row doesn't exist or the column is NULL (channel inbound or
 * pre-migration a2a inbound). Used by a2a routing to route replies back to
 * the originating session.
 */
export function getInboundSourceSessionId(db: Database.Database, messageId: string): string | null {
  const row = db.prepare('SELECT source_session_id FROM messages_in WHERE id = ?').get(messageId) as
    | { source_session_id: string | null }
    | undefined;
  return row?.source_session_id ?? null;
}

/**
 * Find the source_session_id of the most recent a2a inbound row from a
 * specific peer (by agent group id). Used as a peer-affinity fallback in
 * a2a routing when an outbound reply has no `in_reply_to` (e.g. the
 * container's send_message MCP tool path didn't thread the batch's
 * in_reply_to through).
 *
 * Heuristic: "the last time this peer talked to me, which session was it?"
 * Returns null when no prior a2a inbound from that peer carries a
 * non-null source_session_id (typical for pre-migration installs).
 */
export function getMostRecentPeerSourceSessionId(db: Database.Database, peerAgentGroupId: string): string | null {
  const row = db
    .prepare(
      `SELECT source_session_id FROM messages_in
        WHERE channel_type = 'agent'
          AND platform_id = ?
          AND source_session_id IS NOT NULL
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(peerAgentGroupId) as { source_session_id: string | null } | undefined;
  return row?.source_session_id ?? null;
}
