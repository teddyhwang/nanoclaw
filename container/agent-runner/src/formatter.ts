import fs from 'fs';
import path from 'path';

import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

const ADMIN_COMMANDS = new Set(['/remote-control', '/clear', '/compact', '/context', '/cost', '/files']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/start']);

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  const senderId = extractSenderId(msg, content);

  if (!text.startsWith('/')) {
    return { category: 'none', command: '', text, senderId };
  }

  // Extract the command name (e.g., '/clear' from '/clear some args')
  const command = text.split(/\s/)[0].toLowerCase();

  if (ADMIN_COMMANDS.has(command)) {
    return { category: 'admin', command, text, senderId };
  }

  if (FILTERED_COMMANDS.has(command)) {
    return { category: 'filtered', command, text, senderId };
  }

  return { category: 'passthrough', command, text, senderId };
}

/**
 * Narrow check for /clear — the only command the runner handles directly.
 * All other command gating (filtered, admin) is done by the host router
 * before messages reach the container.
 */
export function isClearCommand(msg: MessageInRow): boolean {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  return text.toLowerCase().startsWith('/clear');
}

/**
 * True for any chat that needs the outer loop's command path: /clear plus
 * admin/passthrough slash commands the SDK can only dispatch when they are
 * a query's first input. Used by the follow-up poller to bail out and let
 * the outer loop reopen the query.
 */
export function isRunnerCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const cat = categorizeMessage(msg).category;
  return cat === 'admin' || cat === 'passthrough';
}

/**
 * Extract a namespaced sender id from a message row. Handles both pre-
 * namespaced senders (e.g. `discord:@me:123`) and bare platform ids that
 * need the channel_type prefix added. Returns null when the message has
 * no author info — most often system rows.
 */
export function extractMessageSender(msg: MessageInRow): string | null {
  let content: unknown;
  try {
    content = JSON.parse(msg.content);
  } catch {
    return null;
  }
  return extractSenderId(msg, content);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  const raw: string | null = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

/**
 * Pick the message whose id should land in `in_reply_to` on outbound
 * rows. The intent of an inbound batch's reply target is "the message
 * the agent is responding to" — which is the *triggering* message
 * (engage_mode match: @mention, reply-to-bot, pattern, etc.), not
 * necessarily the newest message in the batch.
 *
 * Failure case this guards against: two near-simultaneous inbound
 * messages where the newest is a non-trigger drive-by ("optimus is
 * smarter again", "Sorta", emoji, ack) and the older one is the
 * actual @mention the agent is answering. Caller passes messages in
 * `seq DESC` (newest first); we walk to find the newest `trigger=1`
 * row. If none exist (shouldn't happen for normal user-facing
 * batches; possible for pure accumulate-only batches that the
 * accumulate gate above this filter would have already rejected),
 * fall back to the newest message overall so callers always get a
 * non-null id when the batch is non-empty.
 *
 * Returns the picked message or null when the batch is empty.
 */
export function pickInReplyToMessage(messages: MessageInRow[]): MessageInRow | null {
  if (messages.length === 0) return null;
  // Task rows are synthesized by the scheduler — their id is a fresh UUID,
  // not a platform message id, so using it as a reply target is meaningless
  // for chat adapters and harmful for Discord, which falls back to replying
  // to the channel's most-recent real message (observed on recurring RSS
  // posts in ai-friends, 2026-05-11). Exclude them at the picker level.
  const chatLike = messages.filter((m) => m.kind !== 'task');
  if (chatLike.length === 0) return null;
  const trigger = chatLike.find((m) => m.trigger === 1);
  return trigger ?? chatLike[0];
}

/**
 * Extract routing context from a batch of messages.
 *
 * `platformId`, `channelType`, and `threadId` come from the first row
 * (any row in the batch shares the same destination — the host scopes
 * each session to a single messaging group). `inReplyTo` picks the
 * newest *triggering* message via `pickInReplyToMessage` so the
 * outbound reply pill points at the @mention/reply-to-bot the agent
 * is actually answering, not at a non-trigger message that happened
 * to arrive in the same batch.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages[0];
  const replyTarget = pickInReplyToMessage(messages);
  return {
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: replyTarget?.id ?? null,
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 *
 * Prepends a `<context timezone="<IANA>" />` header so the agent always knows
 * what timezone it's in — every timestamp it sees in message bodies is the
 * user's local time, and every time it produces (schedules, suggests) should
 * be interpreted as local time in that same zone. This header is v1 behavior
 * (src/v1/router.ts:20-22); dropping it led to misinterpretations where the
 * agent scheduled tasks for the wrong hour.
 *
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  if (messages.length === 0) return header;

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return header + parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  if (messages.length === 1) {
    return formatSingleChat(messages[0]);
  }

  const lines = ['<messages>'];
  for (const msg of messages) {
    lines.push(formatSingleChat(msg));
  }
  lines.push('</messages>');
  return lines.join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender =
    content.senderName || content.author?.fullName || content.author?.userName || content.sender || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyAttr = content.replyTo?.id ? ` reply_to="${escapeXml(String(content.replyTo.id))}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const attachmentsSuffix = formatAttachments(content.attachments);

  const fromAttr = originAttr(msg);

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${escapeXml(time)}"${replyAttr}>${replyPrefix}${escapeXml(text)}${attachmentsSuffix}</message>`;
}

/**
 * Build a ` from="destination_name"` attribute string from a message's routing
 * fields. Shared by all formatters so the agent always knows where a message
 * originated — critical for explicit addressing.
 */
function originAttr(msg: MessageInRow): string {
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  if (fromDest) return ` from="${escapeXml(fromDest.name)}"`;
  if (msg.channel_type || msg.platform_id) {
    return ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`;
  }
  return '';
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const parts: string[] = [];
  if (content.scriptOutput) {
    parts.push('Script output:', JSON.stringify(content.scriptOutput, null, 2), '');
  }
  parts.push('Instructions:', content.prompt || '');
  return `<task${from} time="${escapeXml(time)}">${parts.join('\n')}</task>`;
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  const from = originAttr(msg);
  return `<webhook${from} source="${escapeXml(source)}" event="${escapeXml(event)}">${JSON.stringify(content.payload || content, null, 2)}</webhook>`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  return `<system_response${from} action="${escapeXml(content.action || 'unknown')}" status="${escapeXml(content.status || 'unknown')}">${JSON.stringify(content.result || null)}</system_response>`;
}

/**
 * Render the quoted original inside the <message> body.
 *
 * Matches v1 format (src/v1/router.ts:10-18): `<quoted_message from="X">Y</quoted_message>`.
 * Requires BOTH sender and text — if only id is present the reply_to attribute
 * on the parent <message> carries the link without an inline preview.
 *
 * `mine="true"` is added when the host detected the pill-reply pointing at a
 * prior bot outbound for this agent (router.stampReplyToBot). Platform-uniform
 * signal: Discord / Telegram / WhatsApp all reach this branch the same way.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  const mineAttr = replyTo.toBot === true ? ' mine="true"' : '';
  return `\n  <quoted_message from="${escapeXml(sender)}"${mineAttr}>${escapeXml(text)}</quoted_message>\n`;
}

/**
 * Inline-text limit for shared `.txt`/`.md`/`.json`/etc. attachments. Mirrors
 * v1's `TEXT_INLINE_MAX_BYTES` in apps/nanoclaw/src/channels/discord-attachments.ts.
 * Files at or below this size are decoded and embedded directly in an
 * `<attached_file>` block inside the user message; bigger files keep the
 * existing path/url marker so the agent can `bash Read` selectively.
 */
const TEXT_INLINE_MAX_BYTES = 64 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.log',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isTextEligible(att: any): boolean {
  const contentType = String(att?.mimeType || att?.contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType.startsWith('text/')) return true;
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    return true;
  }
  if (contentType === 'application/xml' || contentType.endsWith('+xml')) {
    return true;
  }
  const name = String(att?.name || att?.filename || '');
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Read text bytes for an inline-eligible attachment. Two paths:
 *
 *   1. `att.data` (base64) — present at the inbound-event boundary
 *      before the engine writes the file. Rare in steady-state; mostly
 *      seen by tests that bypass the engine's `materializeInbox`.
 *   2. `att.localPath` — every channel (Discord, Telegram, Slack via
 *      chat-sdk-bridge; WhatsApp native) lands per-session attachments
 *      at `<sessionDir>/inbox/<messageId>/<filename>`, surfaced to the
 *      container as `localPath: 'inbox/<messageId>/<filename>'` and
 *      mounted under `/workspace/`. Read from disk.
 *
 * Returns null when bytes are unavailable or oversized — caller falls
 * back to the path/url marker.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readInlineText(att: any): string | null {
  if (typeof att?.data === 'string' && att.data.length > 0) {
    // Base64-encoded length × 3/4 ≈ decoded length. Cheap pre-flight check
    // to avoid materializing 5 MB into a Buffer just to throw it away.
    const approxBytes = Math.floor((att.data.length * 3) / 4);
    if (approxBytes > TEXT_INLINE_MAX_BYTES) return null;
    try {
      const buf = Buffer.from(att.data, 'base64');
      if (buf.length === 0 || buf.length > TEXT_INLINE_MAX_BYTES) return null;
      return decodeAttachmentText(buf);
    } catch {
      return null;
    }
  }
  if (typeof att?.localPath === 'string' && att.localPath.length > 0) {
    const abs = att.localPath.startsWith('/') ? att.localPath : `/workspace/${att.localPath}`;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > TEXT_INLINE_MAX_BYTES) return null;
      return decodeAttachmentText(fs.readFileSync(abs));
    } catch {
      return null;
    }
  }
  return null;
}

function decodeAttachmentText(buffer: Buffer): string {
  // Replace embedded NULs so the value is XML-safe; agents reading the
  // block see the file's logical contents, not a binary smear if the
  // mimeType lied.
  return buffer.toString('utf8').split('\0').join('�');
}

/**
 * Render the full `<attached_file>` block — name + path attributes plus
 * the decoded body. The body's only escape concern is a literal
 * `</attached_file>` substring sneaking in from a malicious file; we
 * neutralize it the same way v1 did so the closing tag remains
 * unambiguous. Other XML-special chars stay raw inside the body so the
 * agent reads the file's actual contents.
 */
function formatInlineTextAttachmentBlock(name: string, workspacePath: string, text: string): string {
  return [
    `[Attached file content: ${name}]`,
    `<attached_file name="${escapeXml(name)}" path="${escapeXml(workspacePath)}">`,
    text.replace(/<\/attached_file>/gi, '<\\/attached_file>'),
    '</attached_file>',
  ].join('\n');
}

/**
 * Render the attachments suffix appended to a `<message>` body. For each
 * attachment:
 *
 *   - Text-eligible (mimeType or extension) AND bytes available AND ≤ 64 KB
 *     → inline content inside `<attached_file>`. Mirrors v1's behavior in
 *     `apps/nanoclaw/src/channels/discord-attachments.ts:formatInlineTextAttachment`,
 *     which the v2 cutover dropped — leaving agents with `[file: name —
 *     saved to /workspace/...]` markers and forcing them to `bash Read`
 *     every shared file.
 *   - Otherwise → existing path or URL marker. Images stay marker-only here
 *     because the provider pulls them out as multimodal blocks downstream
 *     (see `extractImageAttachments`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatAttachments(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    const name = a.name || a.filename || 'attachment';
    const type = a.type || 'file';
    const localPath = a.localPath ? `/workspace/${a.localPath}` : '';
    const url = a.url || '';
    const baseMarker = localPath
      ? `[${type}: ${escapeXml(name)} — saved to ${escapeXml(localPath)}]`
      : url
        ? `[${type}: ${escapeXml(name)} (${escapeXml(url)})]`
        : `[${type}: ${escapeXml(name)}]`;
    // Audio attachments may carry a host-transcribed text via
    // `att.transcript` (engine session-manager runs this pass for every
    // channel). Surface it directly so the agent sees what was said,
    // not an opaque `[audio: voice.ogg]` marker. Images and video have
    // their own multimodal pipelines (see extractImageAttachments)
    // that pull bytes out separately.
    if (type === 'audio' || type === 'voice') {
      const transcript = typeof a.transcript === 'string' ? a.transcript.trim() : '';
      if (transcript.length > 0) {
        return `${baseMarker}\n[Voice: ${escapeXml(transcript)}]`;
      }
      return baseMarker;
    }
    if (type === 'image' || type === 'video') {
      return baseMarker;
    }
    if (!isTextEligible(a)) return baseMarker;
    const text = readInlineText(a);
    if (text === null || text.trim().length === 0) return baseMarker;
    const block = formatInlineTextAttachmentBlock(
      name,
      localPath || (a.localPath ? `/workspace/${a.localPath}` : ''),
      text,
    );
    return `${baseMarker}\n${block}`;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Strip `<internal>...</internal>` blocks from agent output, then trim.
 * Ported from v1 (src/v1/router.ts:25-27). Used to remove the agent's
 * own scratchpad/reasoning before a reply goes out over a channel.
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Walk a batch of messages and collect image attachments suitable for
 * Anthropic vision multimodal blocks. Each result is `{ messageId, name,
 * absolutePath, mediaType }` where `absolutePath` is the container's view
 * of the file (`/workspace/<localPath>`) — caller reads bytes off disk.
 *
 * Only `type === 'image'` attachments with a `localPath` are surfaced.
 * Attachments without `localPath` (e.g. download failed host-side, or
 * non-image types) are skipped. mediaType is normalized to one of the
 * four Anthropic-accepted forms; mismatched mimeTypes (e.g. `image/heic`)
 * are dropped because the SDK rejects them with a 400.
 */
export interface InboundImageRef {
  messageId: string;
  name: string;
  absolutePath: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

const ACCEPTED_IMAGE_TYPES: ReadonlySet<InboundImageRef['mediaType']> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function normalizeMediaType(raw: string | undefined): InboundImageRef['mediaType'] | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // Some platforms emit `image/jpg` or `image/x-png`; map common variants.
  if (lower === 'image/jpg' || lower === 'image/pjpeg') return 'image/jpeg';
  if (ACCEPTED_IMAGE_TYPES.has(lower as InboundImageRef['mediaType'])) {
    return lower as InboundImageRef['mediaType'];
  }
  return null;
}

export function extractImageAttachments(messages: MessageInRow[]): InboundImageRef[] {
  const refs: InboundImageRef[] = [];
  for (const msg of messages) {
    const content = parseContent(msg.content);
    const attachments = content?.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const att of attachments) {
      if (att?.type !== 'image') continue;
      if (typeof att.localPath !== 'string' || !att.localPath) continue;
      const mediaType = normalizeMediaType(att.mimeType);
      if (!mediaType) continue;
      refs.push({
        messageId: msg.id,
        name: att.name || att.filename || 'image',
        absolutePath: `/workspace/${att.localPath}`,
        mediaType,
      });
    }
  }
  return refs;
}
