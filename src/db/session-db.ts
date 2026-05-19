/**
 * SQL operations on per-session inbound/outbound DBs.
 *
 * These are NOT the central app DB — they're the cross-mount SQLite files
 * shared between host and container. Callers own the connection lifecycle
 * (open-write-close per op). See session-manager.ts header for invariants.
 */
import Database from 'better-sqlite3';

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
 * the general public API — imported by `src/modules/scheduling/db.ts` only.
 */
export function nextEvenSeq(db: Database.Database): number {
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
}

export function insertMessage(
  db: Database.Database,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    processAfter: string | null;
    recurrence: string | null;
    /**
     * 1 = wake the agent (default); 0 = accumulate as context only.
     * Host countDueMessages gates on this; container reads everything.
     */
    trigger?: 0 | 1;
    /**
     * For agent-to-agent inbound: the source session id that emitted the
     * outbound message which became this inbound row. Used as the return
     * path for the target's reply. NULL on channel-side inbound.
     */
    sourceSessionId?: string | null;
    /**
     * 1 = only deliver on the container's first poll (fresh start).
     * Dying containers (past first poll) skip these rows.
     */
    onWake?: 0 | 1;
  },
): void {
  // Idempotent on the message id (PRIMARY KEY). The same channel message can
  // legitimately reach one inbound.db more than once: a shared session bound
  // to multiple chats (e.g. a post-merge agent-shared agent) receiving the
  // same id via two bindings, or a startup gap-recovery replaying a message
  // the live gateway already wrote. A bare INSERT throws
  // `UNIQUE constraint failed: messages_in.id`, which fails the whole route
  // and — when it retries every tick — churns the DB hard enough to corrupt
  // an autoindex. A re-delivered id is already recorded; treat it as a no-op.
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger, source_session_id, on_wake)
     VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content, @processAfter, @recurrence, @id, @trigger, @sourceSessionId, @onWake)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    ...message,
    trigger: message.trigger ?? 1,
    onWake: message.onWake ?? 0,
    sourceSessionId: message.sourceSessionId ?? null,
    seq: nextEvenSeq(db),
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

export function retryWithBackoff(db: Database.Database, messageId: string, backoffSec: number): void {
  // Normalize status back to 'pending'. The wake path (countDueMessages /
  // getDueTaskRows) only picks up status='pending' rows. A claim-stuck
  // codex deadlock leaves the row at 'processing'; bumping tries without
  // resetting status would re-strand it (it'd never be re-dispatched).
  // For an already-'pending' row this is a harmless no-op on status.
  db.prepare(
    `UPDATE messages_in
        SET status = 'pending', tries = tries + 1,
            process_after = datetime('now', '+${backoffSec} seconds')
      WHERE id = ?`,
  ).run(messageId);
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
): { id: string; tries: number; processAfter: string | null; status: string } | undefined {
  return db
    .prepare(
      `SELECT id, tries, process_after as processAfter, status
         FROM messages_in
        WHERE id = ? AND status IN ('pending', 'processing')`,
    )
    .get(messageId) as { id: string; tries: number; processAfter: string | null; status: string } | undefined;
}

export function syncProcessingAcks(inDb: Database.Database, outDb: Database.Database): void {
  const completed = outDb
    .prepare("SELECT message_id FROM processing_ack WHERE status IN ('completed', 'failed')")
    .all() as Array<{ message_id: string }>;

  if (completed.length === 0) return;

  const updateStmt = inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status != 'completed'");
  inDb.transaction(() => {
    for (const { message_id } of completed) {
      updateStmt.run(message_id);
    }
  })();
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
        `SELECT current_tool, tool_declared_timeout_ms, tool_started_at
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
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  in_reply_to: string | null;
}

export function getDueOutboundMessages(db: Database.Database): OutboundMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
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
    "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, ?, 'delivered', datetime('now'))",
  ).run(messageOutId, platformMessageId ?? null);
}

export function markDeliveryFailed(db: Database.Database, messageOutId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'failed', datetime('now'))",
  ).run(messageOutId);
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

// Adds columns added to messages_in after the initial v2 schema to
// pre-existing session DBs. No-op on fresh installs where the columns are
// in the baseline schema. Backfills existing rows so invariants hold.
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
