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

const ADMIN_COMMANDS = new Set([
  '/remote-control',
  '/clear',
  '/compact',
  '/context',
  '/cost',
  '/files',
  '/upload-trace',
]);
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
  /** Batch is a task fire — explicit `<message to>` sends must NOT inherit
   *  inReplyTo (the series id), or the host's task-fire suppression drops
   *  them as turn-final echoes: zero delivery. Deliberate sends are
   *  in_reply_to-null, same as the out-of-process MCP send_message path. */
  taskFire: boolean;
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
 * actual @mention the agent is answering. We walk to find the newest
 * `trigger=1` row.
 *
 * Caller-order independence: `getPendingMessages` returns rows in
 * `seq ASC` (oldest first) for chronological prompt formatting, while
 * the picker wants newest-first to pick the most-recent triggering row.
 * We sort by `seq` internally so the picker is correct regardless of
 * input order (oldest-first, newest-first, or unsorted).
 *
 * If no `trigger=1` non-task row exists, returns `null` — NOT a
 * fallback to the newest `trigger=0` row. A `trigger=0` chat row is
 * accumulate-only context the agent did not wake for and is not
 * answering; pinning a reply pill to it is wrong. This is exactly the
 * recurring AI-Friends RSS regression: a recurring task fires while a
 * human's earlier `trigger=0` message sits accumulated in the same
 * batch — the task row is correctly excluded, but the old
 * `trigger ?? chatLike[0]` fallback then picked the human's
 * non-trigger message, so the RSS/status post rendered as a reply pill
 * to it (observed live 2026-05-21 in #ai: an OpenAI-status post pilled
 * onto Teddy's "it wasn't an image it was this message"). `null` is the
 * authoritative "no reply pill" signal `resolveDispatchReplyTarget`
 * depends on — its contract ("`null` for a task-only / accumulate-only
 * turn") was being violated here. Matches the `kind != 'task' AND
 * trigger = 1` filter `resolveDestinationThread` already uses.
 *
 * Returns the triggering message, or null when the batch is empty or
 * contains no `trigger=1` non-task row.
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
  // Walk newest-first independent of caller input order. Order keys,
  // most-specific first:
  //   1. `seq`     — host writer assigns this; monotonic per session.
  //   2. `timestamp` — ISO `datetime('now')` from the writer; coarser
  //      (second-resolution) but always present, so it tiebreaks two
  //      rows the same writer flushed in one tick.
  //   3. insertion index — final fallback when both seq AND timestamp
  //      tie (test fixtures using `datetime('now')` for back-to-back
  //      inserts hit this; a stable sort would otherwise preserve
  //      input order, and `find(trigger===1)` would pick the OLDEST
  //      trigger row instead of the newest).
  //
  // Only a triggering row is a valid reply target — no trigger=1 row →
  // null (never a trigger=0 accumulate-only drive-by). See docstring.
  const indexed = chatLike.map((m, idx) => ({ m, idx }));
  indexed.sort((a, b) => {
    const seqDelta = (b.m.seq ?? 0) - (a.m.seq ?? 0);
    if (seqDelta !== 0) return seqDelta;
    const tsDelta = (b.m.timestamp ?? '').localeCompare(a.m.timestamp ?? '');
    if (tsDelta !== 0) return tsDelta;
    return b.idx - a.idx;
  });
  return indexed.find((x) => x.m.trigger === 1)?.m ?? null;
}

/**
 * Extract routing context from a batch of messages.
 *
 * `platformId`, `channelType`, and `threadId` come from the newest
 * triggering row when there is one. Mixed agent-shared batches can carry
 * accumulated context from other wired channels before the actual
 * trigger row; using the first row would route degraded fallbacks and
 * implicit replies to the wrong channel. `inReplyTo` uses the same
 * triggering row so the reply pill points at the message the agent is
 * actually answering, not at non-trigger context that happened to ride
 * along in the batch.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages[0];
  const replyTarget = pickInReplyToMessage(messages);
  const routeSource = replyTarget ?? first;
  return {
    platformId: routeSource?.platform_id ?? null,
    channelType: routeSource?.channel_type ?? null,
    threadId: routeSource?.thread_id ?? null,
    inReplyTo: replyTarget?.id ?? null,
    taskFire: messages.length > 0 && messages.every((m) => m.kind === 'task'),
  };
}

/**
 * Did a human aim this turn directly at THIS agent?
 *
 * `true` ⟺ at least one wake-eligible chat row in the batch is either an
 * explicit @mention of this agent or a reply to one of this agent's own
 * messages. This is the container-side analogue of the host's
 * `classifyWakeCause` (modules/typing/index.ts) `addressed` signal, but
 * strictly better: the host has to regex-scrape the message text because
 * it claims the routing-time `isMention` boolean isn't persisted — it
 * *is*, at the top level of the chat-row content the channel adapter
 * writes, so we read it directly here.
 *
 * Why this exists: a silent turn is acceptable for ambient group chatter
 * or a maintenance task, but NEVER when a human @mentioned the agent or
 * replied to it — that reads as the bot being broken (the exact 2026-05-17
 * AI Friends incident: the agent went silent on a reply-to-bot follow-up
 * after `search_conversations` failed). `dispatchResultText` consumes this
 * to force an explicit "I couldn't do that" reply instead of
 * `silent_turn_complete` on an addressed-but-empty turn.
 *
 * Signal priority (each independently sufficient):
 *   1. `content.isMention === true` AND the mention targets THIS bot.
 *      The SDK/adapter `isMention` boolean is NOT "mentions me" — for
 *      chat-sdk Discord it is "a mention exists", true for `<@anyone>`.
 *      A message @mentioning a *different* bot in the same channel
 *      therefore looked like this bot was addressed; the bot correctly
 *      stayed silent and the `sent===0 && addressed` safety-net fired a
 *      spurious "[degraded — addressed turn produced no output]" with no
 *      prompt behind it (AI Friends, 2026-05-19). When the row carries
 *      `content.botUserId` (Discord, stamped by the chat-sdk bridge),
 *      `isMention` only counts if the text contains an explicit
 *      `<@thisBotId>` / `<@!thisBotId>` token. When `botUserId` is
 *      absent (non-Discord, or unconfigured) we keep the old permissive
 *      behavior — `isMention === true` alone is sufficient — because
 *      those platforms' `isMention` is already self-specific and we have
 *      no token to attribute.
 *   2. A reply whose parent is one of THIS agent's messages —
 *      `content.replyTo` present AND (`replyTo.toBot === true` OR
 *      `replyTo.sender` equals this agent's `assistantName`). The sender
 *      match is the robust path; `toBot` is a bonus, never required. A
 *      reply to *another human* that merely happens to wake the agent is
 *      deliberately NOT "addressed" — that's the host classifier's bug we
 *      don't reproduce.
 *
 * `assistantName` is `RunnerConfig.assistantName` (e.g. "Optimus"); pass
 * "" to skip the sender-name path (tests / unconfigured). Pure: no I/O,
 * unit-testable like the sibling batch helpers.
 */
export function isAddressedTurn(messages: MessageInRow[], assistantName: string): boolean {
  const self = assistantName.trim().toLowerCase();
  for (const m of messages) {
    if (m.kind !== 'chat' && m.kind !== 'chat-sdk') continue;
    if (m.trigger !== 1) continue;
    let parsed: {
      isMention?: unknown;
      botUserId?: unknown;
      text?: unknown;
      replyTo?: { toBot?: unknown; sender?: unknown };
      engageMode?: unknown;
    };
    try {
      parsed = JSON.parse(m.content) as typeof parsed;
    } catch {
      continue;
    }
    // Host-stamped engagement signal (router.stampEngagement, wake=true only).
    // `engage_mode='pattern'` is sufficient on its own: `evaluateEngage` only
    // returns true when the per-wiring regex matched, so a pattern wake IS
    // the operator's configured "this message is for THIS agent" signal.
    // Without this, dedicated-bot wirings (every DM, every `pattern='.'`
    // group like Nook/Tico) look ambient inside the container because no
    // @mention/replyTo is present, the agent goes silent, and the user sees
    // the bot as broken (2026-05-27 Nook incident). `mention` and
    // `mention-sticky` deliberately fall through — those modes can wake for
    // a mention of a *different* bot in a multi-bot channel (AI Friends), so
    // we still need the isMention/botUserId discriminator below to attribute
    // the address to THIS bot.
    if (parsed.engageMode === 'pattern') return true;
    if (parsed.isMention === true) {
      const botUserId = typeof parsed.botUserId === 'string' ? parsed.botUserId : '';
      if (botUserId.length === 0) {
        // No bot id to attribute the mention to (non-Discord platform, or
        // unconfigured). Keep the historical permissive behavior — these
        // platforms' isMention is already self-specific.
        return true;
      }
      // Discord: trust isMention only if the text explicitly mentions
      // THIS bot. `<@id>` and `<@!id>` are both valid Discord user-mention
      // forms. A mention of a different participant (the AI-Friends
      // multi-bot case) has isMention=true but no `<@thisBotId>` token,
      // so it correctly does NOT count as addressed.
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      if (text.includes(`<@${botUserId}>`) || text.includes(`<@!${botUserId}>`)) return true;
    }
    const replyTo = parsed.replyTo;
    if (replyTo) {
      if (replyTo.toBot === true) return true;
      const sender = typeof replyTo.sender === 'string' ? replyTo.sender.trim().toLowerCase() : '';
      if (self.length > 0 && sender.length > 0 && sender === self) return true;
    }
  }
  return false;
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
  const reactionMessages = messages.filter((m) => m.kind === 'reaction');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (reactionMessages.length > 0) {
    parts.push(...reactionMessages.map(formatReactionMessage));
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
  // Each `<message id="..." from="...">...</message>` block is self-contained;
  // concatenating them reads to the agent as a sequence of distinct messages.
  // Earlier revisions wrapped multi-message batches in an outer `<messages>`
  // envelope, but the Claude Agent SDK responded to that shape with a
  // synthetic stub (`model: "<synthetic>"`, `content: "No response
  // requested."`) instead of calling the API — see #2555 for the full trace.
  // The fix is simply to drop the wrapper; the single-message path (which
  // already worked) is now just the N=1 case of the same code.
  return messages.map(formatSingleChat).join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender =
    content.senderName || content.author?.fullName || content.author?.userName || content.sender || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyId = replyMessageId(content.replyTo);
  const replyAttr = replyId ? ` reply_to="${escapeXml(replyId)}"` : '';
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
 * Render an inbound emoji reaction (`kind: 'reaction'`).
 *
 * `added="true"` — the user added the reaction; `added="false"` — they
 * removed one they'd previously added. `by` is the reacting user. `on_mine`
 * is true when the reaction targeted one of this agent's own messages — the
 * router stamps `replyTo.toBot=true` (same `wasDeliveredByBot` machinery as
 * reply-to-bot) for exactly that case, so it's the cross-platform-uniform
 * "they reacted to something I said" signal. The element is self-closing:
 * a reaction carries no body, only the act itself.
 */
function formatReactionMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const sender =
    content.senderName || content.author?.fullName || content.author?.userName || content.sender || 'Unknown';
  const emoji = content.emoji ?? content.rawEmoji ?? '?';
  const added = content.added === true || content.added === 'true';
  const onMine = content.replyTo?.toBot === true;
  const onMineAttr = onMine ? ' on_mine="true"' : '';
  return `<reaction${from} by="${escapeXml(sender)}" added="${added}" emoji="${escapeXml(String(emoji))}"${onMineAttr} time="${escapeXml(time)}" />`;
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
 * Deeper reply ancestors (H-D2): when a chain-walking extractor populated
 * `replyTo.ancestors` (grandparent and up, nearest-first), render them as
 * additional `<quoted_message depth="N">` blocks ABOVE the direct parent,
 * oldest-first, so a multi-level reply thread reads top-down (oldest
 * ancestor → … → direct parent → this message). The ancestors are embedded
 * in the inbound row, so the chain survives session rotation by construction
 * — no prompt-window resolution needed. `depth="1"` is the direct parent,
 * `depth="2"` its parent, etc.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function replyMessageId(replyTo: any): string | null {
  const value = replyTo?.id ?? replyTo?.messageId;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  const mineAttr = replyTo.toBot === true ? ' mine="true"' : '';
  const parentMessageId = replyMessageId(replyTo);
  const parentMessageIdAttr = parentMessageId ? ` message_id="${escapeXml(parentMessageId)}"` : '';

  // Ancestors above the direct parent, nearest-first in the source array.
  // Render oldest-first so the rendered order is chronological top-down.
  const ancestors = Array.isArray(replyTo.ancestors) ? replyTo.ancestors : [];
  const ancestorBlocks: string[] = [];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    const aSender = a?.sender;
    const aText = a?.text;
    if (typeof aSender !== 'string' || typeof aText !== 'string') continue;
    if (!aSender || !aText.trim()) continue;
    const ancestorMessageId = replyMessageId(a);
    const ancestorMessageIdAttr = ancestorMessageId ? ` message_id="${escapeXml(ancestorMessageId)}"` : '';
    // depth: nearest ancestor (ancestors[0], grandparent) is depth 2; the
    // direct parent below is depth 1.
    const depth = i + 2;
    ancestorBlocks.push(
      `  <quoted_message from="${escapeXml(aSender)}"${ancestorMessageIdAttr} depth="${depth}">${escapeXml(aText)}</quoted_message>`,
    );
  }

  const parentBlock = `  <quoted_message from="${escapeXml(sender)}"${parentMessageIdAttr}${mineAttr}${ancestorBlocks.length > 0 ? ' depth="1"' : ''}>${escapeXml(text)}</quoted_message>`;

  return `\n${[...ancestorBlocks, parentBlock].join('\n')}\n`;
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
    if (type === 'video') {
      // Host-side video processing (engine session-manager) stamps a
      // ready-made `[Video: …]` marker plus the raw transcript/summary, and
      // appends the extracted keyframes as separate `type:'image'`
      // attachments (which extractImageAttachments pulls into vision blocks).
      // Surface the text here so the agent gets the spoken content + visual
      // summary alongside the frames; fall back to the base marker when the
      // host produced nothing (no API key / processing failed).
      const videoMarker = typeof a.videoMarker === 'string' ? a.videoMarker.trim() : '';
      if (videoMarker.length > 0) {
        return `${baseMarker}\n${escapeXml(videoMarker)}`;
      }
      const transcript = typeof a.transcript === 'string' ? a.transcript.trim() : '';
      const summary = typeof a.summary === 'string' ? a.summary.trim() : '';
      if (transcript.length > 0 || summary.length > 0) {
        const t = transcript ? `[Video: ${escapeXml(transcript)}]` : '';
        const s = summary ? `[Video Summary: ${escapeXml(summary)}]` : '';
        return [baseMarker, t, s].filter(Boolean).join('\n');
      }
      return baseMarker;
    }
    if (type === 'image') {
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
