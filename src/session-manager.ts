/**
 * Session lifecycle: folders, DBs, messages, container status.
 *
 * Two-DB split — inbound.db (host writes) + outbound.db (container writes).
 * Three cross-mount invariants are load-bearing:
 *   1. journal_mode=DELETE — WAL's mmapped -shm doesn't refresh host→guest;
 *      the container would silently miss every new message.
 *   2. Host opens-writes-CLOSES per op — close invalidates the container's
 *      page cache; a long-lived connection freezes its view at first read.
 *   3. One writer per file — DELETE-mode journal-unlink isn't atomic across
 *      the mount; concurrent writers corrupt the DB.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { deriveAttachmentName } from './attachment-naming.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { getPlatformCredentialReader } from './engine/platform-credentials.js';
import { transcribeAudio } from './media/transcription.js';
import { formatVideoMarker, processVideo } from './media/video.js';
import { ensureContainedInboxDir, isPathInside } from './inbox-safety.js';
import { getMessagingGroup } from './db/messaging-groups.js';
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
import {
  ensureSchema,
  openInboundDb as openInboundDbRaw,
  openOutboundDb as openOutboundDbRaw,
  openOutboundDbRw as openOutboundDbRwRaw,
  upsertSessionRouting,
  insertMessage,
  migrateMessagesInTable,
} from './db/session-db.js';
import { log } from './log.js';
import type { Session } from './types.js';

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

/** Path to the host-owned inbound DB (messages_in + delivered). */
export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'inbound.db');
}

/** Path to the container-owned outbound DB (messages_out + processing_ack). */
export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
}

/** Path to the container heartbeat file (touched instead of DB writes). */
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface PendingChatCarryForwardRow {
  id: string;
  kind: string;
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  process_after: string | null;
  recurrence: string | null;
  trigger: 0 | 1;
  source_session_id: string | null;
  on_wake: 0 | 1;
}

/**
 * When a chat gets a fresh session after the previous one was closed, recent
 * unanswered human messages in the closed session must ride into the new
 * queue. Otherwise a user can send "read above" and the new container sees
 * only that follow-up, not the actual pending request.
 */
function carryForwardRecentPendingChatRows(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  targetSessionId: string,
): void {
  if (!messagingGroupId) return;
  const source = findMostRecentClosedSessionForAgent(agentGroupId, messagingGroupId, threadId);
  if (!source) return;

  const sourceDbPath = inboundDbPath(agentGroupId, source.id);
  if (!fs.existsSync(sourceDbPath)) return;

  const sourceDb = openInboundDbRaw(sourceDbPath);
  const targetDb = openInboundDbRaw(inboundDbPath(agentGroupId, targetSessionId));
  try {
    const rows = sourceDb
      .prepare(
        `SELECT id, kind, timestamp, platform_id, channel_type, thread_id,
                content, process_after, recurrence, trigger, source_session_id, on_wake
           FROM messages_in
          WHERE status = 'pending'
            AND kind IN ('chat', 'chat-sdk')
            AND trigger = 1
            AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
            AND julianday(timestamp) >= julianday('now', '-1 day')
          ORDER BY seq ASC`,
      )
      .all() as PendingChatCarryForwardRow[];

    if (rows.length === 0) return;

    const markCompleted = sourceDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?");
    const tx = targetDb.transaction((pendingRows: PendingChatCarryForwardRow[]) => {
      for (const row of pendingRows) {
        insertMessage(targetDb, {
          id: row.id,
          kind: row.kind,
          timestamp: row.timestamp,
          platformId: row.platform_id,
          channelType: row.channel_type,
          threadId: row.thread_id,
          content: row.content,
          processAfter: row.process_after,
          recurrence: row.recurrence,
          trigger: row.trigger,
          sourceSessionId: row.source_session_id,
          onWake: row.on_wake,
        });
        markCompleted.run(row.id);
      }
    });
    tx(rows);
    log.info('Carried forward pending chat rows from closed session', {
      agentGroupId,
      messagingGroupId,
      threadId,
      sourceSessionId: source.id,
      targetSessionId,
      count: rows.length,
    });
  } finally {
    sourceDb.close();
    targetDb.close();
  }
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
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): { session: Session; created: boolean } {
  // agent-shared: single session per agent group, regardless of messaging group
  if (sessionMode === 'agent-shared') {
    const existing = findSessionByAgentGroup(agentGroupId);
    if (existing) {
      return { session: existing, created: false };
    }
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    // Scope lookup by agent_group_id so fan-out to multiple agents in the
    // same chat doesn't accidentally deliver to the wrong agent's session.
    const existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
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

  createSession(session);
  initSessionFolder(agentGroupId, id);
  carryForwardRecentPendingChatRows(agentGroupId, messagingGroupId, lookupThreadId, id);
  log.info('Session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId, sessionMode });

  return { session, created: true };
}

/** Find or create the per-agent-group session used for scheduled tasks. */
/** Find or create the isolated session for one task series (thread `system:tasks:<seriesId>`). */
export function resolveTaskSession(agentGroupId: string, seriesId: string): { session: Session; created: boolean } {
  const threadId = taskThreadId(seriesId);
  const existing = findSystemSession(agentGroupId, threadId);
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

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Task session created', { id, agentGroupId, seriesId });

  return { session, created: true };
}

/** Create the session folder and initialize both DBs. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });

  ensureSchema(inboundDbPath(agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(agentGroupId, sessionId), 'outbound');
}

/**
 * Write the default reply routing for a session into its inbound.db.
 *
 * The container reads this as the default (channel_type, platform_id, thread_id)
 * for outbound messages when the agent doesn't specify an explicit destination,
 * and (via getSessionRouting) as the source-chat coords stamped into
 * search_conversations / escalate_to_dev_agent requests.
 *
 * Coords are derived from session.messaging_group_id → messaging_groups row
 * for a single-chat session. For a **merged / agent-shared session**
 * (session.messaging_group_id is NULL by design — one session serves N
 * chats, e.g. the merged AI Friends / Boys Night / Golf "Degenerates"
 * group) that derivation yields NULL, which used to write empty
 * session_routing. That broke every consumer that needs "which chat is
 * this turn about": search_conversations fell through to its
 * no-chat-scope error (2026-05-17 AI Friends — user got "session has no
 * messaging_group_id and no source-chat coords"), and escalate_to_dev_agent
 * only worked by accident via a different coords path. Fix: when
 * messaging_group_id is NULL, fall back to the most-recent **triggering**
 * chat row in this session's inbound.db — that row's channel_type /
 * platform_id IS the chat the current wake is about (this is the same
 * per-message-coords mechanism the engine's delivery path already uses to
 * route agent-shared replies, not a parallel source of truth). thread_id
 * still comes from the session row.
 *
 * Called on every container wake alongside the agent-to-agent module's
 * writeDestinations() (when installed) so the latest routing is always in
 * place, including after admin rewiring.
 */
export function writeSessionRouting(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const session = getSession(sessionId);
  if (!session) return;

  let channelType: string | null = null;
  let platformId: string | null = null;

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    // PREFER the most-recent triggering chat row's coords — that row IS the
    // chat the current wake is about. The previous implementation preferred
    // session.messaging_group_id first and only used the trigger row for
    // null sessions, which broke wirings like the "Degenerates" merged
    // agent group: five chats (AI Friends, Boys Night, Golf, Cook,
    // Hung's Bday) share one agent group; the session created the first
    // time AI Friends woke the agent has `messaging_group_id =
    // mg-AI-Friends` and that ID never changes, so every escalation from
    // any of the other four chats was stamped as "from AI Friends".
    //
    // channel_type='agent' is the agent-to-agent pseudo-channel (see
    // agent-route.ts: it writes a2a inbound as kind='chat',
    // channel_type='agent'). It is NOT a user-facing chat scope —
    // getMessagingGroupByPlatform could never resolve it, and an A2A-only
    // session legitimately has no chat routing (bug #2332's known shape).
    // Exclude it so an a2a row never gets mistaken for "the chat this
    // wake is about".
    try {
      const row = db
        .prepare(
          `SELECT channel_type, platform_id
             FROM messages_in
            WHERE trigger = 1
              AND kind IN ('chat', 'chat-sdk')
              AND channel_type IS NOT NULL
              AND channel_type != 'agent'
              AND platform_id IS NOT NULL
            ORDER BY seq DESC
            LIMIT 1`,
        )
        .get() as { channel_type: string; platform_id: string } | undefined;
      if (row) {
        channelType = row.channel_type;
        platformId = row.platform_id;
      }
    } catch {
      // messages_in shape older than expected — fall through to the
      // session.messaging_group_id fallback below.
    }

    // Fallback to session.messaging_group_id for sessions that have not
    // yet seen a triggering chat row (a freshly-created single-chat
    // session that's about to receive its first wake; pre-trigger
    // bootstrap writes). The session's pinned messaging group is the
    // best available signal in that case.
    if ((!channelType || !platformId) && session.messaging_group_id) {
      const mg = getMessagingGroup(session.messaging_group_id);
      if (mg) {
        channelType = mg.channel_type;
        platformId = mg.platform_id;
      }
    }

    upsertSessionRouting(db, {
      channel_type: channelType,
      platform_id: platformId,
      thread_id: session.thread_id,
    });
  } finally {
    db.close();
  }
  log.debug('Session routing written', { sessionId, channelType, platformId, threadId: session.thread_id });
}

/**
 * Write a message to a session's inbound DB (messages_in). Host-only.
 *
 * ⚠ Opens and closes the DB on every call. Do not refactor to reuse a
 * long-lived connection — see the "Cross-mount visibility invariants" note
 * at the top of this file.
 */
export async function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    content: string;
    processAfter?: string | null;
    recurrence?: string | null;
    /**
     * 1 = this message should wake the agent (the default); 0 = accumulate
     * as context only, don't wake. Host's countDueMessages gates on this
     * column; the container still reads all prior messages as context when
     * a trigger-1 message does arrive.
     */
    trigger?: 0 | 1;
    /**
     * For agent-to-agent inbound: the source session id that emitted the
     * outbound message which became this inbound row. Used as the return
     * path so the target's reply routes back to that exact session.
     */
    sourceSessionId?: string | null;
    /**
     * 1 = only deliver on the container's first poll (fresh start).
     * Dying containers (past first poll) skip these rows.
     */
    onWake?: 0 | 1;
  },
): Promise<void> {
  // Documented reset: operators `rm -rf` a session folder to clear a stuck
  // session. The sessions row survives, so the next message takes the
  // existing-session path and lands here with a missing inbound.db — the open
  // below would throw and the message would be logged-and-dropped forever.
  // Re-provision the folder + DBs (initSessionFolder is idempotent) so the
  // documented reset actually re-provisions instead of killing the chat.
  if (!fs.existsSync(inboundDbPath(agentGroupId, sessionId))) {
    initSessionFolder(agentGroupId, sessionId);
  }

  // Extract base64 attachment data, save to inbox, replace with file paths.
  // Also runs the per-attachment audio-transcription pass so voice
  // messages land on disk with `att.transcript` populated for the
  // container formatter to render.
  const content = await extractAttachmentFiles(agentGroupId, sessionId, message.id, message.content);

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    insertMessage(db, {
      id: message.id,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      content,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
      trigger: message.trigger ?? 1,
      sourceSessionId: message.sourceSessionId ?? null,
      onWake: message.onWake ?? 0,
    });
  } finally {
    db.close();
  }

  updateSession(sessionId, { last_active: new Date().toISOString() });
}

/**
 * If message content has attachments with base64 `data`, save them to
 * the session's inbox directory and replace with `localPath`.
 *
 * Both `messageId` and `att.name` originate in untrusted input. WhatsApp
 * passes `msg.key.id` through raw (and that field is client generated, so a
 * peer can craft it), and other adapters may follow. The session dir is
 * mounted writable into the container, so a compromised agent can also
 * pre-place a symlink at `inbox/<future msgId>/` and wait for a chat message
 * with a matching id to redirect the host's write.
 *
 * Defenses, mirrored from the outbound side:
 *   1. basename check on `messageId` and `filename`.
 *   2. lstat of the inbox dir to refuse pre-placed symlinks.
 *   3. realpath-based containment under the session inbox root.
 *   4. `wx` flag on writeFileSync to refuse following a pre-existing symlink
 *      at the target file path or overwriting any existing file.
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

  const inboxRoot = path.join(sessionDir(agentGroupId, sessionId), 'inbox');
  // Resolved lazily on the first attachment that actually carries bytes, so a
  // message whose attachments have no inline `data` never creates an inbox dir.
  // ensureContainedInboxDir refuses a pre-placed symlink at the inbox root or
  // the per-message subdir before any write lands outside the sandbox (#2828).
  let inboxDir: string | null = null;
  let inboxResolved = false;

  let changed = false;
  // Synthetic `type:'image'` attachments for video keyframes. Collected
  // during the loop (mutating `attachments` mid-iteration is unsafe) and
  // appended after, so they flow through the container's existing
  // `extractImageAttachments` vision rail with no per-harness branching.
  const syntheticFrames: Array<Record<string, unknown>> = [];
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

    if (!inboxResolved) {
      inboxDir = ensureContainedInboxDir(inboxRoot, messageId, { messageId });
      inboxResolved = true;
    }
    // Unsafe inbox (symlink / escape) — no attachment can be written safely.
    if (!inboxDir) break;

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
          frameDir: inboxDir,
          mimeType: typeof att.mimeType === 'string' ? att.mimeType : undefined,
          getCredential: reader ?? undefined,
        });
        if (result) {
          att.transcript = result.transcript;
          att.summary = result.summary;
          att.videoMarker = formatVideoMarker(result.transcript, result.summary);
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

    const filePath = path.join(inboxDir, filename);
    try {
      // wx = exclusive create. Refuses to follow a pre existing symlink or
      // overwrite any existing file. The host expects to be the sole writer
      // of these attachments.
      fs.writeFileSync(filePath, buffer, { flag: 'wx' });
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

/**
 * Identify audio/voice attachments. Matches chat-sdk-bridge's audio type
 * tag AND any attachment with an `audio/` mimeType (catches doc-typed
 * voice memos some adapters surface).
 */
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

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const db = openInboundDbRaw(inboundDbPath(agentGroupId, sessionId));
  migrateMessagesInTable(db);
  return db;
}

/** Open a session's inbound DB, run `fn`, and always close it. */
export function withInboundDb<T>(agentGroupId: string, sessionId: string, fn: (db: Database.Database) => T): T {
  const db = openInboundDb(agentGroupId, sessionId);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRaw(outboundDbPath(agentGroupId, sessionId));
}

/** Open the outbound DB for a session with write access. Only safe to call when no container is running. */
export function openOutboundDbRw(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRwRaw(outboundDbPath(agentGroupId, sessionId));
}

/**
 * Write a message directly to a session's outbound DB so the host delivery
 * loop picks it up. Used by the command gate to send denial responses
 * without waking a container.
 *
 * Needs the read-write open — the readonly handle the delivery poll uses
 * can't INSERT. This is a host-side write to the container-owned outbound.db,
 * but it's safe even with a container running: both sides open with DELETE
 * journal + busy_timeout, and the even host seq stays out of the container's
 * odd-seq space.
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
): void {
  const db = openOutboundDbRw(agentGroupId, sessionId);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      new Date().toISOString(),
      message.kind,
      message.platformId,
      message.channelType,
      message.threadId,
      message.content,
    );
  } finally {
    db.close();
  }
}

/**
 * Load outbox attachments for a delivered message.
 *
 * Symmetric with `extractAttachmentFiles` on the inbound side: the container
 * writes files into the session's `outbox/<messageId>/` directory alongside
 * its `messages_out` row, and the host reads them back at delivery time.
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

  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return undefined;

  let realOutboxDir: string;
  try {
    const stat = fs.lstatSync(outboxDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      log.warn('Rejecting unsafe outbox directory', { messageId, outboxDir });
      return undefined;
    }
    realOutboxDir = fs.realpathSync(outboxDir);
  } catch (err) {
    log.warn('Failed to inspect outbox directory', { messageId, err });
    return undefined;
  }

  const files: OutboundFile[] = [];
  for (const filename of filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('Refused unsafe outbox filename, would escape outbox', { messageId, filename });
      continue;
    }

    const filePath = path.join(outboxDir, filename);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        log.warn('Rejecting unsafe outbox file', { messageId, filename });
        continue;
      }
      const realFilePath = fs.realpathSync(filePath);
      if (!isPathInside(realOutboxDir, realFilePath)) {
        log.warn('Rejecting outbox file outside message directory', { messageId, filename });
        continue;
      }
      files.push({ filename, data: fs.readFileSync(realFilePath) });
    } catch {
      log.warn('Outbox file not found', { messageId, filename });
    }
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

  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return;
  try {
    const stat = fs.lstatSync(outboxDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      log.warn('Rejecting unsafe outbox cleanup directory', { messageId, outboxDir });
      return;
    }
    const realOutboxBase = fs.realpathSync(path.join(sessionDir(agentGroupId, sessionId), 'outbox'));
    const realOutboxDir = fs.realpathSync(outboxDir);
    if (!isPathInside(realOutboxBase, realOutboxDir)) {
      log.warn('Rejecting outbox cleanup outside session outbox', { messageId, outboxDir });
      return;
    }
    fs.rmSync(realOutboxDir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Outbox cleanup failed (message already delivered)', { messageId, err });
  }
}

/** Mark a container as running for a session. */
export function markContainerRunning(sessionId: string): void {
  updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
}

/** Mark a container as idle for a session. */
export function markContainerIdle(sessionId: string): void {
  updateSession(sessionId, { container_status: 'idle' });
}

/** Mark a container as stopped for a session. */
export function markContainerStopped(sessionId: string): void {
  updateSession(sessionId, { container_status: 'stopped' });
}
