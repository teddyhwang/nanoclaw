/**
 * Open a per-session SQLite file without following a container-planted link.
 *
 * The session folder is mounted read-write at /workspace, so the container
 * owns every name in it and can turn `outbound.db` into a symlink at any time.
 * better-sqlite3 opens by path and SQLite resolves symlinks in that path before
 * its O_NOFOLLOW open, so a path check before `new Database(path)` is a
 * check-then-use race and the host would create or modify the link's target.
 *
 * Here the directory is pinned by descriptor (AnchoredDir) and SQLite is never
 * allowed to create the file (`fileMustExist`). Three identity checks, any
 * mismatch closing the connection before a single query touches the file:
 *   1. before the open, the name in the pinned directory (lstat through the
 *      descriptor alias = fstatat(dirfd, name, AT_SYMLINK_NOFOLLOW)) must be
 *      a regular file; its dev/ino is recorded;
 *   2. after the open, lstat of the path SQLite reports it opened must be a
 *      regular file with that same dev/ino (a link swapped in at the name
 *      makes SQLite report the link target, a different inode);
 *   3. the pinned name is checked again and must still be that inode.
 * The reported path is compared by identity, not by string: on Linux the
 * descriptor alias (/proc/self/fd/N) is itself a link that SQLite resolves,
 * so the reported path legitimately differs from the alias.
 * SQLite opens journals as `<resolved db path>-journal` with O_NOFOLLOW, so
 * they stay anchored to the same directory too.
 *
 * Two more container moves are neutralized for container-writable files
 * (the default; `schema: 'host'` opts a host-owned file out):
 *
 *   - FIFOs. SQLite opens the database and, later, its side files
 *     (-journal, -wal, -shm) by name; opening a FIFO with no writer blocks,
 *     and with it the host's event loop. Every SQLite call on the connection
 *     (open, prepare, step, pragma, exec, transaction, close) runs "armed":
 *     a watchdog thread that sleeps while nothing is armed checks those four
 *     names after 20 ms and, for each FIFO, has a short-lived helper PROCESS
 *     open it for writing (fchmod first, so a read-only FIFO is no escape).
 *     That releases the blocked open; a FIFO's size is 0, so SQLite reads
 *     nothing from it, and the identity checks refuse it as the database.
 *     A separate process, because closing any descriptor on a file drops
 *     every POSIX lock this process holds on it, and a regular file can be
 *     swapped back in between the check and the open.
 *   - Container-authored schema. Views, triggers, virtual tables, generated
 *     columns, expression or partial indexes, expression defaults and CHECKs
 *     run SQL (possibly endless) when the host queries or writes. Only plain
 *     tables and column indexes with literal defaults are allowed (the host
 *     and runner schemas). Every statement checks, inside the same
 *     transaction as the statement (deferred for reads, immediate for
 *     writes, so the schema cannot change in between), the schema cookie and,
 *     when it changed since the last check on this connection, the whole
 *     schema. `trusted_schema = OFF` as well.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { MessageChannel, Worker, type MessagePort } from 'worker_threads';

import type { AnchoredDir } from '../../anchored-dir.js';
import { SESSION_DB_BUSY_TIMEOUT_MS } from './busy.js';

export class UnsafeSessionDbError extends Error {}

export interface AnchoredDbOptions {
  /**
   * Who can write the file and its schema. `container` (default): it lives
   * in a container-writable folder, so FIFOs and schema are guarded (see
   * header). `host`: host-owned (e.g. mailbox/inbound.db, read-only to the
   * container); no guard.
   */
  schema?: 'container' | 'host';
}

// ── FIFO watchdog ───────────────────────────────────────────────────────────
// flag[0]: id of the connection whose SQLite call is in progress (0 = none).
// Connections register their four paths over a MessagePort; the worker drains
// it with receiveMessageOnPort, so registration needs no event-loop turn.
const RELEASE_SOURCE = `
const fs = require('fs');
const { O_RDONLY, O_WRONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
const file = process.argv[1];
let r;
try {
  r = fs.openSync(file, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
  if (fs.fstatSync(r).isFIFO()) {
    try { fs.fchmodSync(r, 0o600); } catch {}
    const w = fs.openSync(file, O_WRONLY | O_NONBLOCK | O_NOFOLLOW);
    fs.closeSync(w);
  }
} catch {}
`;
const WATCHDOG_SOURCE = `
const { workerData, receiveMessageOnPort } = require('worker_threads');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { shared, port, execPath, release, pid } = workerData;
const flag = new Int32Array(shared);
const paths = new Map();
const drain = () => {
  for (let m; (m = receiveMessageOnPort(port)); ) {
    if (m.message.paths) paths.set(m.message.id, m.message.paths);
    else paths.delete(m.message.id);
  }
};
// Another process cannot use this process's /proc/self/fd alias.
const forHelper = (p) => p.replace(/^\\/proc\\/self\\//, '/proc/' + pid + '/');
for (;;) {
  Atomics.wait(flag, 0, 0);
  let id;
  while ((id = Atomics.load(flag, 0)) !== 0) {
    // Nearly every call finishes well within this wait: no work at all.
    if (Atomics.wait(flag, 0, id, 20) !== 'timed-out') continue;
    drain();
    for (const p of paths.get(id) || []) {
      let fifo = false;
      try {
        const st = fs.lstatSync(p, { throwIfNoEntry: false });
        fifo = !!st && st.isFIFO();
      } catch {}
      if (fifo && Atomics.load(flag, 0) === id)
        spawnSync(execPath, ['-e', release, forHelper(p)], { stdio: 'ignore', timeout: 2000 });
    }
  }
}
`;
interface Watchdog {
  worker: Worker;
  flag: Int32Array;
  port: MessagePort;
}
let watchdog: Watchdog | null = null;
let nextConnectionId = 0;

function fifoWatchdog(): Watchdog {
  if (watchdog) return watchdog;
  const shared = new SharedArrayBuffer(4);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { shared, port: port2, execPath: process.execPath, release: RELEASE_SOURCE, pid: process.pid },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();
  const current: Watchdog = { worker, flag: new Int32Array(shared), port: port1 };
  const drop = () => {
    if (watchdog === current) watchdog = null;
  };
  worker.on('error', drop);
  worker.on('exit', drop);
  watchdog = current;
  return current;
}

/** Watched names of one connection; `arm` runs a synchronous call under watch. */
export interface FifoWatch {
  arm<T>(call: () => T): T;
  dispose(): void;
}

/** Watch `paths` (a database and its side files) during armed calls. */
export function watchFifos(paths: readonly string[]): FifoWatch {
  const { flag, port } = fifoWatchdog();
  nextConnectionId = (nextConnectionId % 0x7ffffffe) + 1;
  const id = nextConnectionId;
  port.postMessage({ id, paths: [...paths] });
  return {
    arm<T>(call: () => T): T {
      const previous = Atomics.exchange(flag, 0, id);
      if (previous !== id) Atomics.notify(flag, 0);
      try {
        return call();
      } finally {
        Atomics.store(flag, 0, previous);
        Atomics.notify(flag, 0);
      }
    },
    dispose() {
      port.postMessage({ id });
    },
  };
}

/** One-shot: run `open` with `path` watched (no side files). */
export function withFifoWatchdog<T>(path: string, open: () => T): T {
  const watch = watchFifos([path]);
  try {
    return watch.arm(open);
  } finally {
    watch.dispose();
  }
}

// ── Schema guard ────────────────────────────────────────────────────────────
const MAX_SCHEMA_ROWS = 200;
const LITERAL_DEFAULT =
  /^(?:NULL|TRUE|FALSE|CURRENT_(?:TIME|DATE|TIMESTAMP)|[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?|'(?:[^']|'')*')$/i;
// The only sqlite_-prefixed tables SQLite itself creates in a host schema
// (AUTOINCREMENT and ANALYZE).
const SQLITE_INTERNAL_TABLES = new Set(['sqlite_sequence', 'sqlite_stat1', 'sqlite_stat4']);
// The one CHECK the host schemas use (single-row tables).
const SINGLE_ROW_CHECK = /CHECK\s*\(\s*id\s*=\s*1\s*\)/gi;

/** Why the connection's current schema is unsafe for host SQL, or null. */
function unsafeSchema(prepare: Database.Database['prepare']): string | null {
  const rows = prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
  if (rows.length > MAX_SCHEMA_ROWS) return `its schema has ${rows.length} objects`;
  for (const row of rows) {
    const label = `${row.type} ${JSON.stringify(row.name)}`;
    if (row.type === 'view' || row.type === 'trigger') return `its schema has a ${label}`;
    if (row.type === 'index') {
      if (row.sql === null) continue; // automatic index (PRIMARY KEY / UNIQUE)
      if (/\bWHERE\b/i.test(row.sql)) return `its schema has a partial ${label}`;
      const cols = prepare(`SELECT cid FROM pragma_index_xinfo(?) WHERE key = 1`).all(row.name) as Array<{
        cid: number;
      }>;
      if (cols.some((c) => c.cid === -2)) return `its schema has an expression ${label}`;
      continue;
    }
    if (row.type !== 'table') return `its schema has a ${label}`;
    // SQLite's own tables keep their reserved names and are still checked as
    // plain tables below; any other sqlite_ name is container-planted.
    if (row.name.toLowerCase().startsWith('sqlite_') && !SQLITE_INTERNAL_TABLES.has(row.name))
      return `its schema has a reserved-name ${label}`;
    // SQLite stores ordinary tables as exactly "CREATE TABLE ..."; anything
    // else (a rewritten "CREATE\nVIRTUAL TABLE" included) is refused.
    if (!row.sql || !row.sql.startsWith('CREATE TABLE ')) return `its schema has a non-plain ${label}`;
    if (/\bCHECK\b/i.test(row.sql.replace(SINGLE_ROW_CHECK, ''))) return `its schema has a CHECK on ${label}`;
    const cols = prepare(`SELECT name, hidden, dflt_value FROM pragma_table_xinfo(?)`).all(row.name) as Array<{
      name: string;
      hidden: number;
      dflt_value: string | null;
    }>;
    for (const col of cols) {
      if (col.hidden !== 0) return `its schema has a generated or hidden column on ${label}`;
      if (col.dflt_value !== null && !LITERAL_DEFAULT.test(col.dflt_value.trim()))
        return `its schema has an expression default on ${label}`;
    }
  }
  const virtual = prepare(
    `SELECT name FROM pragma_table_list WHERE type NOT IN ('table', 'shadow') AND schema = 'main'`,
  ).all()[0] as { name: string } | undefined;
  if (virtual) return `its schema has a virtual table ${JSON.stringify(virtual.name)}`;
  return null;
}

/**
 * Throw UnsafeSessionDbError unless the schema is plain tables and column
 * indexes with literal defaults (see header).
 */
export function assertPlainSchema(db: Database.Database, name: string): void {
  const why = unsafeSchema(db.prepare.bind(db) as Database.Database['prepare']);
  if (why) refuse(name, why);
}

// Statements passed through unwrapped: transaction control, pragmas and
// ATTACH/DETACH/VACUUM (SQLite refuses some inside a transaction). None of
// them evaluates schema SQL.
const PASS_THROUGH = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ATTACH|DETACH)\b/i;

/** Guard every SQLite call on a container-writable connection (see header). */
function guardConnection(db: Database.Database, name: string, watch: FifoWatch): void {
  const arm = watch.arm.bind(watch);
  const prepare = db.prepare.bind(db) as Database.Database['prepare'];
  const pragma = db.pragma.bind(db);
  const exec = db.exec.bind(db);
  const transaction = db.transaction.bind(db);
  const close = db.close.bind(db);
  const { cookie, begin, beginImmediate, commit, rollback } = arm(() => ({
    cookie: prepare('PRAGMA schema_version').pluck(),
    begin: prepare('BEGIN'),
    beginImmediate: prepare('BEGIN IMMEDIATE'),
    commit: prepare('COMMIT'),
    rollback: prepare('ROLLBACK'),
  }));
  let verified: number | null = null;
  const assertPlain = () => {
    // The cookie changes with every schema change, and SQLite re-parses the
    // schema exactly when it does: an unchanged cookie means the schema this
    // connection runs is the one already checked.
    const version = cookie.get() as number;
    if (version === verified) return;
    const why = unsafeSchema(prepare);
    if (why) refuse(name, why);
    verified = version;
  };
  const guarded = <R>(write: boolean, run: () => R): R =>
    arm(() => {
      if (db.inTransaction) {
        assertPlain();
        return run();
      }
      (write ? beginImmediate : begin).run();
      try {
        assertPlain();
        const result = run();
        commit.run();
        return result;
      } catch (err) {
        if (db.inTransaction) rollback.run();
        throw err;
      }
    });
  db.prepare = ((source: string) => {
    const stmt = arm(() => prepare(source));
    if (PASS_THROUGH.test(source)) {
      const s = stmt as unknown as Record<string, unknown>;
      for (const method of ['get', 'all', 'run'] as const) {
        const fn = stmt[method] as (...a: unknown[]) => unknown;
        s[method] = (...args: unknown[]) => arm(() => fn.apply(stmt, args));
      }
      return stmt;
    }
    // A statement that writes (RETURNING included) takes the write lock up
    // front: upgrading a read lock would fail busy without waiting.
    const write = !stmt.readonly;
    const { get, all, run, iterate } = stmt;
    const s = stmt as unknown as Record<string, unknown>;
    s.get = (...args: unknown[]) => guarded(write, () => get.apply(stmt, args as never));
    s.all = (...args: unknown[]) => guarded(write, () => all.apply(stmt, args as never));
    s.run = (...args: unknown[]) => guarded(write, () => run.apply(stmt, args as never));
    // Rows are read inside the guard (and the watch), then yielded.
    s.iterate = (...args: unknown[]) =>
      guarded(write, () => [...iterate.apply(stmt, args as never)])[Symbol.iterator]();
    return stmt;
  }) as Database.Database['prepare'];
  db.pragma = ((source: string, options?: Database.PragmaOptions) =>
    arm(() => pragma(source, options))) as Database.Database['pragma'];
  // exec runs DDL only on these files (CREATE ... IF NOT EXISTS); DDL does
  // not evaluate existing schema SQL.
  db.exec = ((source: string) => {
    arm(() => exec(source));
    return db;
  }) as Database.Database['exec'];
  db.transaction = ((fn: (...a: unknown[]) => unknown) => {
    const tx = transaction(fn);
    const wrap =
      (f: (...a: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        arm(() => f(...args));
    const wrapped = wrap(tx) as unknown as Record<string, unknown>;
    for (const mode of ['deferred', 'immediate', 'exclusive'] as const)
      wrapped[mode] = wrap((tx as unknown as Record<string, (...a: unknown[]) => unknown>)[mode]);
    return wrapped;
  }) as unknown as Database.Database['transaction'];
  db.close = (() => {
    try {
      return arm(() => close());
    } finally {
      watch.dispose();
    }
  }) as Database.Database['close'];
}

function refuse(name: string, why: string): never {
  throw new UnsafeSessionDbError(`refusing session database '${name}': ${why}`);
}

function regularIdentity(dir: AnchoredDir, name: string): { dev: bigint; ino: bigint } | null {
  const st = dir.lstatExact(name);
  if (!st) return null;
  if (!st.isFile()) refuse(name, st.isSymbolicLink() ? 'it is a symlink' : 'it is not a regular file');
  return { dev: st.dev, ino: st.ino };
}

const SIDE_FILES = ['-journal', '-wal', '-shm'];

/**
 * Open `name` inside `dir`. The returned connection owns `dir`: closing the
 * connection closes the directory descriptor (the anchored path is only
 * valid while it is open). On failure `dir` is closed too. Closing twice is
 * a no-op.
 */
export function openAnchoredDb(
  dir: AnchoredDir,
  name: string,
  mode: 'readonly' | 'readwrite',
  options: AnchoredDbOptions = {},
): Database.Database {
  let db: Database.Database | undefined;
  const container = (options.schema ?? 'container') === 'container';
  let watch: FifoWatch | null = null;
  try {
    const before = regularIdentity(dir, name);
    if (!before) refuse(name, 'it does not exist');
    const file = dir.pathOf(name);
    if (container) watch = watchFifos([file, ...SIDE_FILES.map((suffix) => dir.pathOf(name + suffix))]);
    // A container can hold this file's lock indefinitely: wait only briefly
    // (synchronously) in SQLite. See busy.ts.
    const open = () =>
      new Database(file, { readonly: mode === 'readonly', fileMustExist: true, timeout: SESSION_DB_BUSY_TIMEOUT_MS });
    db = watch ? watch.arm(open) : open();
    // database_list reads no page: it reports the path SQLite resolved.
    const main = (db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find(
      (row) => row.name === 'main',
    );
    if (!main?.file) refuse(name, 'SQLite reported no file');
    const resolved = fs.lstatSync(main.file, { bigint: true, throwIfNoEntry: false });
    if (!resolved || !resolved.isFile() || resolved.dev !== before.dev || resolved.ino !== before.ino) {
      refuse(name, 'it was reached through a symlink');
    }
    const after = regularIdentity(dir, name);
    if (!after || after.dev !== before.dev || after.ino !== before.ino) refuse(name, 'it changed while opening');
    const opened = db;
    if (watch) {
      // No container-authored function runs from schema code either.
      opened.pragma('trusted_schema = OFF');
      guardConnection(opened, name, watch);
    }
    const close = opened.close.bind(opened);
    let closed = false;
    // Idempotent: a second close must not close the directory descriptor
    // number again (by then it may belong to an unrelated file).
    opened.close = () => {
      if (closed) return opened;
      closed = true;
      try {
        return close();
      } finally {
        dir.close();
      }
    };
    return opened;
  } catch (err) {
    try {
      const failed = db;
      if (failed && watch) watch.arm(() => failed.close());
      else failed?.close();
    } finally {
      watch?.dispose();
      dir.close();
    }
    throw err;
  }
}

/**
 * Create `name` as an empty regular file (refusing anything, a symlink
 * included, that already holds the name). Returns false when it existed.
 */
export function createEmptyDbFile(dir: AnchoredDir, name: string): boolean {
  let fd: number;
  try {
    fd = dir.openNewFd(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  // An empty file is a valid empty SQLite database; the caller applies the
  // schema through openAnchoredDb.
  fs.closeSync(fd);
  return true;
}
