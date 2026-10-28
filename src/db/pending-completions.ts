/**
 * Inbound completions the host owes a session (migration 028).
 *
 * Recorded in the host-only central DB before the session mailbox write is
 * attempted, cleared only after it lands. Settled before every spawn
 * (container-runner) and at the start of every sweep pass (reconcile), so an
 * input the host decided is done never reaches another runner.
 */
import { getDb } from './connection.js';

export async function recordPendingCompletions(
  sessionId: string,
  messageIds: readonly string[],
  reason: string,
): Promise<void> {
  if (messageIds.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  for (const id of new Set(messageIds))
    await db.run(
      `INSERT INTO pending_inbound_completions (session_id, message_id, reason, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id, message_id) DO NOTHING`,
      sessionId,
      id,
      reason,
      now,
    );
}

export async function getPendingCompletions(sessionId: string): Promise<string[]> {
  const rows = await getDb().all<{ message_id: string }>(
    'SELECT message_id FROM pending_inbound_completions WHERE session_id = ? ORDER BY created_at, message_id',
    sessionId,
  );
  return rows.map((row) => row.message_id);
}

export async function clearPendingCompletions(sessionId: string, messageIds: readonly string[]): Promise<void> {
  const db = getDb();
  for (const id of new Set(messageIds))
    await db.run('DELETE FROM pending_inbound_completions WHERE session_id = ? AND message_id = ?', sessionId, id);
}
