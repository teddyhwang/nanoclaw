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
 * Two more container moves are neutralized here:
 *   - A FIFO swapped in at the name between check 1 and SQLite's open would
 *     block that open (a read-only open of a FIFO waits for a writer) and so
 *     the whole host event loop. A watchdog thread opens the name for writing
 *     non-blocking, only while it is a FIFO and only while this thread is
 *     inside the open, which releases the open; the checks then refuse it.
 *   - A container-written database's schema is the container's: a table the
 *     host queries can be swapped for a view (e.g. an endless recursive CTE)
 *     or carry triggers that run on host writes. Unless the file is
 *     host-owned (`schema: 'host'`), every statement runs only after
 *     checking, inside the same transaction (so the schema cannot change in
 *     between), that the schema has no view, trigger or virtual table.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { Worker } from 'worker_threads';

import type { AnchoredDir } from '../../anchored-dir.js';

export class UnsafeSessionDbError extends Error {}

export interface AnchoredDbOptions {
  /**
   * Who can write the file's schema. `container` (default): the file lives
   * in a container-writable folder, so its schema is guarded (see header).
   * `host`: the file is host-owned (e.g. mailbox/inbound.db, read-only to the
   * container); no guard.
   */
  schema?: 'container' | 'host';
}

// ── FIFO watchdog ───────────────────────────────────────────────────────────
// One unref'd worker per process. flag[0] holds the id of the open in
// progress (0 = none); the worker gets the path by message and, while the
// flag still holds that id, every 20 ms opens the name O_WRONLY|O_NONBLOCK
// only if lstat shows a FIFO. A writer arriving releases a blocked reader.
const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const flag = new Int32Array(workerData);
const { O_WRONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
parentPort.on('message', ({ id, path }) => {
  while (Atomics.wait(flag, 0, id, 20) === 'timed-out') {
    try {
      const st = fs.lstatSync(path, { throwIfNoEntry: false });
      if (st && st.isFIFO()) fs.closeSync(fs.openSync(path, O_WRONLY | O_NONBLOCK | O_NOFOLLOW));
    } catch {}
  }
});
`;
let watchdog: { worker: Worker; flag: Int32Array } | null = null;
let nextOpenId = 0;

function fifoWatchdog(): { worker: Worker; flag: Int32Array } {
  if (watchdog) return watchdog;
  const shared = new SharedArrayBuffer(4);
  const worker = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: shared });
  worker.unref();
  worker.on('error', () => {
    if (watchdog?.worker === worker) watchdog = null;
  });
  worker.on('exit', () => {
    if (watchdog?.worker === worker) watchdog = null;
  });
  watchdog = { worker, flag: new Int32Array(shared) };
  return watchdog;
}

/** Run a synchronous open of `path` that a FIFO at `path` cannot block forever. */
export function withFifoWatchdog<T>(path: string, open: () => T): T {
  const { worker, flag } = fifoWatchdog();
  nextOpenId = (nextOpenId % 0x7ffffffe) + 1;
  const id = nextOpenId;
  Atomics.store(flag, 0, id);
  worker.postMessage({ id, path });
  try {
    return open();
  } finally {
    Atomics.store(flag, 0, 0);
    Atomics.notify(flag, 0);
  }
}

// ── Schema guard ────────────────────────────────────────────────────────────
const UNSAFE_SCHEMA = `SELECT type, name FROM sqlite_master
  WHERE type IN ('view', 'trigger')
     OR (type = 'table' AND upper(substr(ltrim(sql), 1, 20)) = 'CREATE VIRTUAL TABLE')
  LIMIT 1`;

/**
 * Throw UnsafeSessionDbError unless the schema is plain tables and indexes
 * (no view, trigger or virtual table). The host's mailbox schemas have none.
 */
export function assertPlainSchema(db: Database.Database, name: string): void {
  const bad = db.prepare(UNSAFE_SCHEMA).get() as { type: string; name: string } | undefined;
  if (bad) refuse(name, `its schema has a ${bad.type} (${JSON.stringify(bad.name)})`);
}

// Transaction control, pragmas and statements SQLite refuses inside a
// transaction pass through unwrapped; none of them evaluates a view or
// fires a trigger.
const TX_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ATTACH|DETACH)\b/i;

/**
 * Make every statement prepared on `db` check the schema first, in the same
 * transaction as the statement itself: reads in a deferred transaction (the
 * check's read takes the shared lock, so no writer can commit a schema change
 * before the statement finishes; in WAL the snapshot is fixed), writes in an
 * immediate one. Inside a caller's transaction the check just runs first.
 * Pragmas and transactions (better-sqlite3 prepares those natively) and
 * exec() (only DDL/VACUUM on these files; neither evaluates a view or fires
 * a trigger) are not wrapped.
 */
function guardSchema(db: Database.Database, name: string): void {
  const prepare = db.prepare.bind(db) as Database.Database['prepare'];
  const check = prepare(UNSAFE_SCHEMA);
  const begin = prepare('BEGIN');
  const beginImmediate = prepare('BEGIN IMMEDIATE');
  const commit = prepare('COMMIT');
  const rollback = prepare('ROLLBACK');
  const assertPlain = () => {
    const bad = check.get() as { type: string; name: string } | undefined;
    if (bad) refuse(name, `its schema has a ${bad.type} (${JSON.stringify(bad.name)})`);
  };
  const guarded = <R>(write: boolean, run: () => R): R => {
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
  };
  db.prepare = ((source: string) => {
    const stmt = prepare(source);
    if (TX_CONTROL.test(source)) return stmt;
    const write = !stmt.reader;
    const { get, all, run, iterate } = stmt;
    const s = stmt as unknown as Record<string, unknown>;
    s.get = (...args: unknown[]) => guarded(write, () => get.apply(stmt, args as never));
    s.all = (...args: unknown[]) => guarded(write, () => all.apply(stmt, args as never));
    s.run = (...args: unknown[]) => guarded(write, () => run.apply(stmt, args as never));
    // Outside a transaction, rows are read inside the guard and then yielded.
    s.iterate = (...args: unknown[]) =>
      db.inTransaction
        ? (assertPlain(), iterate.apply(stmt, args as never))
        : guarded(write, () => [...iterate.apply(stmt, args as never)])[Symbol.iterator]();
    return stmt;
  }) as Database.Database['prepare'];
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

/**
 * Open `name` inside `dir`. The returned connection owns `dir`: closing the
 * connection closes the directory descriptor (the anchored path is only
 * valid while it is open). On failure `dir` is closed too.
 */
export function openAnchoredDb(
  dir: AnchoredDir,
  name: string,
  mode: 'readonly' | 'readwrite',
  options: AnchoredDbOptions = {},
): Database.Database {
  let db: Database.Database | undefined;
  try {
    const before = regularIdentity(dir, name);
    if (!before) refuse(name, 'it does not exist');
    const file = dir.pathOf(name);
    db = withFifoWatchdog(file, () => new Database(file, { readonly: mode === 'readonly', fileMustExist: true }));
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
    if ((options.schema ?? 'container') === 'container') {
      // No container-authored function runs from schema code either.
      opened.pragma('trusted_schema = OFF');
      guardSchema(opened, name);
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
      db?.close();
    } finally {
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
