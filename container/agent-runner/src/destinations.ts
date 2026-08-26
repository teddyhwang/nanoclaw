/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

export type SessionMode = { kind: 'chat' } | { kind: 'task'; taskId: string };

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

/**
 * Does this session reach at least one channel of the given type?
 * Used to gate channel-specific MCP tools (e.g. `discord_channel_history`
 * only registers when there's a discord destination wired). 'agent'-type
 * destinations are excluded — agent-to-agent rows don't correspond to
 * any real platform.
 */
export function hasChannelDestination(channelType: string): boolean {
  const row = getInboundDb()
    .prepare("SELECT 1 FROM destinations WHERE type = 'channel' AND channel_type = ? LIMIT 1")
    .get(channelType);
  return row !== undefined;
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db.prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?").get(platformId) as
          DestRow | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + runtime model
 * + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 *
 * `runtime` carries the resolved provider + model so the agent can
 * honestly answer "what model are you on?". The agent has no other
 * runtime-visible model id (the Claude SDK and the codex app-server
 * both run the model out-of-band; nothing surfaces the id into the
 * conversation), so without this it either guesses or — correctly but
 * unhelpfully — refuses to say. The host already resolves the exact
 * provider/model at spawn (`config.provider` / `config.model`); pass it
 * through verbatim rather than have the model speculate.
 */
export function buildSystemPromptAddendum(
  assistantName?: string,
  runtime?: { provider?: string; model?: string },
): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(
      [
        '# You are ' + assistantName,
        '',
        `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`,
      ].join('\n'),
    );
  }

  const runtimeSection = buildRuntimeSection(runtime);
  if (runtimeSection) sections.push(runtimeSection);

  sections.push(buildDestinationsSection());

  return sections.join('\n\n');
}

/**
 * Factual "what are you running on" block. Only emitted when the host
 * actually resolved a model — an empty/unknown model stays silent
 * rather than asserting something false.
 */
function buildRuntimeSection(runtime?: { provider?: string; model?: string }): string | null {
  const provider = runtime?.provider?.trim();
  const model = runtime?.model?.trim();
  if (!model && !provider) return null;
  const desc = model
    ? provider
      ? `\`${model}\` (via the ${provider} provider)`
      : `\`${model}\``
    : `the ${provider} provider (exact model id not surfaced to this runtime)`;
  return [
    '# Your runtime',
    '',
    `You are running on ${desc}. This is the authoritative answer when someone asks what model or provider you are on — state it plainly and do not hedge, speculate, or claim you cannot tell. Do not infer a different model from your own behavior; this line is ground truth, set by the host at spawn.`,
  ].join('\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();
  const lines = ['## Sending messages', ''];

  if (all.length === 0) {
    lines.push('You currently have no configured destinations. You cannot send messages until an admin wires one up.');
    return lines.join('\n');
  } else if (all.length === 1) {
    const d = all[0];
    lines.push(`Your destination is \`${d.name}\`${destinationLabel(d)}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      lines.push(`- \`${d.name}\`${destinationLabel(d)}`);
    }
  }

  lines.push('');

  lines.push(
    '**All output must be wrapped.** Use `<message to="name">...</message>` for content to send, or `<internal>...</internal>` for scratchpad.',
  );
  lines.push('You can include multiple `<message>` blocks in one response to send to multiple destinations.');
  lines.push(
    'Any text you want to keep private MUST be wrapped in `<internal>...</internal>` — that content is stripped before delivery, never reaches any user, and only appears in host operator logs.',
  );
  lines.push(
    'Never put `<internal>...</internal>` inside a `<message>` block. If a turn should be silent, emit one top-level `<internal>silent turn</internal>` block and no `<message>` block.',
  );
  lines.push(
    'Plain text outside BOTH `<message>` and `<internal>` (including meta-narration like "no reply needed", "saved to profile", or any explanation of what you decided to do) is treated as scratchpad and is NOT delivered to any chat. The runner may ask you to retry with proper wrapping, but users will not see the unwrapped text. So: every character is either inside `<message>` (sent to a named destination) or inside `<internal>` (kept private). Nothing else. If you have nothing to say, emit a single `<internal>silent turn</internal>` and stop.',
  );
  lines.push('');
  lines.push(
    '**A silent turn is NOT allowed when you were directly addressed.** The host only wakes you for a chat turn when the engagement gate already decided this message is for you (a direct @mention of you, a reply to one of your messages, or a pattern match). If the triggering message mentions you by name/handle OR asks you a direct question, you MUST emit a `<message>` reply — answer it, or if you genuinely cannot, say so explicitly (e.g. "I don\'t know" / "I can\'t do that" / a one-line acknowledgment). Staying silent on a question or a mention reads as the bot being broken. **This holds even when another person already answered the same question in the same batch of messages.** Being @mentioned or directly asked obligates YOU to respond — do not treat a human\'s same-batch answer as "already handled" and go silent; that is the single most common way this rule gets wrongly skipped. If someone beat you to the answer, still reply: confirm it ("Yep, July 23rd"), add anything useful, or briefly acknowledge — but do not vanish on a message that tagged you. `<internal>silent turn</internal>` is only for turns where you were woken by ambient context or your own scheduled task and there is genuinely nothing to say to anyone — never as a way to skip answering someone who addressed you, and never because someone else answered first.',
  );
  lines.push('');
  lines.push(
    'Wrap each delivered message in a `<message to="name">…</message>` block; include several blocks in one response to address several destinations. `<internal>…</internal>` marks thinking you don\'t want sent.',
  );
  lines.push(
    'To visibly chain a new outbound message under an earlier delivered message, add `reply_to_message_id="#N"` to the `<message>` tag (for example `<message to="name" reply_to_message_id="#7">Resolved.</message>`). Use only a message id from the same destination.',
  );
  lines.push('');
  lines.push(
    'When replying to an incoming message, address the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute — that is where the question was asked and where the answer belongs). This is a hard default, not a preference: the answer to a question goes back to the chat that asked it. Send to a DIFFERENT destination ONLY when the triggering message explicitly directs it elsewhere by name (e.g. "tell Laura that…", "post this to the family group"). The topic or content of your answer is NEVER a reason to switch destinations — even if the answer concerns another chat, another person, or another group, a reply to a question still goes back to the `from` chat unless the user named a different target. Answering in a different chat than the one that asked (e.g. a question from a Telegram DM answered into a WhatsApp group) is a routing error the user experiences as the bot sending their private answer to the wrong place.',
  );
  lines.push('');
  lines.push(
    'The `send_message` MCP tool is the same delivery, available mid-turn. It also accepts `reply_to_message_id` for the same reply-pill behavior. Each `send_message` call and each final-response `<message>` block lands as its own message in the conversation, so they read as a sequence rather than as one combined reply.',
  );
  lines.push('');
  lines.push(
    'An acknowledgment is only an acknowledgment if it arrives BEFORE the slow work. A `<message>` block in your final response is NOT an acknowledgment: nothing in your final response is delivered until the whole turn finishes, so an "on it" written there lands at the same moment as the result — seconds apart, and often AFTER the result if you already delivered it with `send_file` or `send_message`. The user sees two messages arrive together and reasonably concludes the ack was pointless. So: if you are about to call a tool that takes more than a few seconds (generating an image, browsing, a long search), send the acknowledgment with `send_message` FIRST, then make the slow call. Never put the ack in your final response and never repeat it there afterwards.',
  );
  lines.push('');
  lines.push(
    'For a short turn, do not narrate. For longer work, send one acknowledgment and then updates only at meaningful milestones, especially before slow operations. Never narrate micro-steps; finish with the outcome, not a play-by-play.',
  );
  return lines.join('\n');
}

function destinationLabel(d: DestinationEntry): string {
  const parts: string[] = [];
  if (d.channelType) parts.push(d.channelType);
  if (d.displayName && d.displayName !== d.name) parts.push(d.displayName);
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}
