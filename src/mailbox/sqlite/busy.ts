/**
 * Lock waits on the per-session SQLite files.
 *
 * Every host connection to a session's inbound.db / outbound.db shares that
 * file with a container that can hold a SQLite lock for as long as it likes.
 * SQLite's busy handler sleeps synchronously, so a long busy_timeout stalls
 * the host's whole event loop (every session, every channel) for that long on
 * each call. Host connections therefore wait only briefly in SQLite; writes
 * that must not be lost to brief contention retry asynchronously instead,
 * yielding the event loop between attempts.
 */

/** In-SQLite (synchronous) lock wait for host connections to session DBs.
 * A failing call blocks several times this (SQLite re-enters its busy handler
 * per lock step; measured ~4x), so keep it small. */
export const SESSION_DB_BUSY_TIMEOUT_MS = 20;
/** Total time an async session-DB write keeps retrying a busy lock. */
export const SESSION_DB_BUSY_RETRY_MS = 5000;

export function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

/**
 * Run `fn` (one SQLite operation that either commits or fails before
 * committing, so a retry is safe) and retry it on SQLITE_BUSY with async
 * backoff until `deadlineMs` has passed, then rethrow. Never retries any
 * other error.
 */
export async function retryWhileBusy<T>(
  fn: () => T | Promise<T>,
  deadlineMs = SESSION_DB_BUSY_RETRY_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  const start = Date.now();
  let delay = 10;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isSqliteBusy(err) || Date.now() - start + delay > deadlineMs) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 250);
    }
  }
}
