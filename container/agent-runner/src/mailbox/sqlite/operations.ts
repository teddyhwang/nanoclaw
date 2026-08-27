import { getInboundDb, getOutboundDb, openInboundDb, withInboundDb } from './connection.js';
import type { MessageInRow } from '../../db/messages-in.js';
import type { MessageOutRow } from '../../db/messages-out.js';
import {
  createOutboundRecord,
  parseDestinationRecord,
  parseSessionRoutingRecord,
  parseStateRecord,
} from '../model.generated.js';
import type {
  Destination,
  OutboundWrite,
  SessionRouting,
  StateValue,
  TaskFireWrite,
  TaskSeriesSnapshot,
} from '../types.js';

interface PendingMessageRow extends MessageInRow {
  _rowid?: number;
}

const STALE_ACCUMULATE_AGE_MS = 24 * 60 * 60 * 1000;
const OUTBOUND_CURSOR_PREFIX = 'seq:';
let hasOnWake: boolean | null = null;

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function sqliteTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

function hasOnWakeColumn(db: ReturnType<typeof openInboundDb>): boolean {
  if (hasOnWake !== null) return hasOnWake;
  const columns = db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>;
  hasOnWake = columns.some(({ name }) => name === 'on_wake');
  return hasOnWake;
}

export function sqliteResetPendingMessageSchemaCacheForTesting(): void {
  hasOnWake = null;
}

function compareMessageOrderAsc(a: PendingMessageRow, b: PendingMessageRow): number {
  const sequence = (a.seq ?? 0) - (b.seq ?? 0);
  if (sequence !== 0) return sequence;
  const timestamp = a.timestamp.localeCompare(b.timestamp);
  if (timestamp !== 0) return timestamp;
  const rowid = (a._rowid ?? 0) - (b._rowid ?? 0);
  if (rowid !== 0) return rowid;
  return a.id.localeCompare(b.id);
}

function sameRoute(a: PendingMessageRow, b: PendingMessageRow): boolean {
  return a.channel_type === b.channel_type && a.platform_id === b.platform_id && a.thread_id === b.thread_id;
}

/**
 * Select a bounded prompt batch without allowing system, stale, claimed, or
 * off-route accumulated rows to consume cap slots.
 */
export function sqliteGetPendingMessages(isFirstPoll: boolean, requestedLimit: number): MessageInRow[] {
  const limit = Math.max(0, Math.floor(requestedLimit));
  if (limit === 0) return [];

  const pending = withInboundDb((inbound) => {
    const includeOnWake = hasOnWakeColumn(inbound);
    const onWakeFilter = includeOnWake ? 'AND (on_wake = 0 OR ?1 = 1)' : '';
    const cutoffParameter = includeOnWake ? '?2' : '?1';
    const staleAccumulateCutoff = new Date(Date.now() - STALE_ACCUMULATE_AGE_MS).toISOString();
    const parameters = includeOnWake ? [isFirstPoll ? 1 : 0, staleAccumulateCutoff] : [staleAccumulateCutoff];

    return inbound
      .prepare(
        `SELECT rowid AS _rowid, * FROM messages_in
         WHERE status = 'pending'
           AND kind != 'system'
           AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
           ${onWakeFilter}
           AND (trigger = 1 OR datetime(timestamp) >= datetime(${cutoffParameter}))`,
      )
      .all(...parameters) as PendingMessageRow[];
  });
  if (pending.length === 0) return [];

  // Claim filtering is deliberately before both cap phases. Acknowledged rows
  // can remain pending in inbound.db until the next host sweep.
  const acknowledged = new Set(
    (getOutboundDb().prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
      ({ message_id }) => message_id,
    ),
  );
  const unclaimed = pending.filter(({ id }) => !acknowledged.has(id));

  // A task wake is route-agnostic. A chat wake is one route per turn: choose
  // the newest real trigger's route before cap accounting so older triggers
  // from another wired chat cannot consume slots or fold two chats together.
  const hasTaskWake = unclaimed.some((message) => message.trigger === 1 && message.kind === 'task');
  let eligible = unclaimed;
  if (!hasTaskWake) {
    const newestChatTrigger = unclaimed
      .filter((message) => message.trigger === 1 && message.channel_type !== 'session-echo')
      .sort(compareMessageOrderAsc)
      .at(-1);
    if (newestChatTrigger) {
      eligible = unclaimed.filter(
        (message) =>
          sameRoute(message, newestChatTrigger) || (message.trigger === 0 && message.channel_type === 'session-echo'),
      );
    }
  }

  // Wake rows are oldest-first and always win cap slots.
  const wake = eligible
    .filter(({ trigger }) => trigger === 1)
    .sort(compareMessageOrderAsc)
    .slice(0, limit);
  const remaining = limit - wake.length;
  if (remaining === 0) return wake;

  const accumulated = eligible.filter(({ trigger }) => trigger === 0);

  // Keep the newest context that fits, then restore deterministic chronology.
  const context = accumulated.sort(compareMessageOrderAsc).slice(-remaining);
  return [...wake, ...context].sort(compareMessageOrderAsc);
}

function mark(ids: string[], status: string): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const statement = db.prepare(
    'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    for (const id of ids) statement.run(id, status, new Date().toISOString());
  })();
}

export function sqliteMarkProcessing(ids: string[]): void {
  mark(ids, 'processing');
}

export function sqliteMarkCompleted(ids: string[]): void {
  mark(ids, 'completed');
}

export function sqliteMarkFailed(id: string): void {
  mark([id], 'failed');
}

export function sqliteMarkScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
  if (skips.length === 0) return;
  const db = getOutboundDb();
  const statement = db.prepare(
    'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    for (const skip of skips) {
      statement.run(skip.id, skip.reason === 'error' ? 'script-skip:error' : 'completed', new Date().toISOString());
    }
  })();
}

export function sqliteGetMessageIn(id: string): MessageInRow | undefined {
  return withInboundDb(
    (inbound) => inbound.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined,
  );
}

export function sqliteFindQuestionResponse(questionId: string): MessageInRow | undefined {
  const response = withInboundDb(
    (inbound) =>
      inbound
        .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
        .get(`%\"questionId\":\"${questionId}\"%`) as MessageInRow | undefined,
  );
  if (!response) return undefined;
  const acknowledged = getOutboundDb().prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
  return acknowledged ? undefined : response;
}

export function sqliteFindCliResponse(requestId: string): MessageInRow | undefined {
  return withInboundDb(
    (inbound) =>
      inbound
        .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
        .get(`%\"requestId\":\"${requestId}\"%`) as MessageInRow | undefined,
  );
}

/**
 * Demoted rollout fallback for pre-authoritative-reply-target turns. True only
 * when at least one row is processing and every such inbound row is a task.
 */
export function sqliteIsTaskOnlyTurn(): boolean {
  const processing = getOutboundDb()
    .prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'")
    .all() as Array<{ message_id: string }>;
  if (processing.length === 0) return false;

  const ids = processing.map(({ message_id }) => message_id);
  const placeholders = ids.map(() => '?').join(',');
  const nonTask = withInboundDb(
    (inbound) =>
      inbound
        .prepare(`SELECT 1 FROM messages_in WHERE id IN (${placeholders}) AND kind != 'task' LIMIT 1`)
        .get(...ids) as { 1: number } | null | undefined,
  );
  return nonTask == null;
}

/** Read the host-projected task-series snapshot without exposing SQLite above the driver. */
export function sqliteListTaskSeries(status?: string): TaskSeriesSnapshot[] {
  return withInboundDb((inbound) => {
    const exists = inbound.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_series'").get();
    if (!exists) return [];

    const rows = status
      ? (inbound
          .prepare(
            `SELECT series_id AS id, status, process_after, recurrence, content
             FROM task_series WHERE status = ? ORDER BY process_after ASC`,
          )
          .all(status) as Array<{
          id: string;
          status: string;
          process_after: string | null;
          recurrence: string | null;
          content: string;
        }>)
      : (inbound
          .prepare(
            `SELECT series_id AS id, status, process_after, recurrence, content
             FROM task_series WHERE status IN ('pending', 'paused') ORDER BY process_after ASC`,
          )
          .all() as Array<{
          id: string;
          status: string;
          process_after: string | null;
          recurrence: string | null;
          content: string;
        }>);

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      processAfter: row.process_after,
      recurrence: row.recurrence,
      content: row.content,
    }));
  });
}

/** Record one Optimus task fire and enforce the per-series retention cap. */
export function sqliteWriteTaskFire(fire: TaskFireWrite): void {
  const db = getOutboundDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO task_fires
         (id, series_id, task_id, fired_at, status, assistant_text, dispatched, error_message)
       VALUES
         ($id, $series_id, $task_id, datetime('now'), $status, $assistant_text, $dispatched, $error_message)`,
    ).run({
      $id: fire.id,
      $series_id: fire.seriesId,
      $task_id: fire.taskId,
      $status: fire.status,
      $assistant_text: fire.assistantText,
      $dispatched: JSON.stringify(fire.dispatched),
      $error_message: fire.errorMessage ?? null,
    });
    db.prepare(
      `DELETE FROM task_fires
       WHERE series_id = $series_id
         AND id NOT IN (
           SELECT id FROM task_fires
           WHERE series_id = $series_id
           ORDER BY fired_at DESC, rowid DESC
           LIMIT 100
         )`,
    ).run({ $series_id: fire.seriesId });
  })();
}

export function sqliteWriteMessageOut(message: OutboundWrite): number {
  const outbound = getOutboundDb();
  outbound.exec('BEGIN IMMEDIATE');
  try {
    const maxOut = (
      outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_out').get() as { value: number }
    ).value;
    const maxIn = withInboundDb(
      (inbound) =>
        (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_in').get() as { value: number }).value,
    );
    const max = Math.max(maxOut, maxIn);
    const sequence = max % 2 === 0 ? max + 1 : max + 2;
    const record = createOutboundRecord(message, sequence, new Date().toISOString());
    outbound
      .prepare(
        `INSERT INTO messages_out
           (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
         VALUES
           ($id, $seq, $in_reply_to, $timestamp, $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
      )
      .run({
        $id: record.id,
        $seq: record.sequence,
        $timestamp: record.timestamp,
        $in_reply_to: record.inReplyTo,
        $deliver_after: record.deliverAfter,
        $recurrence: record.recurrence,
        $kind: record.kind,
        $platform_id: record.platformId,
        $channel_type: record.channelType,
        $thread_id: record.threadId,
        $content: record.content,
      });
    outbound.exec('COMMIT');
    return sequence;
  } catch (error) {
    outbound.exec('ROLLBACK');
    throw error;
  }
}

export function sqliteGetMessageIdBySeq(sequence: number): string | null {
  const inboundRow = withInboundDb(
    (inbound) =>
      inbound.prepare('SELECT id FROM messages_in WHERE seq = ?').get(sequence) as { id: string } | undefined,
  );
  if (inboundRow) return inboundRow.id;

  const outboundRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(sequence) as
    | { id: string }
    | undefined;
  if (!outboundRow) return null;

  const delivered = withInboundDb(
    (inbound) =>
      inbound.prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?').get(outboundRow.id) as
        | { platform_message_id: string | null }
        | undefined,
  );
  return delivered?.platform_message_id || outboundRow.id;
}

export function sqliteGetReplyTargetMessageIdBySeq(sequence: number): string | null {
  const inboundRow = withInboundDb(
    (inbound) =>
      inbound.prepare('SELECT id, trigger FROM messages_in WHERE seq = ?').get(sequence) as
        | { id: string; trigger: number }
        | undefined,
  );
  if (inboundRow) return inboundRow.trigger === 1 ? inboundRow.id : null;

  const outboundRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(sequence) as
    | { id: string }
    | undefined;
  if (!outboundRow) return null;

  const delivered = withInboundDb(
    (inbound) =>
      inbound
        .prepare("SELECT platform_message_id FROM delivered WHERE message_out_id = ? AND status = 'delivered'")
        .get(outboundRow.id) as { platform_message_id: string | null } | undefined,
  );
  return delivered?.platform_message_id ?? null;
}

export function sqliteGetRoutingBySeq(
  sequence: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const inbound = withInboundDb(
    (db) =>
      db.prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?').get(sequence) as
        | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
        | undefined,
  );
  if (inbound) return inbound;
  return (
    (getOutboundDb()
      .prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?')
      .get(sequence) as
      | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
      | undefined) ?? null
  );
}

export function sqliteGetLatestInboundRoute(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string } | null {
  const row = withInboundDb(
    (inbound) =>
      inbound
        .prepare(
          `SELECT id, thread_id FROM messages_in
           WHERE channel_type = ? AND platform_id = ?
             AND kind != 'task' AND trigger = 1
           ORDER BY seq DESC, timestamp DESC, rowid DESC
           LIMIT 1`,
        )
        .get(channelType, platformId) as { id: string; thread_id: string | null } | undefined,
  );
  return row ? { threadId: row.thread_id, inReplyTo: row.id } : null;
}

export function sqliteGetUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR datetime(deliver_after) <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}

function parseOutboundCursor(cursor: string): number | null {
  if (!cursor.startsWith(OUTBOUND_CURSOR_PREFIX)) return null;
  const sequence = Number(cursor.slice(OUTBOUND_CURSOR_PREFIX.length));
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

export function sqliteGetOutboundCursor(): string {
  const row = getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS sequence FROM messages_out').get() as {
    sequence: number;
  };
  return `${OUTBOUND_CURSOR_PREFIX}${row.sequence}`;
}

export function sqliteCountChatMessagesSince(cursor: string): number {
  const sequence = parseOutboundCursor(cursor);
  const row =
    sequence === null
      ? (getOutboundDb()
          .prepare("SELECT COUNT(*) AS count FROM messages_out WHERE kind = 'chat' AND timestamp >= ?")
          .get(cursor) as { count: number })
      : (getOutboundDb()
          .prepare("SELECT COUNT(*) AS count FROM messages_out WHERE kind = 'chat' AND seq > ?")
          .get(sequence) as { count: number });
  return row.count;
}

function normalizeMessageText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function sqliteHasChatMessageTextSince(cursor: string, text: string): boolean {
  const normalized = normalizeMessageText(text);
  if (!normalized) return false;

  const sequence = parseOutboundCursor(cursor);
  const rows =
    sequence === null
      ? (getOutboundDb()
          .prepare("SELECT content FROM messages_out WHERE kind = 'chat' AND timestamp > ?")
          .all(cursor) as Array<{ content: string }>)
      : (getOutboundDb()
          .prepare("SELECT content FROM messages_out WHERE kind = 'chat' AND seq > ?")
          .all(sequence) as Array<{ content: string }>);

  return rows.some(({ content }) => {
    try {
      const payload = JSON.parse(content) as { text?: unknown };
      return typeof payload.text === 'string' && normalizeMessageText(payload.text) === normalized;
    } catch {
      return false;
    }
  });
}

export function sqliteHasChatMessageToDestinationSince(
  cursor: string,
  destination: { channelType: string; platformId: string },
): boolean {
  const sequence = parseOutboundCursor(cursor);
  const row =
    sequence === null
      ? getOutboundDb()
          .prepare(
            `SELECT 1 FROM messages_out
             WHERE kind = 'chat' AND timestamp > ? AND channel_type = ? AND platform_id = ?
             LIMIT 1`,
          )
          .get(cursor, destination.channelType, destination.platformId)
      : getOutboundDb()
          .prepare(
            `SELECT 1 FROM messages_out
             WHERE kind = 'chat' AND seq > ? AND channel_type = ? AND platform_id = ?
             LIMIT 1`,
          )
          .get(sequence, destination.channelType, destination.platformId);
  return row != null;
}

export function sqliteHasIdenticalSend(platformId: string, channelType: string, text: string): boolean {
  const row = getOutboundDb()
    .prepare(
      `SELECT 1 FROM messages_out
       WHERE platform_id = $platform_id AND channel_type = $channel_type
         AND (in_reply_to IS NULL OR in_reply_to = '')
         AND CASE WHEN json_valid(content) THEN json_extract(content, '$.text') END = $text
       LIMIT 1`,
    )
    .get({ $platform_id: platformId, $channel_type: channelType, $text: text });
  return row != null;
}

export function sqliteGetSessionRouting(): SessionRouting {
  const db = getInboundDb();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_routing'").get();
  if (!exists) return { channelType: null, platformId: null, threadId: null };
  const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
    | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
    | undefined;
  return parseSessionRoutingRecord({
    channelType: row?.channel_type ?? null,
    platformId: row?.platform_id ?? null,
    threadId: row?.thread_id ?? null,
  });
}

export function sqliteGetState(key: string): StateValue | undefined {
  const row = getOutboundDb().prepare('SELECT value, updated_at FROM session_state WHERE key = ?').get(key) as
    | { value: string; updated_at: string }
    | undefined;
  if (!row) return undefined;
  const record = parseStateRecord({ key, value: row.value, updatedAt: sqliteTimestamp(row.updated_at) });
  return { value: record.value, updatedAt: record.updatedAt };
}

export function sqliteSetState(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

export function sqliteDeleteState(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

export function sqliteDeleteStateByPrefixes(prefixes: readonly string[]): number {
  if (prefixes.length === 0) return 0;
  if (prefixes.some((prefix) => prefix.length === 0)) throw new Error('state prefix must not be empty');
  const clauses = prefixes.map(() => 'substr(key, 1, length(?)) = ?').join(' OR ');
  const parameters = prefixes.flatMap((prefix) => [prefix, prefix]);
  return getOutboundDb()
    .prepare(`DELETE FROM session_state WHERE ${clauses}`)
    .run(...parameters).changes;
}

export function sqliteConsumeState(key: string): StateValue | undefined {
  const db = getOutboundDb();
  return db.transaction(() => {
    const state = sqliteGetState(key);
    if (state) db.prepare('DELETE FROM session_state WHERE key = ?').run(key);
    return state;
  })();
}

interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function destination(row: DestinationRow): Destination {
  return parseDestinationRecord({
    name: row.name,
    displayName: row.display_name,
    type: row.type,
    channelType: row.channel_type,
    platformId: row.platform_id,
    agentGroupId: row.agent_group_id,
  });
}

export function sqliteGetAllDestinations(): Destination[] {
  return (getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestinationRow[]).map(
    destination,
  );
}

export function sqliteFindByName(name: string): Destination | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as
    | DestinationRow
    | undefined;
  return row && destination(row);
}

export function sqliteFindByRouting(channelType: string, platformId: string): Destination | undefined {
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db.prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?").get(platformId) as
          | DestinationRow
          | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestinationRow | undefined);
  return row && destination(row);
}
