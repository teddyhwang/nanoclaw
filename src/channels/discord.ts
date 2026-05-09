/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
    messageId: typeof reply.id === 'string' ? reply.id : undefined,
  };
}

/**
 * Discord renders `[text](url)` as a clickable link only inside embeds, not
 * in normal message content — there it shows as literal `[text](url)` text.
 * Agents (especially Claude SDK) frequently emit `[https://x](https://x)`
 * where label == href. Collapse those to the bare URL so Discord auto-links
 * them. Leave `[different label](url)` alone — Discord still shows it as
 * literal text but the label carries information the URL alone wouldn't.
 *
 * Patterns handled:
 *   `[https://foo](https://foo)`        → `https://foo`
 *   `[<https://foo>](<https://foo>)`    → `<https://foo>`  (Discord auto-link suppressor preserved)
 *   `[ https://foo ](https://foo)`      → `https://foo`    (whitespace tolerance)
 *
 * Idempotent and safe on text without markdown links.
 */
export function collapseRedundantMarkdownLinks(text: string): string {
  // Greedy-but-safe pattern: `[ X ]( Y )` where X and Y trim to the same string.
  return text.replace(/\[([^\]\n]+)\]\(([^)\n\s]+)\)/g, (whole, label, href) => {
    const labelTrim = label.trim();
    if (labelTrim === href) return href;
    // Also handle the `<url>` auto-link-suppressor wrapping: `<https://x>` ≡ `https://x`
    if (labelTrim.replace(/^<|>$/g, '') === href.replace(/^<|>$/g, '')) {
      return href;
    }
    return whole;
  });
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      transformOutboundText: collapseRedundantMarkdownLinks,
    });
  },
});
