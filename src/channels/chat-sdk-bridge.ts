/**
 * Chat SDK bridge — wraps a Chat SDK adapter + Chat instance
 * to conform to the NanoClaw ChannelAdapter interface.
 *
 * Used by Discord, Slack, and other Chat SDK-supported platforms.
 */
import http from 'http';

import {
  Chat,
  Card,
  CardText,
  Actions,
  Button,
  LinkButton,
  type CardChild,
  type Adapter,
  type ConcurrencyStrategy,
  type Message as ChatMessage,
  type ReactionEvent,
} from 'chat';
import { log } from '../log.js';
import { SqliteStateAdapter } from '../state-sqlite.js';
import { registerWebhookAdapter } from '../webhook-server.js';
import { getAskQuestionRender } from '../db/sessions.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';

/** Adapter with optional gateway support (e.g., Discord). */
interface GatewayAdapter extends Adapter {
  startGatewayListener?(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
}

/** Reply context extracted from a platform's raw message. */
export interface ReplyContext {
  text: string;
  sender: string;
  /**
   * Platform message id of the parent (the message being replied to). The
   * router uses this to engage on reply-to-bot in `mention` / `mention-sticky`
   * modes — matching v1's `requires_trigger` behavior where a reply to the
   * bot's prior message counts as a trigger even without an @mention.
   */
  messageId?: string;
  /**
   * Set by reply-chain-walking extractors when an ancestor in the chain
   * is bot *participation* that has no resolvable bot-outbound id to put
   * in `messageId` — specifically an ancestor that @-mentions the bot
   * but was authored by a human (e.g. someone replies to "@Optimus do
   * X"). `messageId`'s `wasDeliveredByBot` lookup can't see that (no bot
   * outbound row), so the walker flags it here and the router treats it
   * as a reply-to-bot trigger directly. v1 achieved the same UX by
   * prepending `@ASSISTANT_NAME` to such messages; v2 keeps the signal
   * structured. Only meaningful in `mention` / `mention-sticky` modes.
   */
  botInChain?: boolean;
}

/**
 * Extract reply context from a platform-specific raw message. Return null if no reply.
 *
 * May return a Promise — extractors that need to walk the reply chain via
 * platform API calls (Discord's `messages.fetch`) can be async. Sync
 * extractors continue to work unchanged.
 */
export type ReplyContextExtractor = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any>,
) => ReplyContext | null | Promise<ReplyContext | null>;

export interface ChatSdkBridgeConfig {
  adapter: Adapter;
  concurrency?: ConcurrencyStrategy;
  /** Bot token for authenticating forwarded Gateway events (required for interaction handling). */
  botToken?: string;
  /**
   * This bot's platform user id (Discord application/user id). When set,
   * `messageToInbound` stamps it onto the inbound row as `botUserId` so
   * the container-side `isAddressedTurn` can tell an @mention of THIS
   * bot from an @mention of a different participant. Without it the
   * SDK's `message.isMention` boolean is "a mention exists" (true for
   * `<@anyone>`), which made a message @mentioning another bot look like
   * Optimus was addressed → silent turn → spurious "[degraded — addressed
   * turn produced no output]" (AI Friends, 2026-05-19). Discord sets
   * this; platforms whose SDK `isMention` is already self-specific
   * (Telegram) leave it undefined and keep the permissive behavior.
   */
  botUserId?: string;
  /** Platform-specific reply context extraction. */
  extractReplyContext?: ReplyContextExtractor;
  /**
   * Whether this platform uses threads as the primary conversation unit.
   * See `ChannelAdapter.supportsThreads`. Declared by the calling channel
   * skill, not inferred, because some platforms (Discord) can be used either
   * way and the default depends on installation style.
   */
  supportsThreads: boolean;
  /**
   * Optional transform applied to outbound text/markdown before it reaches the
   * adapter. Used by channels that need to sanitize for a platform-specific
   * quirk (e.g. Telegram's legacy Markdown parse mode).
   */
  transformOutboundText?: (text: string) => string;
  /**
   * Maximum text length the underlying adapter accepts in a single message.
   * When set, the bridge splits outbound text longer than this on paragraph
   * → line → hard-char boundaries and posts multiple messages. Without this,
   * adapters like Discord (2000) and Telegram (4096) silently truncate
   * mid-response. The returned id is the first chunk's id so subsequent edits
   * and reactions still target the head of the reply.
   */
  maxTextLength?: number;
}

/**
 * Split `text` into chunks no larger than `limit`, preferring paragraph
 * breaks, then line breaks, then a hard character cut as a last resort.
 * Preserves code fences only structurally — a fenced block that straddles a
 * chunk boundary will render as two independent blocks on the receiving
 * platform, which is the same behavior as manually re-opening a fence.
 */
/**
 * Decode the actual option value from a button callback. Buttons are encoded
 * with an integer index (to keep under Telegram's 64-byte callback_data cap),
 * and the real value is looked up via `getAskQuestionRender(questionId)`.
 * Falls back to treating the tail as a literal value so old in-flight cards
 * (encoded before this shortening landed) still resolve.
 */
function resolveSelectedOption(
  render: { options: NormalizedOption[] } | undefined,
  eventValue: string | undefined,
  tail: string | undefined,
): string {
  const candidate = eventValue ?? tail ?? '';
  if (render && /^\d+$/.test(candidate)) {
    const idx = Number(candidate);
    if (render.options[idx]) return render.options[idx].value;
  }
  return candidate;
}

/**
 * Convert common HTML inline tags to Markdown. Discord, Telegram, Slack all
 * parse Markdown, never HTML — so any literal `<code>X</code>` an agent emits
 * renders as visible angle-brackets. Conversion happens before chunking so
 * size budgets land on rendered text. Self-closing `<br>` becomes a newline;
 * unknown tag pairs are unwrapped (kept inner content); unknown self-closing
 * tags are dropped. Standalone `<` / `>` (math, generics in code) are
 * preserved by the alpha-name guard.
 */
export function htmlToMarkdown(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(
    /<a\s+[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, label) => `[${(label as string).trim() || (href as string)}](${href})`,
  );
  out = out.replace(
    /<a\s+[^>]*href\s*=\s*'([^']*)'[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, label) => `[${(label as string).trim() || (href as string)}](${href})`,
  );
  out = out.replace(
    /<pre>\s*<code(?:\s+[^>]*)?>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_m, body) => `\n\`\`\`\n${(body as string).trim()}\n\`\`\`\n`,
  );
  out = out.replace(
    /<pre(?:\s+[^>]*)?>([\s\S]*?)<\/pre>/gi,
    (_m, body) => `\n\`\`\`\n${(body as string).trim()}\n\`\`\`\n`,
  );
  out = out.replace(/<code(?:\s+[^>]*)?>([\s\S]*?)<\/code>/gi, (_m, body) => `\`${body as string}\``);
  out = out.replace(/<(?:b|strong)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:b|strong)>/gi, (_m, body) => `**${body as string}**`);
  out = out.replace(/<(?:i|em)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:i|em)>/gi, (_m, body) => `*${body as string}*`);
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/g, (_m, _tag, body) => body as string);
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^>]*)?\/?>/g, '');
  return out;
}

/**
 * Size-aware chunking with code-fence carryover. Tries paragraph (\n\n) →
 * single newline → sentence end → word boundary, falling back to a hard cut.
 * If a chunk ends with an open ``` fence, closes it on the head and reopens
 * with the original lang tag on the tail so each chunk renders as a valid
 * code block on the platform.
 *
 * Reject boundaries that are too close to the start (within 25% of budget)
 * to avoid emitting a tiny head + huge tail when a paragraph break sits
 * near the very beginning of the budget window.
 */
const SPLIT_TOLERANCE = 0.25;

export function splitForLimit(text: string, limit: number): string[] {
  // Normalize HTML before chunking so split boundaries land on rendered text.
  text = htmlToMarkdown(text);
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let carryFence: string | null = null;

  while (remaining.length > 0) {
    const prefix = carryFence ?? '';
    const budget = limit - prefix.length;

    if (prefix.length + remaining.length <= limit) {
      chunks.push(prefix + remaining);
      break;
    }

    const cut = findCut(remaining, budget, SPLIT_TOLERANCE);
    const head = remaining.slice(0, cut.headEnd);
    const tail = remaining.slice(cut.tailStart);

    const fenceState = scanFenceState(prefix + head);
    if (fenceState.open) {
      const closed = (prefix + head).trimEnd() + '\n```';
      chunks.push(closed);
      carryFence = '```' + fenceState.lang + '\n';
    } else {
      chunks.push(prefix + head);
      carryFence = null;
    }

    remaining = tail;
  }

  return chunks;
}

interface SplitCut {
  headEnd: number;
  tailStart: number;
}

function findCut(text: string, budget: number, tolerance: number): SplitCut {
  const minAccept = Math.floor(budget * (1 - tolerance));
  const window = text.slice(0, budget);

  // Closed code-fence boundary: prefer a `\n```\n` boundary regardless of tier.
  const fenceIdx = window.lastIndexOf('\n```\n');
  if (fenceIdx >= 0) {
    const end = fenceIdx + 5;
    return { headEnd: end, tailStart: end };
  }

  const tiers: Array<() => SplitCut | null> = [
    () => {
      const idx = window.lastIndexOf('\n\n');
      if (idx < 0) return null;
      return { headEnd: idx, tailStart: skipLeading(text, idx, /\n/) };
    },
    () => {
      const idx = window.lastIndexOf('\n');
      if (idx < 0) return null;
      return { headEnd: idx, tailStart: skipLeading(text, idx, /\n/) };
    },
    () => {
      const m = window.match(/[.!?](?:\s|$)(?=[^.!?]*$)/);
      if (!m || m.index === undefined) return null;
      const afterPunct = m.index + 1;
      return {
        headEnd: afterPunct,
        tailStart: skipLeading(text, afterPunct, /\s/),
      };
    },
    () => {
      const m = window.match(/\s(?=\S*$)/);
      if (!m || m.index === undefined) return null;
      return {
        headEnd: m.index,
        tailStart: skipLeading(text, m.index, /\s/),
      };
    },
  ];

  for (const tier of tiers) {
    const cut = tier();
    if (cut && cut.headEnd >= minAccept) return cut;
  }

  return { headEnd: budget, tailStart: budget };
}

function skipLeading(text: string, start: number, re: RegExp): number {
  let i = start;
  while (i < text.length && re.test(text[i])) i++;
  return i;
}

function scanFenceState(text: string): { open: boolean; lang: string } {
  const fenceRe = /^```([^\n]*)$/gm;
  let open = false;
  let lang = '';
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    if (open) {
      open = false;
      lang = '';
    } else {
      open = true;
      lang = m[1].trim();
    }
  }
  return { open, lang };
}

/**
 * Discord's Get Channel Messages API hard-caps the `limit` query param
 * at 100 (docs.discord.com/developers/resources/message — "Max number
 * of messages to return (1-100)"); 101+ is a fatal 400, code 50035
 * NUMBER_TYPE_MAX. A caller asking recoverMissedMessages for a larger
 * window must therefore page, not request one oversized fetch.
 *
 * Returns the clamped per-page `pageSize` (1..100) and a `maxPages`
 * budget that covers the caller's intended `limit` worth of messages
 * with slack, while still bounding a misbehaving adapter whose cursor
 * never terminates. Pure — unit-tested directly.
 */
export const RECOVERY_PER_PAGE_MAX = 100;

export function recoveryPageBudget(limit: number): {
  pageSize: number;
  maxPages: number;
} {
  const pageSize = Math.min(Math.max(1, limit), RECOVERY_PER_PAGE_MAX);
  const maxPages = Math.max(1, Math.ceil(limit / pageSize)) + 5;
  return { pageSize, maxPages };
}

/**
 * True when a chat-sdk message was authored by the bot itself.
 *
 * Chat-sdk re-ingests every message in a channel — including the bot's
 * own outbound — as a fresh `chat-sdk` inbound row. The SDK flags
 * self-authored messages on the nested author: `isMe` (this identity is
 * the connected client) and, for the same identity, `isBot`. Surfacing
 * this as the envelope's `isBotMessage` lets the router's loopback gate
 * (`router.ts` isBotLoopback → the engage-skip) drop it. Without it, a
 * reply-shaped self-message (the bot quoting a user it just answered)
 * reaches `isReplyToOurBot` → trigger=1 → an "addressed" turn with
 * nothing to answer → the `sent===0 && addressed` safety-net emits a
 * spurious "[degraded — addressed turn produced no output]" with no
 * prompt/trigger behind it (observed live in AI Friends 2026-05-18).
 * `dbdcc476` fixed the sender-identity half of this bot-clobber bug and
 * explicitly flagged `isBotMessage` as still unset on this path.
 *
 * Conservative: only `true` on an explicit self/bot marker. An absent or
 * false marker (a normal human message, or an SDK that doesn't populate
 * it) returns `false` so real messages are never silently dropped.
 */
export function isSelfAuthoredChatSdkMessage(author: { isMe?: boolean; isBot?: boolean } | undefined | null): boolean {
  return author?.isMe === true || author?.isBot === true;
}

export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  const { adapter } = config;
  const transformText = (t: string): string => (config.transformOutboundText ? config.transformOutboundText(t) : t);
  let chat: Chat;
  let state: SqliteStateAdapter;
  let setupConfig: ChannelSetup;
  let gatewayAbort: AbortController | null = null;

  async function messageToInbound(
    message: ChatMessage,
    isMention: boolean,
    isGroup?: boolean,
  ): Promise<InboundMessage> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = message.toJSON() as Record<string, any>;

    // Download attachment data before serialization loses fetchData()
    if (message.attachments && message.attachments.length > 0) {
      const enriched = [];
      for (const att of message.attachments) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry: Record<string, any> = {
          type: att.type,
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          width: (att as unknown as Record<string, unknown>).width,
          height: (att as unknown as Record<string, unknown>).height,
          ...(typeof att.url === 'string' && { url: att.url }),
        };
        // Two paths to populate `data`:
        //   (1) `fetchData()` — preferred when the adapter exposes it;
        //       handles auth automatically (Slack private URLs etc.).
        //   (2) `url` fallback — public CDN URLs (Discord attachments).
        //       Discord's chat-adapter populates `url` but does NOT expose
        //       `fetchData`, so without this fallback every Discord image
        //       lands in the container with metadata only and the agent
        //       sees no bytes ("I can't pull the screenshot in"). Observed
        //       live on 2026-05-09 with Adrian's Google-reconnect
        //       screenshot in boysnight.
        let buffer: Buffer | null = null;
        if (att.fetchData) {
          try {
            buffer = await att.fetchData();
          } catch (err) {
            log.warn('Failed to fetchData attachment', { type: att.type, name: att.name, err });
          }
        }
        if (!buffer && att.url) {
          try {
            const res = await fetch(att.url);
            if (!res.ok) {
              throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }
            buffer = Buffer.from(await res.arrayBuffer());
          } catch (err) {
            log.warn('Failed to fetch attachment by url', {
              type: att.type,
              name: att.name,
              url: att.url,
              err,
            });
          }
        }
        if (buffer) {
          // Resize oversized images (>~3.5MB raw) so the base64 payload
          // stays under Anthropic's 5MB per-image cap. Static formats
          // (JPEG/PNG/WebP) get resized to 1024px-max + JPEG q85;
          // animated formats need ffmpeg (next branch). Mirrors v1's
          // `resizeToJpegBuffer` in apps/nanoclaw/src/shared/image-processing.ts.
          if (att.type === 'image' && att.mimeType) {
            const { maybeResizeImage } = await import('../media/image-processing.js');
            buffer = await maybeResizeImage(buffer, att.mimeType);
          }
          // Animated content transcode — see media/image-processing.ts for
          // the full rationale. Three cases land here:
          //   1. Tenor/Giphy "gifv" embeds: att.type='video' mimeType='video/mp4'.
          //      Discord serves animated content as MP4 even when the user
          //      pasted a GIF; Anthropic rejects MP4 bytes with a 400.
          //   2. WhatsApp "GIFs": att.type='image' mimeType='image/gif' but
          //      the bytes are MP4-encoded video under Baileys. Same 400.
          //   3. Oversize real GIFs: att.type='image' mimeType='image/gif',
          //      >3.5 MB raw, sharp can't shrink while preserving motion.
          // On success the attachment is rewritten as image/gif so the
          // container's extractImageAttachments sees an accepted format;
          // on failure (ffmpeg missing/failed/output oversize) we drop the
          // bytes so the agent doesn't get an attachment reference pointing
          // at content Anthropic will reject. v1 parity.
          if (att.mimeType) {
            const { shouldTranscodeAnimated, maybeTranscodeAnimated } = await import('../media/image-processing.js');
            if (shouldTranscodeAnimated(att.type, att.mimeType, buffer.length)) {
              const result = await maybeTranscodeAnimated(buffer, att.mimeType);
              if (result.ok && result.buffer && result.mimeType) {
                buffer = result.buffer;
                entry.mimeType = result.mimeType;
                entry.type = 'image';
              } else {
                log.warn('Animated attachment transcode failed; dropping bytes', {
                  name: att.name,
                  sourceType: att.type,
                  sourceMime: att.mimeType,
                  reason: result.reason,
                });
                // Skip the data payload. The bridge still emits the metadata
                // entry below — but without `data`, the container poll-loop's
                // image extractor passes over it and the agent sees nothing
                // rather than a broken reference.
                buffer = null;
              }
            }
          }
          if (buffer) entry.data = buffer.toString('base64');
          // Audio transcription is no longer done here. The engine's
          // session-manager.extractAttachmentFiles runs a single
          // transcription pass for every adapter (chat-sdk channels +
          // native WhatsApp). Doing it inline here would re-transcribe
          // the same buffer; doing it host-side meant standalone
          // NanoClaw silently skipped it for lack of host wiring. Both
          // issues resolved by the engine-side single site.
        } else if (att.type === 'image' || att.type === 'video' || att.type === 'audio') {
          // Loud failure for media types — text/file we can fall through
          // and the agent's formatter will render `[file: name]`. Media
          // without bytes is silently broken from the agent's POV
          // (the recurring "I can't pull the screenshot" failure mode).
          log.error('Attachment media bytes unavailable — agent will see metadata only', {
            type: att.type,
            name: att.name,
            hasFetchData: !!att.fetchData,
            hasUrl: !!att.url,
          });
        }
        enriched.push(entry);
      }
      serialized.attachments = enriched;
    }

    // Extract reply context via platform-specific hook. Awaited so async
    // extractors (e.g. Discord's reply-chain walker) can fetch ancestors
    // before we hand the serialized message to the router.
    if (config.extractReplyContext && message.raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyTo = await config.extractReplyContext(message.raw as Record<string, any>);
      if (replyTo) serialized.replyTo = replyTo;
    }

    // Project chat-sdk's nested author into the flat sender fields the router
    // expects (see src/router.ts extractAndUpsertUser). Native adapters already
    // populate these directly; this brings chat-sdk adapters in line.
    const author = serialized.author as
      | { userId?: string; fullName?: string; userName?: string; isMe?: boolean; isBot?: boolean }
      | undefined;
    if (author) {
      const name = author.fullName ?? author.userName;
      serialized.senderId = author.userId;
      serialized.sender = name;
      serialized.senderName = name;
    }

    // Detect the bot's own message bouncing back so the router's loopback
    // gate drops it instead of self-triggering an empty "addressed" turn.
    // Full rationale + incident chain on isSelfAuthoredChatSdkMessage.
    const authoredBySelf = isSelfAuthoredChatSdkMessage(author);

    // Stamp this bot's platform id into the row content so the
    // container-side isAddressedTurn can distinguish an @mention of THIS
    // bot from an @mention of a different participant. The SDK's
    // top-level `isMention` is only "a mention exists" — true for
    // `<@anyone>` — so on its own it made a message @mentioning another
    // bot look like this bot was addressed (→ silent turn → spurious
    // "[degraded]" in AI Friends 2026-05-19). Only set when known
    // (Discord); absent on platforms that don't supply it, where
    // isAddressedTurn keeps its permissive isMention behavior.
    if (config.botUserId) serialized.botUserId = config.botUserId;
    if (authoredBySelf) serialized.isBotMessage = true;

    // Drop raw to save DB space (can be very large)
    serialized.raw = undefined;

    return {
      id: message.id,
      kind: 'chat-sdk',
      content: serialized,
      timestamp: message.metadata.dateSent.toISOString(),
      isMention,
      isGroup,
      ...(authoredBySelf && { isBotMessage: true }),
    };
  }

  /**
   * Build an inbound `kind: 'reaction'` message from a Chat SDK
   * `ReactionEvent`. Works uniformly across every Chat SDK platform
   * (Discord, Slack, Telegram, Teams, …) — the SDK normalizes the
   * platform's raw reaction wire format into this one shape.
   *
   * `content.replyTo.messageId` carries the *reacted-to* message's platform
   * id. This deliberately reuses the same field the router's reply-to-bot
   * detection (`isReplyToOurBot` → `wasDeliveredByBot`) already consults, so
   * a reaction on one of the bot's own messages becomes a soft trigger with
   * zero new router plumbing. `content.text` is a human-legible summary used
   * as a fallback by readers that don't special-case the reaction shape;
   * the formatter renders the structured fields instead.
   *
   * `id` is namespaced with `:rx:<added>:<emoji>` so adding then removing
   * the same emoji on the same message produces two distinct
   * `messages_in.id`s (the PK is per-session) rather than the remove
   * silently colliding with and dropping the add.
   */
  function reactionToInbound(event: ReactionEvent): InboundMessage {
    const author = event.user as { userId?: string; fullName?: string; userName?: string } | undefined;
    const senderName = author?.fullName ?? author?.userName;
    const emojiName = event.emoji?.name ?? event.rawEmoji;
    const verb = event.added ? 'reacted with' : 'removed reaction';
    return {
      id: `${event.messageId}:rx:${event.added ? 'add' : 'del'}:${emojiName}`,
      kind: 'reaction',
      content: {
        operation: 'reaction_received',
        added: event.added,
        emoji: emojiName,
        rawEmoji: event.rawEmoji,
        // Reacted-to message id, surfaced both as the explicit field and via
        // replyTo so the router's existing reply-to-bot path resolves it.
        reactedToMessageId: event.messageId,
        replyTo: { messageId: event.messageId },
        senderId: author?.userId,
        sender: senderName,
        senderName,
        text: `${senderName ?? 'Someone'} ${verb} ${emojiName}`,
      },
      timestamp: new Date().toISOString(),
      isMention: false,
    };
  }

  const bridge: ChannelAdapter = {
    name: adapter.name,
    channelType: adapter.name,
    supportsThreads: config.supportsThreads,

    async setup(hostConfig: ChannelSetup) {
      setupConfig = hostConfig;

      state = new SqliteStateAdapter();

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        userName: adapter.userName || 'NanoClaw',
        concurrency: config.concurrency ?? 'concurrent',
        state,
        logger: 'silent',
      });

      // Detect platform-driven chat-id reassignments (Telegram's
      // `migrate_to_chat_id` service event, fired when a basic group is
      // upgraded to a supergroup). When we see one, the chat we know as
      // `channelIdFromThreadId(thread.id)` is dead — Telegram has assigned
      // it a brand-new id and the old id immediately stops accepting sends.
      // Notify the host so it can rewrite messaging_groups.platform_id +
      // refresh per-session routing before continuing. We do NOT also
      // forward the migrate event as a normal user message: it has no text,
      // and our pre-`migrate_to_chat_id`-detection behavior was to bounce
      // a "your message came through blank" reply to the now-dead old id,
      // which fails three times and gets given up on permanently.
      //
      // Returns true if the event was handled as a migration (caller skips).
      // Lives inside `setup` so it closes over `adapter` + `setupConfig`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maybeHandleChatMigration = async (message: any, threadId: string): Promise<boolean> => {
        const newChatId = message?.raw?.migrate_to_chat_id;
        if (typeof newChatId !== 'number' && typeof newChatId !== 'string') return false;
        const oldPlatformId = adapter.channelIdFromThreadId(threadId);
        // Mirror the adapter's `telegram:<chatId>` encoding rather than
        // reusing channelIdFromThreadId (which would need a synthetic
        // thread id). Channel-type prefix keeps us aligned with the
        // single known emitter (Telegram); other channels that grow
        // analogous events will follow the same prefix convention.
        const newPlatformId = `${adapter.name}:${newChatId}`;
        if (newPlatformId === oldPlatformId) return true;
        log.info('Chat platform-id migration detected', {
          channelType: adapter.name,
          oldPlatformId,
          newPlatformId,
        });
        try {
          await setupConfig.onChatMigrated?.(adapter.name, oldPlatformId, newPlatformId);
        } catch (err) {
          log.error('onChatMigrated handler threw', {
            channelType: adapter.name,
            oldPlatformId,
            newPlatformId,
            err,
          });
        }
        return true;
      };

      // Four SDK dispatch paths — bridge just forwards. All per-wiring
      // engage / accumulate / drop / subscribe decisions live in the host
      // router (src/router.ts routeInbound / evaluateEngage). The bridge
      // only resolves channel ids and sets the platform-confirmed isMention
      // flag that routeInbound evaluates; the router calls back into
      // bridge.subscribe(...) when a mention-sticky wiring engages.

      // Subscribed threads — every message in a thread we've previously
      // engaged. Carry the SDK's `message.isMention` through so mention-mode
      // wirings still fire on in-thread mentions.
      chat.onSubscribedMessage(async (thread, message) => {
        if (await maybeHandleChatMigration(message, thread.id)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(
          channelId,
          thread.id,
          await messageToInbound(message, message.isMention === true, true),
        );
      });

      // @mention in an unsubscribed thread — SDK-confirmed bot mention.
      chat.onNewMention(async (thread, message) => {
        if (await maybeHandleChatMigration(message, thread.id)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, true, true));
      });

      // DMs — by definition addressed to the bot. Thread id flows through
      // so sub-thread context reaches delivery (Slack users can open threads
      // inside a DM). Router collapses DM sub-threads to one session via
      // is_group=0 short-circuit.
      chat.onDirectMessage(async (thread, message) => {
        if (await maybeHandleChatMigration(message, thread.id)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        log.info('Inbound DM received', {
          adapter: adapter.name,
          channelId,
          sender: (message.author as any)?.fullName ?? (message.author as any)?.userId ?? 'unknown',
          threadId: thread.id,
        });
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, true, false));
      });

      // Plain messages in unsubscribed threads.
      //
      // Chat SDK dispatch (handling-events.mdx §"Handler dispatch order") is
      // exclusive: subscribed → onSubscribedMessage; unsubscribed+mention →
      // onNewMention; unsubscribed+pattern-match → onNewMessage. Registering
      // with `/[\s\S]*/` lets the router see every plain message (including
      // media-only messages with empty text) on every unsubscribed thread the
      // getMessagingGroupWithAgentCount (~1 DB read) for unwired channels,
      // so forwarding every one is cheap enough to not need a bridge-side
      // flood gate.
      chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
        if (await maybeHandleChatMigration(message, thread.id)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, false, true));
      });

      // Emoji reactions (add + remove), all Chat SDK platforms. No emoji
      // filter — we forward every reaction; the router decides whether it's
      // a soft trigger (reaction on our own message) or silent accumulate
      // context (reaction between other users). thread.id flows through as
      // the channel/thread id exactly like onNewMessage so the reaction
      // lands in the same session as the message it targets.
      chat.onReaction(async (event: ReactionEvent) => {
        const channelId = adapter.channelIdFromThreadId(event.threadId);
        await setupConfig.onInbound(channelId, event.threadId, reactionToInbound(event));
      });

      // Handle button clicks (ask_user_question)
      chat.onAction(async (event) => {
        if (!event.actionId.startsWith('ncq:')) return;
        const parts = event.actionId.split(':');
        if (parts.length < 3) return;
        const questionId = parts[1];
        const tail = parts.slice(2).join(':');
        const userId = event.user?.userId || '';

        // Resolve render metadata BEFORE dispatching onAction (which deletes the row).
        const render = getAskQuestionRender(questionId);
        // New format: button id/value is an integer index into options (kept
        // short to fit Telegram's 64-byte callback_data cap). Old format:
        // the full value is embedded in actionId/value directly.
        const selectedOption = resolveSelectedOption(render, event.value, tail);
        const title = render?.title ?? '❓ Question';
        const matched = render?.options.find((o) => o.value === selectedOption);
        const selectedLabel = matched?.selectedLabel ?? selectedOption ?? '(clicked)';

        // Update the card to show the selected answer and remove buttons
        try {
          const tid = event.threadId;
          await adapter.editMessage(tid, event.messageId, {
            markdown: `${title}\n\n${selectedLabel}`,
          });
        } catch (err) {
          log.warn('Failed to update card after action', { err });
        }

        setupConfig.onAction(questionId, selectedOption, userId);
      });

      await chat.initialize();

      // Start Gateway listener for adapters that support it (e.g., Discord)
      const gatewayAdapter = adapter as GatewayAdapter;
      if (gatewayAdapter.startGatewayListener) {
        gatewayAbort = new AbortController();

        // Start local HTTP server to receive forwarded Gateway events (including interactions)
        const webhookUrl = await startLocalWebhookServer(gatewayAdapter, setupConfig, config.botToken);

        // Exponential backoff capped at 1h. Without this, an unrecoverable
        // failure (e.g., TokenInvalid) restarts ~10×/sec and Discord's
        // Cloudflare layer issues a multi-hour IP block. A run that lasts
        // longer than 5 minutes counts as healthy and resets the counter.
        let consecutiveFailures = 0;
        const startGateway = () => {
          if (gatewayAbort?.signal.aborted) return;
          const startedAt = Date.now();
          // Capture the long-running listener promise via waitUntil
          let listenerPromise: Promise<unknown> | undefined;
          gatewayAdapter.startGatewayListener!(
            {
              waitUntil: (p: Promise<unknown>) => {
                listenerPromise = p;
              },
            },
            24 * 60 * 60 * 1000,
            gatewayAbort!.signal,
            webhookUrl,
          ).then(() => {
            // startGatewayListener resolves immediately with a Response;
            // the actual work is in the listenerPromise passed to waitUntil
            if (!listenerPromise) return;
            const reschedule = (err?: unknown) => {
              if (gatewayAbort?.signal.aborted) return;
              const ranForMs = Date.now() - startedAt;
              if (ranForMs > 5 * 60 * 1000) consecutiveFailures = 0;
              else consecutiveFailures++;
              const delayMs = Math.min(60 * 60 * 1000, 2 ** consecutiveFailures * 1000);
              if (err) {
                log.error('Gateway listener error, retrying', {
                  adapter: adapter.name,
                  err,
                  consecutiveFailures,
                  delayMs,
                });
              } else {
                log.info('Gateway listener expired, restarting', {
                  adapter: adapter.name,
                  consecutiveFailures,
                  delayMs,
                });
              }
              setTimeout(startGateway, delayMs);
            };
            listenerPromise.then(() => reschedule()).catch(reschedule);
          });
        };
        startGateway();
        log.info('Gateway listener started', { adapter: adapter.name });
      } else {
        // Non-gateway adapters (Slack, Teams, GitHub, etc.) — register on the shared webhook server
        registerWebhookAdapter(chat, adapter.name);
      }

      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {
      // platformId is already in the adapter's encoded format (e.g. "telegram:6037840640",
      // "discord:guildId:channelId") — use it directly as the thread ID
      const tid = threadId ?? platformId;
      const content = message.content as Record<string, unknown>;
      // inReplyTo carries the inbound message id we're replying to. Router
      // namespaces messages_in.id as `<platform-msg-id>:<agent-group-id>`
      // (see router.messageIdForAgent) — strip that suffix so the adapter
      // gets the raw platform message id Discord/etc. expect for native
      // reply chains. Empty/null → no reply pill.
      const replyToRaw = message.inReplyTo ?? null;
      const replyTo = replyToRaw ? replyToRaw.split(':')[0] || null : null;

      if (content.operation === 'edit' && content.messageId) {
        await adapter.editMessage(tid, content.messageId as string, {
          markdown: transformText((content.text as string) || (content.markdown as string) || ''),
        });
        return;
      }

      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        await adapter.addReaction(tid, content.messageId as string, content.emoji as string);
        return;
      }

      if (content.operation === 'remove_reaction' && content.messageId && content.emoji) {
        await adapter.removeReaction(tid, content.messageId as string, content.emoji as string);
        return;
      }

      if (content.operation === 'delete' && content.messageId) {
        await adapter.deleteMessage(tid, content.messageId as string);
        return;
      }

      // Ask question card — render as Card with buttons
      if (content.type === 'ask_question' && content.questionId && content.options) {
        const questionId = content.questionId as string;
        const title = content.title as string;
        const question = content.question as string;
        if (!title) {
          log.error('ask_question missing required title — skipping delivery', { questionId });
          return;
        }
        const options: NormalizedOption[] = normalizeOptions(content.options as never);
        const card = Card({
          title,
          children: [
            CardText(question),
            Actions(
              // Encode button id/value with the option index rather than the
              // full value. Telegram caps callback_data at 64 bytes, and
              // long values (e.g. ISO datetimes, URLs) push the JSON payload
              // well past that. The onAction handlers resolve the index back
              // to the real value via getAskQuestionRender(questionId).
              options.map((opt, idx) =>
                Button({ id: `ncq:${questionId}:${idx}`, label: opt.label, value: String(idx) }),
              ),
            ),
          ],
        });
        const result = await adapter.postMessage(tid, {
          card,
          fallbackText: `${title}\n\n${question}\nOptions: ${options.map((o) => o.label).join(', ')}`,
        });
        return result?.id;
      }

      // Display card (send_card MCP tool) — returns immediately, no callback flow.
      // Non-URL actions are dropped: send_card's contract is fire-and-forget, so a
      // callback button would have nowhere to land. URL actions render as link buttons.
      if (content.type === 'card' && content.card && typeof content.card === 'object') {
        const cardSpec = content.card as Record<string, unknown>;
        const title = (cardSpec.title as string) || '';
        const fallbackText = (content.fallbackText as string) || (cardSpec.description as string) || title || '';

        const cardChildren: CardChild[] = [];
        if (typeof cardSpec.description === 'string' && cardSpec.description) {
          cardChildren.push(CardText(cardSpec.description));
        }
        if (Array.isArray(cardSpec.children)) {
          for (const child of cardSpec.children) {
            if (typeof child === 'string' && child) {
              cardChildren.push(CardText(child));
            } else if (
              child &&
              typeof child === 'object' &&
              typeof (child as Record<string, unknown>).text === 'string'
            ) {
              cardChildren.push(CardText((child as Record<string, string>).text));
            }
          }
        }
        if (Array.isArray(cardSpec.actions)) {
          const linkButtons = (cardSpec.actions as Array<Record<string, unknown>>)
            .filter((a) => typeof a.url === 'string' && a.url && typeof a.label === 'string' && a.label)
            .map((a) => {
              const style = a.style;
              const safeStyle: 'primary' | 'danger' | 'default' | undefined =
                style === 'primary' || style === 'danger' || style === 'default' ? style : undefined;
              return LinkButton({
                label: a.label as string,
                url: a.url as string,
                style: safeStyle,
              });
            });
          if (linkButtons.length > 0) {
            cardChildren.push(Actions(linkButtons));
          }
        }

        if (cardChildren.length === 0 && !title) {
          log.warn('send_card payload empty, skipping delivery');
          return;
        }

        const card = Card({ title, children: cardChildren });
        const result = await adapter.postMessage(tid, { card, fallbackText });
        return result?.id;
      }

      // Normal message
      const rawText = (content.markdown as string) || (content.text as string);
      const text = rawText ? transformText(rawText) : rawText;
      if (text) {
        // Attach files if present (FileUpload format: { data, filename })
        const fileUploads = message.files?.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        // Split if over the adapter's max length. Files ride on the first
        // chunk so the head of the reply still carries them.
        const chunks =
          config.maxTextLength && text.length > config.maxTextLength
            ? splitForLimit(text, config.maxTextLength)
            : [text];
        let firstId: string | undefined;
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const attachFiles = i === 0 && fileUploads && fileUploads.length > 0;
          // Reply pill goes on the first chunk only — subsequent chunks are
          // contiguous follow-ups, not separate replies to the same parent.
          const replyForChunk = i === 0 ? replyTo : null;
          const post = attachFiles ? { markdown: chunk, files: fileUploads } : { markdown: chunk };
          if (replyForChunk) (post as Record<string, unknown>).replyTo = replyForChunk;
          // Discord-only: pass suppressEmbeds through so the patched chat-adapter
          // can set message flags = 4 (SUPPRESS_EMBEDS). Other adapters ignore
          // unknown postable fields.
          if (message.suppressEmbeds) {
            (post as Record<string, unknown>).suppressEmbeds = true;
          }
          const result = await adapter.postMessage(tid, post);
          if (i === 0) firstId = result?.id;
        }
        return firstId;
      } else if (message.files && message.files.length > 0) {
        // Files only, no text
        const fileUploads = message.files.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        const post: Record<string, unknown> = { markdown: '', files: fileUploads };
        if (replyTo) post.replyTo = replyTo;
        const result = await adapter.postMessage(tid, post as never);
        return result?.id;
      }
    },

    async setTyping(platformId: string, threadId: string | null) {
      const tid = threadId ?? platformId;
      await adapter.startTyping(tid);
    },

    async teardown() {
      gatewayAbort?.abort();
      await chat.shutdown();
      log.info('Chat SDK bridge shut down', { adapter: adapter.name });
    },

    isConnected() {
      return true;
    },

    async subscribe(_platformId: string, threadId: string) {
      // Chat SDK's subscription state lives on the StateAdapter (not on the
      // Chat instance itself). SqliteStateAdapter.subscribe is idempotent —
      // a second call on an already-subscribed thread is a no-op. threadId
      // is the SDK's thread id, which is what the router already has from
      // the original inbound event.
      await state.subscribe(threadId);
    },

    async recoverMissedMessages({
      platformId,
      lookbackMs,
      limit,
    }: {
      platformId: string;
      lookbackMs: number;
      limit: number;
    }): Promise<{ recoveredCount: number; earliestTimestamp?: string }> {
      // No-op if setup hasn't run yet — the host must finish setup before
      // recovery makes sense (we need onInbound to replay through).
      if (!setupConfig) return { recoveredCount: 0 };

      // Adapters that don't expose fetchMessages (or where the gateway's
      // resume protocol is the source of truth) can't recover; the host
      // checks for this method's presence so a clean no-op is fine here too.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapterAny = adapter as any;
      if (typeof adapterAny.fetchMessages !== 'function') {
        return { recoveredCount: 0 };
      }

      // platformId is the adapter's encoded thread id for non-threaded
      // platforms (Telegram/WhatsApp use it directly). For threaded
      // platforms (Discord/Slack), recovery operates per-thread because
      // fetchMessages takes a thread id, and the host calls this once per
      // platformId it owns; threaded recovery of every thread inside a
      // guild is an explicit follow-up if/when the host tracks that level.
      const threadId = platformId;
      const cutoffMs = Date.now() - lookbackMs;

      let recoveredCount = 0;
      let earliestTimestamp: string | undefined;

      // Per-page cap. Discord's Get Channel Messages API hard-caps the
      // `limit` query param at 100 (400 code 50035 NUMBER_TYPE_MAX
      // otherwise), so a caller asking for more than that recovered
      // *nothing* for the whole thread. Clamp the page size and instead
      // walk backward page-by-page via the FetchResult cursor until we
      // cross the lookback cutoff — this honors a window larger than one
      // page without ever sending an out-of-range limit. See
      // recoveryPageBudget for the Discord cap rationale.
      const { pageSize, maxPages: MAX_PAGES } = recoveryPageBudget(limit);

      try {
        let cursor: string | undefined;
        let reachedCutoff = false;
        const channelId = adapter.channelIdFromThreadId(threadId);

        for (let page = 0; page < MAX_PAGES && !reachedCutoff; page++) {
          const result = await adapterAny.fetchMessages(threadId, {
            limit: pageSize,
            direction: 'backward',
            ...(cursor ? { cursor } : {}),
          });
          const messages = (result?.messages ?? []) as ChatMessage[];
          if (messages.length === 0) break;

          // chat-sdk returns messages in chronological order (oldest
          // first within the page). Replay in the same order so seq-based
          // dedup and inbound.db PK collisions resolve naturally.
          for (const message of messages) {
            const sentAt = message.metadata?.dateSent?.getTime?.();
            // Pre-cutoff message: we've walked past the window. Older
            // pages are strictly older, so stop after this page.
            if (!sentAt || sentAt < cutoffMs) {
              reachedCutoff = true;
              continue;
            }

            const timestamp = message.metadata.dateSent.toISOString();
            if (!earliestTimestamp || timestamp < earliestTimestamp) {
              earliestTimestamp = timestamp;
            }
            recoveredCount += 1;

            // We don't know whether the historical message belongs to a
            // subscribed thread or is a DM at recovery time. Forward
            // through onInbound with conservative defaults (isMention
            // from the platform-confirmed flag if present; isGroup
            // undefined so the router's existing classification path
            // runs). The router's dedup PK on (session_id, message_id)
            // handles re-routing of any messages already processed
            // before the gap.
            await setupConfig.onInbound(
              channelId,
              threadId,
              await messageToInbound(message, message.isMention === true),
            );
          }

          // No further pages, or the adapter doesn't support cursoring.
          cursor = result?.nextCursor;
          if (!cursor) break;
        }
      } catch (err) {
        log.warn('recoverMissedMessages threw', {
          adapter: adapter.name,
          platformId,
          err: err instanceof Error ? err.message : String(err),
        });
        return { recoveredCount, earliestTimestamp };
      }

      return { recoveredCount, earliestTimestamp };
    },
  };

  // Only expose openDM when the underlying Chat SDK adapter implements it.
  // Delegate straight to adapter.openDM rather than going through chat.openDM:
  // the latter dispatches via inferAdapterFromUserId, which only recognizes
  // Discord snowflakes, Slack U-ids, Teams 29:-ids, and gChat users/-ids, and
  // throws for everything else (Telegram numeric ids, iMessage, Matrix, …).
  // Calling adapter.openDM directly also preserves the adapter's native
  // platform_id encoding via channelIdFromThreadId (e.g. "telegram:<chatId>"),
  // which matches what onInbound stores in messaging_groups — avoiding a
  // duplicate-row / decode-error cascade at delivery time. See user-dm.ts for
  // the direct-addressable fallback when the adapter has no openDM at all.
  if (adapter.openDM) {
    bridge.openDM = async (userHandle: string): Promise<string> => {
      const threadId = await adapter.openDM!(userHandle);
      return adapter.channelIdFromThreadId(threadId);
    };
  }

  return bridge;
}

/**
 * Start a local HTTP server to receive forwarded Gateway events.
 * This is needed because the Gateway listener in webhook-forwarding mode
 * sends ALL raw events (including INTERACTION_CREATE for button clicks)
 * to the webhookUrl, which we handle here.
 */
function startLocalWebhookServer(
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        handleForwardedEvent(body, adapter, setupConfig, botToken)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          })
          .catch((err) => {
            log.error('Webhook server error', { err });
            res.writeHead(500);
            res.end('{"error":"internal"}');
          });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/webhook`;
      log.info('Local webhook server started', { port: addr.port });
      resolve(url);
    });
  });
}

async function handleForwardedEvent(
  body: string,
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
): Promise<void> {
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return;
  }

  // Handle interaction events (button clicks) — not handled by adapter's handleForwardedGatewayEvent
  if (event.type === 'GATEWAY_INTERACTION_CREATE' && event.data) {
    const interaction = event.data;
    // type 3 = MessageComponent (button/select)
    if (interaction.type === 3) {
      const customId = (interaction.data as Record<string, unknown>)?.custom_id as string;
      // In guilds the clicker is at interaction.member.user; in DMs it's interaction.user directly.
      const user =
        ((interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined) ??
        (interaction.user as Record<string, string> | undefined);
      const interactionId = interaction.id as string;
      const interactionToken = interaction.token as string;

      // Parse the selected option from custom_id
      let questionId: string | undefined;
      let tail: string | undefined;
      if (customId?.startsWith('ncq:')) {
        const colonIdx = customId.indexOf(':', 4); // after "ncq:"
        if (colonIdx !== -1) {
          questionId = customId.slice(4, colonIdx);
          tail = customId.slice(colonIdx + 1);
        }
      }

      // Update the card to show the selected answer and remove buttons
      const originalEmbeds =
        ((interaction.message as Record<string, unknown>)?.embeds as Array<Record<string, unknown>>) || [];
      const originalDescription = (originalEmbeds[0]?.description as string) || '';
      const render = questionId ? getAskQuestionRender(questionId) : undefined;
      // Discord custom_id mirrors the new index-based encoding (see Button
      // construction). Decode back to the real option value for downstream.
      const selectedOption = resolveSelectedOption(render, tail, tail);
      const cardTitle = render?.title ?? ((originalEmbeds[0]?.title as string) || '❓ Question');
      const matchedOpt = render?.options.find((o) => o.value === selectedOption);
      const selectedLabel = matchedOpt?.selectedLabel ?? selectedOption ?? customId;
      try {
        await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 7, // UPDATE_MESSAGE — acknowledge + update in one call
            data: {
              embeds: [
                {
                  title: cardTitle,
                  description: `${originalDescription}\n\n${selectedLabel}`,
                },
              ],
              components: [], // remove buttons
            },
          }),
        });
      } catch (err) {
        log.error('Failed to update interaction', { err });
      }

      // Dispatch to host
      if (questionId && selectedOption) {
        setupConfig.onAction(questionId, selectedOption, user?.id || '');
      }
      return;
    }
  }

  // Forward other events to the adapter's webhook handler for normal processing
  const fakeRequest = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-discord-gateway-token': botToken || '',
    },
    body,
  });
  await adapter.handleWebhook(fakeRequest, {});
}
