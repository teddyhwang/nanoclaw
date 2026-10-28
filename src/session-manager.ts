/**
 * Session lifecycle: folders, mailboxes, messages, and container status.
 * Storage layout and consistency belong to the registered mailbox.
 */
import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';

import { AnchoredDir, AnchoredFileTooLargeError } from './anchored-dir.js';
import { deriveAttachmentName } from './attachment-naming.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { getPlatformCredentialReader } from './engine/platform-credentials.js';
import { transcribeAudio } from './media/transcription.js';
import { formatVideoMarker, processVideo } from './media/video.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { isUniqueViolation } from './db/errors.js';
import {
  createSession,
  findSystemSession,
  findSessionByAgentGroup,
  findSessionForAgent,
  findMostRecentClosedSessionForAgent,
  getSession,
  taskThreadId,
  updateSession,
} from './db/sessions.js';
import { log } from './log.js';
import { getAgentMailbox, type InboundMessage, type MailboxSession } from './mailbox/index.js';
import { enqueueSessionReconcile } from './reconcile-feeds.js';
import type { Session } from './types.js';

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

/** Host-owned runner context, kept outside the agent-writable session directory. */
export function sessionContextPath(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.context', `${sessionId}.json`);
}

/** Materialize the immutable context the runner receives at startup. */
export function writeSessionContext(agentGroupId: string, sessionId: string, mailbox: unknown): void {
  const contextPath = sessionContextPath(agentGroupId, sessionId);
  fs.mkdirSync(path.dirname(contextPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(contextPath, JSON.stringify({ agentGroupId, sessionId, mailbox }), { mode: 0o600 });
  fs.chmodSync(contextPath, 0o600);
}

/** Path to the container heartbeat file (touched instead of DB writes). */
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}

function mailboxKey(agentGroupId: string, sessionId: string) {
  return { agentGroupId, sessionId };
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const sessionCreationLocks = new Map<string, Promise<void>>();

async function withSessionCreationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionCreationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  sessionCreationLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sessionCreationLocks.get(key) === tail) sessionCreationLocks.delete(key);
  }
}

function sessionCreationKey(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): string {
  if (sessionMode === 'agent-shared') return `agent\0${agentGroupId}`;
  return `route\0${agentGroupId}\0${messagingGroupId ?? ''}\0${sessionMode === 'shared' ? '' : (threadId ?? '')}`;
}

/**
 * Carry recent due triggering chat rows from the latest closed matching
 * session into a newly provisioned mailbox. Reads, target inserts, and source
 * completion run in sequential sessions so no same-key nesting is possible.
 */
async function carryForwardRecentPendingChatRows(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  targetSessionId: string,
): Promise<void> {
  if (!messagingGroupId) return;
  const source = await findMostRecentClosedSessionForAgent(agentGroupId, messagingGroupId, threadId);
  if (!source) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await withExistingMailboxSession(agentGroupId, source.id, (mailbox) =>
    mailbox.getRecentPendingTriggeringChats(since),
  );
  if (!rows || rows.length === 0) return;

  await withMailboxSession(agentGroupId, targetSessionId, async (mailbox) => {
    for (const row of rows) {
      await mailbox.insertMessage(row);
    }
  });

  const marked = await withExistingMailboxSession(agentGroupId, source.id, (mailbox) => {
    mailbox.markMessagesCompleted(rows.map((row: InboundMessage) => row.id));
    return true;
  });
  if (!marked) {
    log.warn('Pending chat rows copied but source mailbox vanished before completion', {
      agentGroupId,
      sourceSessionId: source.id,
      targetSessionId,
      count: rows.length,
    });
    return;
  }

  log.info('Carried forward pending chat rows from closed session', {
    agentGroupId,
    messagingGroupId,
    threadId,
    sourceSessionId: source.id,
    targetSessionId,
    count: rows.length,
  });
}

/**
 * Find or create a session for a messaging group + thread.
 *
 * Session modes:
 * - 'shared': one session per messaging group (ignores threadId)
 * - 'per-thread': one session per (messaging group, thread)
 * - 'agent-shared': one session per agent group — all messaging groups
 *   wired with this mode share a single session (e.g. GitHub + Slack)
 */
export async function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): Promise<{ session: Session; created: boolean }> {
  const key = sessionCreationKey(agentGroupId, messagingGroupId, threadId, sessionMode);
  return withSessionCreationLock(key, async () => {
    // agent-shared: single session per agent group, regardless of messaging group
    if (sessionMode === 'agent-shared') {
      const existing = await findSessionByAgentGroup(agentGroupId);
      if (existing) {
        return { session: existing, created: false };
      }
    } else if (messagingGroupId) {
      const lookupThreadId = sessionMode === 'shared' ? null : threadId;
      // Scope lookup by agent_group_id so fan-out to multiple agents in the
      // same chat doesn't accidentally deliver to the wrong agent's session.
      const existing = await findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
      if (existing) {
        return { session: existing, created: false };
      }
    }

    const id = generateId();
    const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
    const session: Session = {
      id,
      agent_group_id: agentGroupId,
      messaging_group_id: messagingGroupId,
      thread_id: lookupThreadId,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };

    try {
      await createSession(session);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing =
        sessionMode === 'agent-shared'
          ? await findSessionByAgentGroup(agentGroupId)
          : messagingGroupId
            ? await findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId)
            : undefined;
      if (!existing) throw error;
      return { session: existing, created: false };
    }
    initSessionFolder(agentGroupId, id);
    await carryForwardRecentPendingChatRows(agentGroupId, messagingGroupId, lookupThreadId, id);
    log.info('Session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId, sessionMode });

    return { session, created: true };
  });
}

/** Find or create the per-agent-group session used for scheduled tasks. */
/** Find or create the isolated session for one task series (thread `system:tasks:<seriesId>`). */
export async function resolveTaskSession(
  agentGroupId: string,
  seriesId: string,
): Promise<{ session: Session; created: boolean }> {
  const threadId = taskThreadId(seriesId);
  return withSessionCreationLock(`system\0${agentGroupId}\0${threadId}`, async () => {
    const existing = await findSystemSession(agentGroupId, threadId);
    if (existing) return { session: existing, created: false };

    const id = generateId();
    const session: Session = {
      id,
      agent_group_id: agentGroupId,
      messaging_group_id: null,
      thread_id: threadId,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };

    try {
      await createSession(session);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await findSystemSession(agentGroupId, threadId);
      if (!raced) throw error;
      return { session: raced, created: false };
    }
    initSessionFolder(agentGroupId, id);
    log.info('Task session created', { id, agentGroupId, seriesId });

    return { session, created: true };
  });
}

/** Create the workspace folders and synchronously prepare the registered mailbox. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  getAgentMailbox().prepare(mailboxKey(agentGroupId, sessionId));
}

/** Destroy one session's implementation-owned mailbox after its container stops. */
export async function destroySessionMailbox(agentGroupId: string, sessionId: string): Promise<void> {
  await getAgentMailbox().destroy(mailboxKey(agentGroupId, sessionId));
  fs.rmSync(sessionContextPath(agentGroupId, sessionId), { force: true });
}

/**
 * Write the current chat/thread routing for a session into its inbound mailbox.
 *
 * The container uses this to preserve source-chat routing. Prefer the latest
 * triggering, user-facing chat row (critical for agent-shared sessions), then
 * fall back to session.messaging_group_id before setting the route.
 *
 * Called on every container wake alongside the agent-to-agent module's
 * writeDestinations() (when installed) so the latest routing is always in
 * place, including after admin rewiring.
 */
export async function writeSessionRouting(agentGroupId: string, sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  let channelType: string | null = null;
  let platformId: string | null = null;

  const latest = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
    mailbox.getLatestTriggeringChatRouting(),
  );
  if (latest) {
    channelType = latest.channelType;
    platformId = latest.platformId;
  }

  // A new session may not have a triggering row yet. Its pinned messaging
  // group is the best available bootstrap route, but never overrides a later
  // source-chat row in an agent-shared session.
  if ((!channelType || !platformId) && session.messaging_group_id) {
    const mg = await getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
    }
  }

  await withMailboxSession(agentGroupId, sessionId, (mailbox) => {
    mailbox.setRouting({
      channelType,
      platformId,
      threadId: session.thread_id,
    });
  });
  log.debug('Session routing written', { sessionId, channelType, platformId, threadId: session.thread_id });
}

/**
 * Write a message to a session's inbound mailbox. Host-only.
 * Resolves to the exact persisted content (see writeSessionMessageOnce).
 */
export async function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageWrite,
  options?: SessionMessageWriteOptions,
): Promise<string> {
  return (await writeSessionMessageOnce(agentGroupId, sessionId, message, options)).content;
}

export interface SessionMessageWriteOptions {
  /**
   * Runs synchronously the moment the row is durable, inside the mailbox
   * session, before this write yields to any timer or I/O callback. A
   * running runner can see the row from then on, but its claim of the row
   * reaches the host only through a host callback, which cannot run before
   * this hook returns. Record per-row host state the claim depends on
   * (requester provenance) here, never after the write resolves: the write's
   * own later awaits are a window in which the claim can already be handled.
   * Must stay synchronous and must not open a mailbox session for this
   * session. Called once, for a duplicate too (`inserted: false`). A throw is
   * rethrown after the write has finished its own bookkeeping.
   */
  onWritten?: (result: { content: string; inserted: boolean }) => void;
}

/**
 * writeSessionMessage that also reports whether this call created the row.
 * `inserted: false` means a row with that id was already in the mailbox (a
 * retry or redelivery; ids are idempotent), so nothing was written and the
 * existing row may already have been handled. Callers that record per-row
 * side state (provenance, receipts) must not record it again for a duplicate.
 */
export async function writeSessionMessageOnce(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageWrite,
  options: SessionMessageWriteOptions = {},
): Promise<{ content: string; inserted: boolean }> {
  // Documented reset: operators `rm -rf` a session folder to clear a stuck
  // session. The sessions row survives, so the next message takes the
  // existing-session path and lands here with a missing mailbox — the open
  // below would throw and the message would be logged-and-dropped forever.
  // Re-provision the folder + mailbox (initSessionFolder is idempotent) so the
  // documented reset actually re-provisions instead of killing the chat.
  initSessionFolder(agentGroupId, sessionId);

  // Process media before opening the mailbox write session: attachment I/O,
  // transcription, and video analysis may be slow and must not hold the key.
  const content = await extractAttachmentFiles(agentGroupId, sessionId, message.id, message.content);

  let inserted = false;
  let hookError: { err: unknown } | undefined;
  await withMailboxSession(agentGroupId, sessionId, async (mailbox) => {
    inserted = await mailbox.insertMessage({
      id: message.id,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      content,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
      trigger: message.trigger ?? true,
      sourceSessionId: message.sourceSessionId ?? null,
      onWake: message.onWake ?? false,
    });
    // No macrotask has run since the insert committed (only microtasks).
    if (options.onWritten) {
      try {
        options.onWritten({ content, inserted });
      } catch (err) {
        hookError = { err };
      }
    }
  });
  await updateSession(sessionId, { last_active: new Date().toISOString() });
  // Ask for a prompt reconcile now that the message is durable: a wake that
  // fails transiently is retried within the queue's cadence instead of
  // waiting for the next resync tick. No-op when the sweep isn't running.
  enqueueSessionReconcile(sessionId);
  if (hookError) throw hookError.err;
  // The exact content persisted (attachment `data` replaced by `localPath`).
  // Trusted callers forward THIS to provenance capture so its hash matches the
  // stored row; it is the insertion value, not a mailbox reread.
  return { content, inserted };
}

export type SessionMessageWrite = {
  id: string;
  kind: InboundMessage['kind'];
  timestamp: string;
  platformId?: string | null;
  channelType?: string | null;
  threadId?: string | null;
  content: string;
  processAfter?: string | null;
  recurrence?: string | null;
  /**
   * true = this message should wake the agent (the default); false = accumulate
   * as context only, don't wake. Host's countDueMessages gates on this
   * column; the container still reads all prior messages as context when
   * a triggering message does arrive.
   */
  trigger?: boolean;
  /**
   * For agent-to-agent inbound: the source session id that emitted the
   * outbound message which became this inbound row. Used as the return
   * path so the target's reply routes back to that exact session.
   */
  sourceSessionId?: string | null;
  /**
   * true = only deliver on the container's first poll (fresh start).
   * Dying containers (past first poll) skip these rows.
   */
  onWake?: boolean;
};

/**
 * If message content has attachments with base64 `data`, save them to
 * the session's inbox directory and replace with `localPath`.
 *
 * Both `messageId` and `att.name` originate in untrusted input. WhatsApp
 * passes `msg.key.id` through raw (and that field is client generated, so a
 * peer can craft it), and other adapters may follow. The session dir is
 * mounted writable into the container, so the agent owns the `inbox` and
 * `inbox/<msgId>` names and can turn either into a symlink at any time.
 *
 * Defenses:
 *   1. basename check on `messageId` and `filename`.
 *   2. `inbox/<messageId>` is opened as an AnchoredDir, refusing symlinks, and
 *      every attachment is written through that descriptor, so a later swap
 *      of either name cannot redirect a write.
 *   3. exclusive create: never follows or overwrites an existing entry.
 */
async function extractAttachmentFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  contentStr: string,
): Promise<string> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return contentStr;

  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe inbound message id', { messageId });
    return contentStr;
  }

  // Opened lazily on the first attachment that actually carries bytes, so a
  // message whose attachments have no inline `data` never creates an inbox dir.
  let inbox: AnchoredDir | null | undefined;

  let changed = false;
  const syntheticFrames: Array<Record<string, unknown>> = [];
  try {
    for (const att of attachments) {
      if (typeof att.data !== 'string') continue;

      const rawName = deriveAttachmentName(att);
      const filename = isSafeAttachmentName(rawName) ? rawName : `attachment-${Date.now()}`;
      if (filename !== rawName) {
        log.warn('Refused unsafe attachment filename, would escape inbox', {
          messageId,
          rawName,
          replacement: filename,
        });
      }

      if (inbox === undefined) {
        try {
          inbox = AnchoredDir.open(sessionDir(agentGroupId, sessionId), ['inbox', messageId], true);
        } catch (err) {
          log.warn('Rejecting unsafe inbox directory', { messageId, err });
          inbox = null;
        }
      }
      // Unsafe inbox — no attachment can be written safely.
      if (!inbox) break;

      // Decode the base64 buffer ONCE here. Used immediately for the
      // optional transcription pass (audio attachments) AND for the
      // write-to-inbox step. Avoids the cost of decoding twice for a
      // single voice message.
      const buffer = Buffer.from(att.data as string, 'base64');

      // Transcription pass — audio attachments get a host-side
      // transcript stamped onto `att.transcript` before the file lands
      // on disk. Channel-agnostic: every adapter that emits an audio
      // attachment with `data` (post-S367 WhatsApp + chat-sdk-bridge
      // channels) gets transcribed once here. Adapters MUST NOT
      // transcribe inline anymore — the engine owns the single site.
      //
      // Failures fall through to the file-write below: the agent still
      // sees the attachment marker; only the transcript text is missing.
      if (isVoiceAttachment(att)) {
        const reader = getPlatformCredentialReader();
        try {
          const transcript = await transcribeAudio(buffer, {
            filename,
            mimeType: typeof att.mimeType === 'string' ? att.mimeType : undefined,
            getCredential: reader ?? undefined,
          });
          att.transcript = transcript;
          changed = true;
        } catch (err) {
          log.warn('Voice transcription threw — continuing without transcript', {
            messageId,
            filename,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Video processing pass — channel-agnostic, single engine site (same as
      // voice). Extracts keyframes into the inbox message dir + a Gemini
      // transcript/visual-summary, stamps `att.transcript`/`att.summary` for the
      // formatter, and queues the keyframes as synthetic `type:'image'`
      // attachments so they ride the container's existing vision rail. Failures
      // fall through: the agent still sees the `[video: …]` marker.
      if (isVideoAttachment(att)) {
        const reader = getPlatformCredentialReader();
        try {
          const result = await processVideo(buffer, {
            frameDir: path.join(sessionDir(agentGroupId, sessionId), 'inbox', messageId),
            frameOutput: inbox,
            mimeType: typeof att.mimeType === 'string' ? att.mimeType : undefined,
            getCredential: reader ?? undefined,
          });
          if (result) {
            att.transcript = result.transcript;
            att.summary = result.summary;
            att.videoMarker = formatVideoMarker(result.transcript, result.summary, result.transcriptStatus);
            for (const frame of result.frames) {
              syntheticFrames.push({
                type: 'image',
                name: frame.filename,
                mimeType: 'image/jpeg',
                localPath: `inbox/${messageId}/${frame.filename}`,
                fromVideo: filename,
              });
            }
            changed = true;
          }
        } catch (err) {
          log.warn('Video processing threw — continuing without transcript/frames', {
            messageId,
            filename,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      try {
        inbox.writeNewFile(filename, buffer);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EEXIST') {
          log.warn('Inbox attachment target already exists, refusing to overwrite', {
            messageId,
            filename,
          });
          continue;
        }
        throw err;
      }

      att.name = filename;
      att.localPath = `inbox/${messageId}/${filename}`;
      delete att.data;
      changed = true;
      log.debug('Saved attachment to inbox', { messageId, filename, size: att.size });
    }
  } finally {
    inbox?.close();
  }

  // Append video-derived keyframes after iteration so the container's
  // `extractImageAttachments` surfaces them as vision blocks. They carry a
  // `localPath` (host wrote the bytes in the video branch) but no `data`, so
  // the attachment-file loop above would have skipped them anyway.
  if (syntheticFrames.length > 0) {
    attachments.push(...syntheticFrames);
    changed = true;
  }

  return changed ? JSON.stringify(parsed) : contentStr;
}

/** Identify audio/voice attachments by semantic type or MIME. */
function isVoiceAttachment(att: Record<string, unknown>): boolean {
  const type = typeof att.type === 'string' ? att.type : '';
  if (type === 'audio' || type === 'voice') return true;
  const mime = typeof att.mimeType === 'string' ? att.mimeType : '';
  return mime.startsWith('audio/');
}

/**
 * Identify video attachments for the host-side processing pass. Matches the
 * `video` type tag AND any `video/` mimeType. Excludes the gifv/animated case
 * that chat-sdk-bridge already rewrote to `type:'image'` (image/gif) before
 * the engine sees it — those carry `image/*` mimeTypes and a non-video type.
 */
function isVideoAttachment(att: Record<string, unknown>): boolean {
  const type = typeof att.type === 'string' ? att.type : '';
  const mime = typeof att.mimeType === 'string' ? att.mimeType : '';
  if (type === 'video') return true;
  return mime.startsWith('video/');
}
/**
 * Detects same-key session() nesting, which is forbidden: implementations may
 * serialize session() per key, so a nested call may deadlock. Tracked per async context so
 * legitimately concurrent top-level sessions on the same key don't trip it.
 */
const activeMailboxKeys = new AsyncLocalStorage<ReadonlySet<string>>();

/** Run one host operation against a session mailbox. The implementation owns persistence.
 *
 * Never call this (directly or via helpers like writeSessionMessage) from
 * inside another withMailboxSession action on the same session — finish the
 * open session first. See AgentMailbox.session in src/mailbox/types.ts.
 */
export function withMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: MailboxSession) => T | Promise<T>,
): Promise<T> {
  return runMailboxSession(agentGroupId, sessionId, action, true) as Promise<T>;
}

/** Run against an already-provisioned mailbox without creating storage. */
export function withExistingMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: MailboxSession) => T | Promise<T>,
): Promise<T | undefined> {
  return runMailboxSession(agentGroupId, sessionId, action, false);
}

async function runMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: MailboxSession) => T | Promise<T>,
  provision: boolean,
): Promise<T | undefined> {
  const store = getAgentMailbox();
  const key = mailboxKey(agentGroupId, sessionId);
  const keyId = `${agentGroupId}/${sessionId}`;
  const held = activeMailboxKeys.getStore();
  if (held?.has(keyId)) {
    throw new Error(`Nested mailbox session for ${keyId} — serialized implementations would deadlock here`);
  }
  if (provision) store.prepare(key);
  else if (!(await store.exists(key))) return undefined;
  return activeMailboxKeys.run(new Set(held).add(keyId), () => store.session(key, action));
}

/**
 * Write a message directly to a session's outbound mailbox so the host delivery
 * loop picks it up. Used by the command gate to send denial responses
 * without waking a container.
 *
 * The selected mailbox owns persistence and sequencing.
 */
export function writeOutboundDirect(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  },
): Promise<void> {
  return withMailboxSession(agentGroupId, sessionId, (mailbox) => mailbox.writeDirect(message));
}

/**
 * Largest single outbox attachment the host loads into memory for delivery.
 * 100 MiB matches the largest upload any channel accepts (Discord, boosted
 * servers); a larger file could not be delivered anyway, so it is skipped
 * with a warning instead of being read.
 */
export const OUTBOX_FILE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Load outbox attachments for a delivered message.
 *
 * Symmetric with `extractAttachmentFiles` on the inbound side: the container
 * writes files into the session's `outbox/<messageId>/` directory alongside
 * its outbound message, and the host reads them back at delivery time.
 *
 * Returns undefined when the outbox dir is missing or no declared file was
 * actually on disk — delivery continues without attachments rather than
 * failing the whole message.
 */
export function readOutboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  filenames: string[],
): OutboundFile[] | undefined {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox message id', { messageId });
    return undefined;
  }

  // The container owns `outbox` and everything below it: read only through
  // descriptors, refusing symlinks at every level.
  let outbox: AnchoredDir | null;
  try {
    outbox = AnchoredDir.open(sessionDir(agentGroupId, sessionId), ['outbox', messageId]);
  } catch (err) {
    log.warn('Rejecting unsafe outbox directory', { messageId, err });
    return undefined;
  }
  if (!outbox) return undefined;

  const files: OutboundFile[] = [];
  try {
    for (const filename of filenames) {
      if (!isSafeAttachmentName(filename)) {
        log.warn('Refused unsafe outbox filename, would escape outbox', { messageId, filename });
        continue;
      }
      try {
        files.push({ filename, data: outbox.readFile(filename, { maxBytes: OUTBOX_FILE_MAX_BYTES }) });
      } catch (err) {
        if (err instanceof AnchoredFileTooLargeError) {
          log.warn('Outbox file over the size limit, not delivered', {
            messageId,
            filename,
            size: err.size,
            maxBytes: err.maxBytes,
          });
          continue;
        }
        log.warn('Outbox file missing or not a regular file', { messageId, filename, err });
      }
    }
  } finally {
    outbox.close();
  }
  return files.length > 0 ? files : undefined;
}

/**
 * Remove a message's outbox directory after successful delivery. Best-effort:
 * failures log and swallow. A cleanup failure must NOT propagate to the
 * delivery caller — the message is already on the user's screen, and a
 * thrown error would trigger the delivery retry path and deliver twice.
 */
export function clearOutbox(agentGroupId: string, sessionId: string, messageId: string): void {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox cleanup message id', { messageId });
    return;
  }

  let outbox: AnchoredDir | null = null;
  try {
    outbox = AnchoredDir.open(sessionDir(agentGroupId, sessionId), ['outbox']);
    const dir = outbox?.openDir(messageId);
    if (!outbox || !dir) return;
    // One level, no recursion: a message outbox holds the files it delivered.
    // Anything else surfaces as an error below instead of being walked.
    try {
      for (const entry of dir.entries()) dir.unlink(entry);
    } finally {
      dir.close();
    }
    outbox.rmdir(messageId);
  } catch (err) {
    log.warn('Outbox cleanup failed (message already delivered)', { messageId, err });
  } finally {
    outbox?.close();
  }
}

/** Mark a container as running for a session. */
export async function markContainerRunning(sessionId: string): Promise<void> {
  await updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
}

/** Mark a container as idle for a session. */
export async function markContainerIdle(sessionId: string): Promise<void> {
  await updateSession(sessionId, { container_status: 'idle' });
}

/** Mark a container as stopped for a session. */
export async function markContainerStopped(sessionId: string): Promise<void> {
  await updateSession(sessionId, { container_status: 'stopped' });
}
