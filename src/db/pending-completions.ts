/**
 * Inbound completions the host owes a session (migration 028).
 *
 * A host Stop records the stopped inputs here BEFORE it writes their
 * completion into the session mailbox, and clears the record only after
 * that write lands. While any record exists for a session, no runner starts
 * for it (container-runner settles first), every sweep pass settles it
 * first (reconcile-session), the stuck-claim reset leaves those inputs alone,
 * and carry-forward never copies them into a new session.
 *
 * The record has three layers, so a failure of one never loses it: process
 * memory (cannot fail; covers this process life), the host-only central DB,
 * and — only when the DB write fails — a host-only JSON file under
 * `<DATA_DIR>/owed-completions/` (outside every container mount). Reads
 * union all three; clears remove from all three.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import { getDb } from './connection.js';

/** Age backstop for records of sessions that are no longer active: kept past
 * carry-forward's 24 h lookback, then dropped (nothing can run or carry them
 * any more). An active session's record is NEVER aged out: its debt is
 * retried every sweep pass, so one that grew old is one whose write has
 * failed all along, its input still pending; dropping it would let that
 * input run. The stuck alert covers the active case instead. */
export const CLOSED_SESSION_RECORD_TTL_MS = 25 * 60 * 60 * 1000;

const memory = new Map<string, Map<string, number>>();

function fallbackDir(): string {
  return path.join(DATA_DIR, 'owed-completions');
}

function fallbackFile(sessionId: string): string {
  return path.join(fallbackDir(), `${encodeURIComponent(sessionId)}.json`);
}

function readFallback(sessionId: string): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(fallbackFile(sessionId), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeFallback(sessionId: string, entries: Record<string, number>): void {
  const file = fallbackFile(sessionId);
  if (Object.keys(entries).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(fallbackDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries));
  fs.renameSync(tmp, file);
}

/** Never throws: memory always records; the DB, else the file, persists it. */
export async function recordPendingCompletions(
  sessionId: string,
  messageIds: readonly string[],
  reason: string,
): Promise<void> {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return;
  const nowMs = Date.now();
  const mem = memory.get(sessionId) ?? new Map<string, number>();
  for (const id of ids) if (!mem.has(id)) mem.set(id, nowMs);
  memory.set(sessionId, mem);
  try {
    const db = getDb();
    const now = new Date(nowMs).toISOString();
    for (const id of ids)
      await db.run(
        `INSERT INTO pending_inbound_completions (session_id, message_id, reason, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (session_id, message_id) DO NOTHING`,
        sessionId,
        id,
        reason,
        now,
      );
    return;
    // eslint-disable-next-line no-catch-all/no-catch-all -- fall through to the file layer; never lose the record
  } catch (err) {
    log.warn('Owed completion: central DB record failed; using the host file', { sessionId, err });
  }
  try {
    const entries = readFallback(sessionId);
    for (const id of ids) entries[id] ??= nowMs;
    writeFallback(sessionId, entries);
    // eslint-disable-next-line no-catch-all/no-catch-all -- memory still holds it for this process life
  } catch (err) {
    log.error('Owed completion: host file record failed too; held in memory only', { sessionId, err });
  }
}

/** Owed ids for a session, from every layer. Throws only if the DB read
 * fails (callers then treat the session as owing: refuse, don't proceed). */
export async function getPendingCompletions(sessionId: string): Promise<string[]> {
  const rows = await getDb().all<{ message_id: string }>(
    'SELECT message_id FROM pending_inbound_completions WHERE session_id = ? ORDER BY created_at, message_id',
    sessionId,
  );
  const ids = new Set(rows.map((row) => row.message_id));
  for (const id of memory.get(sessionId)?.keys() ?? []) ids.add(id);
  for (const id of Object.keys(readFallback(sessionId))) ids.add(id);
  return [...ids];
}

export async function clearPendingCompletions(sessionId: string, messageIds: readonly string[]): Promise<void> {
  const ids = new Set(messageIds);
  const db = getDb();
  for (const id of ids)
    await db.run('DELETE FROM pending_inbound_completions WHERE session_id = ? AND message_id = ?', sessionId, id);
  forgetLocal(sessionId, ids);
}

function forgetLocal(sessionId: string, ids: ReadonlySet<string> | null): void {
  const mem = memory.get(sessionId);
  if (mem) {
    for (const id of ids ?? [...mem.keys()]) mem.delete(id);
    if (mem.size === 0) memory.delete(sessionId);
  }
  const entries = readFallback(sessionId);
  if (Object.keys(entries).length) {
    for (const id of ids ?? Object.keys(entries)) delete entries[id];
    writeFallback(sessionId, entries);
  }
}

/** Drop every record for a session whose mailbox is gone (destroyed). */
export async function clearAllPendingCompletions(sessionId: string): Promise<void> {
  await getDb().run('DELETE FROM pending_inbound_completions WHERE session_id = ?', sessionId);
  forgetLocal(sessionId, null);
}

/**
 * Housekeeping (once per host sweep): drop records whose session row is
 * gone, and records of sessions no longer active once older than
 * CLOSED_SESSION_RECORD_TTL_MS. An active session's record is only ever
 * cleared by a settle. Returns the number of DB rows removed.
 */
export async function prunePendingCompletions(nowMs = Date.now()): Promise<number> {
  const db = getDb();
  const closedCutoff = new Date(nowMs - CLOSED_SESSION_RECORD_TTL_MS).toISOString();
  const doomed = await db.all<{ session_id: string; message_id: string }>(
    `SELECT p.session_id, p.message_id FROM pending_inbound_completions p
       LEFT JOIN sessions s ON s.id = p.session_id
      WHERE s.id IS NULL
         OR (s.status != 'active' AND p.created_at < ?)`,
    closedCutoff,
  );
  for (const row of doomed)
    await db.run(
      'DELETE FROM pending_inbound_completions WHERE session_id = ? AND message_id = ?',
      row.session_id,
      row.message_id,
    );
  // Local layers: the same rules for sessions the DB no longer knows.
  const sessionIds = new Set<string>(memory.keys());
  try {
    for (const name of fs.readdirSync(fallbackDir()))
      if (name.endsWith('.json')) sessionIds.add(decodeURIComponent(name.slice(0, -5)));
  } catch {
    // no fallback dir
  }
  for (const sessionId of sessionIds) {
    const session = await db.get<{ status: string }>('SELECT status FROM sessions WHERE id = ?', sessionId);
    if (session?.status === 'active') continue; // never aged out (see above)
    const ttl = !session ? -1 : CLOSED_SESSION_RECORD_TTL_MS;
    const expired = (at: number) => ttl < 0 || nowMs - at > ttl;
    const mem = memory.get(sessionId);
    const stale = new Set<string>();
    for (const [id, at] of mem ?? []) if (expired(at)) stale.add(id);
    for (const [id, at] of Object.entries(readFallback(sessionId))) if (expired(at)) stale.add(id);
    if (stale.size) forgetLocal(sessionId, stale);
  }
  return doomed.length;
}

/** Test-only: forget process memory (simulates a fresh process). */
export function _resetPendingCompletionsMemoryForTesting(): void {
  memory.clear();
}
