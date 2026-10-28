/**
 * Read-only host handles on a session folder's mailbox databases, reached
 * without following container-made links (see anchored-db.ts). For host
 * readers that address a session by its folder (scans of v2-sessions, the
 * dashboard's transcript and task views). Dependency-free beyond the anchored
 * opener so dashboard-server can import it directly.
 *
 * Both return null when the file (or the folder) is absent and throw
 * UnsafeSessionDbError when the name is a symlink or not a regular file.
 */
import type Database from 'better-sqlite3';

import { AnchoredDir } from '../../anchored-dir.js';
import { openAnchoredDb } from './anchored-db.js';
import { INBOUND_DB, MAILBOX_DIR, OUTBOUND_DB } from './names.js';

export type SessionLayout = 'current' | 'legacy' | 'absent';

export function isRegular(dir: AnchoredDir, name: string): boolean {
  return dir.lstatExact(name)?.isFile() ?? false;
}

/** Layout of the session pinned by `session`. Reads only. */
export function layoutOf(session: AnchoredDir): SessionLayout {
  if (session.lstatExact(MAILBOX_DIR)?.isDirectory()) {
    const mailbox = session.openDir(MAILBOX_DIR);
    if (mailbox) {
      try {
        if (isRegular(mailbox, INBOUND_DB)) return 'current';
      } finally {
        mailbox.close();
      }
    }
  }
  return session.lstatExact(INBOUND_DB) ? 'legacy' : 'absent';
}

/**
 * Read-only handle on a session folder's inbound.db wherever the layout keeps
 * it (mailbox, or the legacy spot before migration), never through a link.
 * Null when there is none.
 */
export function openInboundReadonlyAt(sessionFolder: string): Database.Database | null {
  const session = AnchoredDir.open(sessionFolder, []);
  if (!session) return null;
  let layout: SessionLayout;
  try {
    layout = layoutOf(session);
  } catch (err) {
    session.close();
    throw err;
  }
  if (layout === 'absent') {
    session.close();
    return null;
  }
  if (layout === 'legacy') return openAnchoredDb(session, INBOUND_DB, 'readonly');
  session.close();
  const mailbox = AnchoredDir.open(sessionFolder, [MAILBOX_DIR]);
  // mailbox/ is read-only to the container: its inbound.db schema is the host's.
  return mailbox ? openAnchoredDb(mailbox, INBOUND_DB, 'readonly', { schema: 'host' }) : null;
}

/**
 * Handle on a session folder's container-written outbound.db, never through a
 * link. Null when the folder or the file is absent. Read-only by default;
 * `readwrite` is only for host maintenance with no container running.
 */
export function openOutboundAt(
  sessionFolder: string,
  mode: 'readonly' | 'readwrite' = 'readonly',
): Database.Database | null {
  const session = AnchoredDir.open(sessionFolder, []);
  if (!session) return null;
  try {
    if (!session.lstatExact(OUTBOUND_DB)) {
      session.close();
      return null;
    }
  } catch (err) {
    session.close();
    throw err;
  }
  // openAnchoredDb owns `session` from here and closes it on failure.
  return openAnchoredDb(session, OUTBOUND_DB, mode);
}

/** Read-only openOutboundAt. */
export function openOutboundReadonlyAt(sessionFolder: string): Database.Database | null {
  return openOutboundAt(sessionFolder, 'readonly');
}
