/**
 * Session mailbox file names. Dependency-free so host readers outside the
 * engine process (dashboard-server) can import them without engine config.
 *
 * MAILBOX_DIR is the host-owned folder inside the session folder that holds
 * inbound.db. The session folder is mounted read-write at /workspace, but this
 * folder is bind-mounted read-only on top of it at /workspace/mailbox, so a
 * running container can neither write inbound.db nor replace the folder or the
 * file name with a symlink (a mountpoint cannot be renamed or unlinked).
 * (Not `inbox/`: that holds inbound attachments.)
 */
export const MAILBOX_DIR = 'mailbox';
export const INBOUND_DB = 'inbound.db';
export const OUTBOUND_DB = 'outbound.db';
