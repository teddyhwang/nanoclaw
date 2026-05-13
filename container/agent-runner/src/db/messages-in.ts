/**
 * Inbound message operations (container side).
 *
 * Reads from inbound.db (host-owned, opened read-only).
 * Writes processing status to processing_ack in outbound.db (container-owned).
 *
 * The container never writes to inbound.db — all status tracking goes through
 * processing_ack. The host reads processing_ack to sync message lifecycle.
 */
import { getConfig } from '../config.js';
import { openInboundDb, getOutboundDb } from './connection.js';

// Cache whether inbound.db has the on_wake column (added in v2.0.48).
// The container opens inbound.db read-only, so it can't ALTER —
// gracefully degrade when running against an older session DB.
let _hasOnWake: boolean | null = null;
function hasOnWakeColumn(db: ReturnType<typeof openInboundDb>): boolean {
  if (_hasOnWake !== null) return _hasOnWake;
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  _hasOnWake = cols.has('on_wake');
  return _hasOnWake;
}

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

/**
 * Fetch pending messages that are due for processing.
 * Reads from inbound.db (read-only), filters against processing_ack in outbound.db
 * to skip messages already picked up by this or a previous container run.
 *
 * Returns the most recent `MAX_MESSAGES_PER_PROMPT` pending rows in
 * chronological order, regardless of their `trigger` flag: accumulated
 * context (trigger=0) rides along with the wake-eligible rows so the agent
 * sees the prior context it missed. Host's countDueMessages gates waking on
 * trigger=1 separately (see src/db/session-db.ts).
 */
/**
 * Soft age-out for trigger=0 accumulate rows. Older than this and the
 * row is treated as stale context — `getPendingMessages` skips it (it
 * still lives in messages_in for audit + search-conversations recall,
 * which queries the table directly).
 *
 * The accumulate contract is "ride along with the next trigger=1 wake
 * so the agent sees the prior context it missed." If the wake never
 * comes within a day, the conversation has moved on; the row is dead
 * weight that takes prompt budget and (with the LIMIT) competes with
 * fresh context. Trigger=1 rows are NOT age-capped here — they
 * represent due work and should be processed regardless of age.
 */
const STALE_ACCUMULATE_AGE_MS = 24 * 60 * 60 * 1000;

export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    // Three layers of filtering to avoid the LIMIT starving real work
    // and to bound prompt budget:
    //
    // 1. Exclude `kind='system'` at the SQL layer. Those rows are MCP-tool
    //    responses (search_conversations_response, ask_user_question
    //    responses) consumed directly by their respective tools' own
    //    queries against messages_in. The poll loop has always stripped
    //    them in its app-layer filter, but having them count toward the
    //    LIMIT meant a session that accumulated unconsumed sys-resp rows
    //    (one per search when the consumer forgot to markCompleted —
    //    fixed in apps/optimus/container-tools/src/search-conversations.ts)
    //    could starve out real task / chat rows.
    //
    // 2. Soft age-out for stale trigger=0 accumulate rows. Older than
    //    24h and the row is no longer useful context — the next-trigger
    //    pattern means the agent has had a full day of opportunities
    //    to see it, the conversation has moved on, and including it now
    //    wastes prompt budget. Trigger=1 rows skip the age check —
    //    they represent due work, age doesn't matter. Observed
    //    2026-05-12 in #boysnight: 4309 trigger=0 chat rows accumulated
    //    over weeks were riding the LIMIT and starving a due dream-*
    //    task; even without that starve interaction, no agent benefits
    //    from week-old chitchat as "context."
    //
    // 3. Order by `trigger DESC, seq DESC` so trigger=1 rows are
    //    guaranteed to be at the front of the LIMIT window. Otherwise
    //    a stream of trigger=0 accumulate rows buries the older
    //    trigger=1 wake row beneath the LIMIT cutoff and the
    //    container's poll loop hits the `!messages.some(trigger===1)`
    //    accumulate gate and sleeps forever. With trigger-priority
    //    ordering, the dream task surfaces first and the gate advances.
    //
    // Pre-migration session DBs predate the on_wake column (added in
    // v2.0.48). `hasOnWakeColumn` makes the on_wake filter conditional
    // so the container gracefully degrades against older inbound.db
    // schemas instead of erroring out.
    const staleAccumulateCutoff = new Date(Date.now() - STALE_ACCUMULATE_AGE_MS).toISOString();
    const onWakeFilter = hasOnWakeColumn(inbound) ? 'AND (on_wake = 0 OR ?1 = 1)' : '';
    const pending = inbound
      .prepare(
        `SELECT * FROM messages_in
         WHERE status = 'pending'
           AND kind != 'system'
           AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
           ${onWakeFilter}
           AND (trigger = 1 OR datetime(timestamp) >= datetime(?3))
         ORDER BY trigger DESC, seq DESC
         LIMIT ?2`,
      )
      .all(isFirstPoll ? 1 : 0, getMaxMessagesPerPrompt(), staleAccumulateCutoff) as MessageInRow[];

    if (pending.length === 0) return [];

    // Filter out messages already acknowledged in outbound.db
    const ackedIds = new Set(
      (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
        (r) => r.message_id,
      ),
    );

    // Sort by seq ASC for chronological agent view. Can't just
    // `.reverse()` because the SQL `ORDER BY trigger DESC, seq DESC`
    // groups trigger=1 rows ahead of trigger=0 — a plain reverse would
    // put trigger=0 chat first, trigger=1 task last, which both
    // confuses the agent's time-ordering and lets the trigger=1 row
    // end up at the tail of formatMessages' chat block.
    return pending.filter((m) => !ackedIds.has(m.id)).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  } finally {
    inbound.close();
  }
}

/** Mark messages as processing — writes to processing_ack in outbound.db. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark messages as completed — updates processing_ack in outbound.db. */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark a single message as failed — writes to processing_ack in outbound.db. */
export function markFailed(id: string): void {
  getOutboundDb()
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'failed', datetime('now'))",
    )
    .run(id);
}

/** Get a message by ID (read from inbound.db). */
export function getMessageIn(id: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  try {
    return inbound.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
  } finally {
    inbound.close();
  }
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const response = inbound
      .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
      .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;

    if (!response) return undefined;

    // Check it hasn't been acked already
    const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
    if (acked) return undefined;

    return response;
  } finally {
    inbound.close();
  }
}

