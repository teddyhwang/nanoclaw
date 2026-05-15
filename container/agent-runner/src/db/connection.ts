/**
 * Two-DB connection layer.
 *
 * The session uses two SQLite files to eliminate write contention across
 * the host-container mount boundary:
 *
 *   inbound.db  — host writes new messages here; container opens READ-ONLY
 *   outbound.db — container writes responses + acks here; host opens read-only
 *
 * Each file has exactly one writer, so no cross-process lock contention.
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _heartbeatPath: string = DEFAULT_HEARTBEAT_PATH;
let _testMode = false;

/**
 * Avoid all cached db reads; open inbound.db read-only with mmap and page cache disabled.
 *
 * Use this (not getInboundDb) for readers that need to see host-written rows
 * promptly — e.g. messages_in polling. Caller must .close() the returned
 * connection (try/finally).
 *
 * Needed for mounts where host writes don't reliably invalidate
 * SQLite's caches: virtiofs (Colima, Lima, Podman Machine, Apple
 * Container), NFS.
 *
 * Cost is microseconds per query, so safe for universal use.
 */
export function openInboundDb(): Database {
  // In test mode return a thin wrapper over the in-memory singleton.
  // Callers do try/finally { db.close() } — the wrapper no-ops close()
  // so the singleton survives for the rest of the test.
  if (_testMode && _inbound) {
    const db = _inbound;
    return { prepare: (sql: string) => db.prepare(sql), exec: (sql: string) => db.exec(sql), close: () => {} } as unknown as Database;
  }
  const db = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  return db;
}

/**
 * Run a read against a freshly-opened inbound.db, retrying on transient
 * SQLITE_CORRUPT.
 *
 * Why this exists (S405): inbound.db is journal_mode=DELETE and read
 * over VirtioFS. The host commits a write by modifying pages in place
 * then deleting inbound.db-journal. busy_timeout makes a reader wait on
 * a *lock*, but VirtioFS does not propagate the host's page writes to
 * the guest atomically — a reader that opens between the host's
 * page-modify and journal-delete can read a half-updated B-tree and
 * get "database disk image is malformed". The lock was respected; the
 * mount's non-atomic page propagation is the hole, so busy_timeout
 * alone cannot prevent it. Empirically this fired ~90×/day on the
 * merged Degenerates session (one agent-shared inbound.db written by a
 * every-5-minute recurrence while the container polled it), each
 * occurrence crashing the runner code=1 → host respawn → crash-loop.
 *
 * The torn state is transient: the host write completes in
 * milliseconds, so a reopened connection a few ms later sees a
 * consistent file. We close, back off, reopen, and retry. This cannot
 * regress behavior — without it the same read throws fatally today
 * (index.ts → process.exit(1)); the worst case here is the same fatal
 * throw after the retries are exhausted.
 *
 * `PRAGMA integrity_check` is deliberately NOT run — it passes on a
 * transient torn read (the on-disk file is fine; only the reader's
 * VirtioFS view was momentarily inconsistent) so it would give false
 * confidence and waste a poll. The reopen IS the check.
 */
const INBOUND_CORRUPT_RETRIES = 5;
const INBOUND_CORRUPT_BACKOFF_MS = 40;

function isTransientCorrupt(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // bun:sqlite surfaces the sqlite text; match on the message rather
  // than a code so it works regardless of driver error shape.
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT')
  );
}

export function withInboundDb<T>(fn: (db: Database) => T): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= INBOUND_CORRUPT_RETRIES; attempt++) {
    const db = openInboundDb();
    try {
      return fn(db);
    } catch (err) {
      lastErr = err;
      if (!isTransientCorrupt(err) || attempt === INBOUND_CORRUPT_RETRIES) {
        throw err;
      }
      // Transient torn read — close, let the host write settle, reopen.
      // Synchronous busy-wait (not setTimeout): callers are synchronous
      // and the backoff is tens of ms, far cheaper than the crash +
      // ~5min respawn it replaces.
      const until = Date.now() + INBOUND_CORRUPT_BACKOFF_MS * (attempt + 1);
      while (Date.now() < until) {
        /* brief settle before reopen */
      }
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort: a corrupt handle may throw on close */
      }
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw lastErr;
}

/**
 * Inbound DB — long-lived singleton, OK for tables the host writes once
 * at spawn and never again (destinations, session_routing). For
 * messages_in polling — where the host writes continuously and a stale
 * view causes the pollHandle hang — use `openInboundDb()` instead.
 */
export function getInboundDb(): Database {
  if (!_inbound) {
    _inbound = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
    _inbound.exec('PRAGMA busy_timeout = 5000');
    _inbound.exec('PRAGMA mmap_size = 0');
  }
  return _inbound;
}

/** Outbound DB — container owns this file (sole writer). */
export function getOutboundDb(): Database {
  if (!_outbound) {
    _outbound = new Database(DEFAULT_OUTBOUND_PATH);
    _outbound.exec('PRAGMA journal_mode = DELETE');
    _outbound.exec('PRAGMA busy_timeout = 5000');
    _outbound.exec('PRAGMA foreign_keys = ON');
    // Lightweight forward-compat: session_state was added after the initial
    // v2 schema, so older session DBs don't have it. Create it on demand
    // instead of requiring a formal migration pass. Also handle the case
    // where an earlier revision of this table existed without updated_at —
    // ALTER TABLE to add any missing columns.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = new Set(
      (_outbound.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('updated_at')) {
      _outbound.exec(`ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    }
    // container_state: tracks the current tool in flight (if any) so the host
    // sweep can widen its stuck tolerance when Bash is running with a user-
    // declared long timeout. Forward-compat for older outbound.db files.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS container_state (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool             TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at          TEXT,
        updated_at               TEXT NOT NULL
      );
    `);
    // task_fires: per-fire history of scheduled-task turns (series_id,
    // task_id, status, assistant_text, dispatched). status is one of
    // completed|silent|error|gated. Forward-compat for outbound.dbs
    // created before this table existed. See src/db/schema.ts for the
    // column docstring.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS task_fires (
        id             TEXT PRIMARY KEY,
        series_id      TEXT NOT NULL,
        task_id        TEXT NOT NULL,
        fired_at       TEXT NOT NULL,
        status         TEXT NOT NULL,
        assistant_text TEXT,
        dispatched     TEXT NOT NULL DEFAULT '[]',
        error_message  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_fires_series ON task_fires(series_id, fired_at);
    `);
  }
  return _outbound;
}

/**
 * Record that a tool is starting. `declaredTimeoutMs` is the tool's own
 * timeout hint when one is available (Bash exposes it in the tool_use input);
 * omit for tools with no declared timeout.
 */
export function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = excluded.current_tool,
         tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
         tool_started_at = excluded.tool_started_at,
         updated_at = excluded.updated_at`,
    )
    .run(tool, declaredTimeoutMs, now, now);
}

/** Clear the in-flight tool — called on PostToolUse / PostToolUseFailure. */
export function clearContainerToolInFlight(): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = NULL,
         tool_declared_timeout_ms = NULL,
         tool_started_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

/**
 * Touch the heartbeat file — replaces the old touchProcessing() DB writes.
 * The host checks this file's mtime for stale container detection.
 * A file touch is cheaper and avoids cross-boundary DB write contention.
 */
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try {
      fs.writeFileSync(p, '');
    } catch {
      // Silently ignore — parent dir may not exist (e.g., in-memory test DBs)
    }
  }
}

/**
 * Clear stale processing_ack entries on container startup.
 * If the previous container crashed, 'processing' entries are leftover.
 * Clearing them lets the new container re-process those messages.
 */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
}

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  _testMode = true;
  _inbound = new Database(':memory:');
  _inbound.exec('PRAGMA foreign_keys = ON');
  _inbound.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  TEXT,
      recurrence     TEXT,
      series_id      TEXT,
      tries          INTEGER DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      on_wake        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE delivered (
      message_out_id      TEXT PRIMARY KEY,
      platform_message_id TEXT,
      status              TEXT NOT NULL DEFAULT 'delivered',
      delivered_at        TEXT NOT NULL
    );
    CREATE TABLE destinations (
      name            TEXT PRIMARY KEY,
      display_name    TEXT,
      type            TEXT NOT NULL,
      channel_type    TEXT,
      platform_id     TEXT,
      agent_group_id  TEXT
    );
  `);

  _outbound = new Database(':memory:');
  _outbound.exec('PRAGMA foreign_keys = ON');
  _outbound.exec(`
    CREATE TABLE messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      updated_at               TEXT NOT NULL
    );
    CREATE TABLE task_fires (
      id             TEXT PRIMARY KEY,
      series_id      TEXT NOT NULL,
      task_id        TEXT NOT NULL,
      fired_at       TEXT NOT NULL,
      status         TEXT NOT NULL,
      assistant_text TEXT,
      dispatched     TEXT NOT NULL DEFAULT '[]',
      error_message  TEXT
    );
    CREATE INDEX idx_task_fires_series ON task_fires(series_id, fired_at);
  `);

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  _inbound?.close();
  _inbound = null;
  _testMode = false;
  _outbound?.close();
  _outbound = null;
}

/**
 * @deprecated Use getInboundDb() / getOutboundDb() instead.
 * Kept for backward compatibility during migration.
 */
export function getSessionDb(): Database {
  return getInboundDb();
}
