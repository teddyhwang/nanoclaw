/**
 * Open a per-session SQLite file without following a container-planted link.
 *
 * The session folder is mounted read-write at /workspace, so the container
 * owns every name in it and can turn `outbound.db` into a symlink at any time.
 * better-sqlite3 opens by path and SQLite resolves symlinks in that path before
 * its O_NOFOLLOW open, so a path check before `new Database(path)` is a
 * check-then-use race and the host would create or modify the link's target.
 *
 * Here the directory is pinned by descriptor (AnchoredDir), the leaf must be a
 * regular file, SQLite is never allowed to create it (`fileMustExist`), and
 * after the open the file SQLite actually resolved must be the anchored path
 * itself (no link was followed) and the leaf must still be the same inode.
 * Any mismatch closes the connection before a single query touches the file.
 * SQLite opens journals as `<resolved db path>-journal` with O_NOFOLLOW, so
 * they stay anchored to the same directory too.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import type { AnchoredDir } from '../../anchored-dir.js';

export class UnsafeSessionDbError extends Error {}

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
export function openAnchoredDb(dir: AnchoredDir, name: string, mode: 'readonly' | 'readwrite'): Database.Database {
  let db: Database.Database | undefined;
  try {
    const before = regularIdentity(dir, name);
    if (!before) refuse(name, 'it does not exist');
    const expected = dir.pathOf(name);
    db = new Database(expected, { readonly: mode === 'readonly', fileMustExist: true });
    // database_list reads no page: it reports the path SQLite resolved.
    const main = (db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find(
      (row) => row.name === 'main',
    );
    if (main?.file !== expected) refuse(name, 'it was reached through a symlink');
    const after = regularIdentity(dir, name);
    if (!after || after.dev !== before.dev || after.ino !== before.ino) refuse(name, 'it changed while opening');
    const opened = db;
    const close = opened.close.bind(opened);
    opened.close = () => {
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
