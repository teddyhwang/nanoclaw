import { normalizeOptions } from './ask-question.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export interface OutboundHistory {
  /** Searchable, user-visible body. */
  text: string | null;
  /**
   * True when the Chat SDK bridge posts this send through its plain-text
   * path, the only path that splits text over the adapter's `maxTextLength`.
   * Cards and questions are posted whole, so history must not trim them.
   */
  plainText: boolean;
}

/**
 * The plain body as the bridge picks it: sends post `markdown || text`, edits
 * `text || markdown` (chat-sdk-bridge `deliver`). History follows the same
 * order so it stores what the platform shows.
 */
function plainBody(content: Record<string, unknown>, operation: 'send' | 'edit' | 'delete'): unknown {
  const [first, second] = operation === 'edit' ? [content.text, content.markdown] : [content.markdown, content.text];
  if (typeof first === 'string' && first) return first;
  if (typeof second === 'string' && second) return second;
  return first ?? second;
}

/** Sends the bridge renders as a question or display card, never as split text. */
function structuredSend(content: Record<string, unknown>): boolean {
  return (
    (content.type === 'ask_question' && Boolean(content.questionId) && Boolean(content.options)) ||
    (content.type === 'card' && Boolean(content.card) && typeof content.card === 'object')
  );
}

/** History text plus whether the send took the bridge's (splittable) plain-text path. */
export function outboundHistory(
  content: Record<string, unknown>,
  operation: 'send' | 'edit' | 'delete' = 'send',
): OutboundHistory {
  const plain = plainBody(content, operation);
  const hasPlain = typeof plain === 'string' && plain.trim() !== '';
  return {
    text: renderHistoryText(content, plain),
    plainText: operation === 'send' && hasPlain && !structuredSend(content),
  };
}

/** Searchable, user-visible body for structured Chat SDK deliveries. Never index callback IDs or option values. */
export function outboundHistoryText(
  content: Record<string, unknown>,
  operation: 'send' | 'edit' | 'delete' = 'send',
): string | null {
  return renderHistoryText(content, plainBody(content, operation));
}

function renderHistoryText(content: Record<string, unknown>, plain: unknown): string | null {
  if (typeof plain === 'string' && plain.trim()) return plain;
  const terminal = record(content.terminalCard);
  if (Object.keys(terminal).length) {
    return (
      [text(terminal.title), text(terminal.question), text(terminal.resolution)].filter(Boolean).join('\n\n') || null
    );
  }
  if (content.type === 'ask_question') {
    const options = Array.isArray(content.options) ? normalizeOptions(content.options) : [];
    return (
      [text(content.title), text(content.question)].filter(Boolean).join('\n\n') +
        (options.length ? `\nOptions: ${options.map((o) => o.label).join(', ')}` : '') || null
    );
  }
  if (content.type === 'card') {
    const card = record(content.card);
    const children = Array.isArray(card.children)
      ? card.children.map((child) => text(typeof child === 'string' ? child : record(child).text))
      : [];
    const actions = Array.isArray(card.actions)
      ? card.actions.map((action) => {
          const a = record(action);
          return text(a.label) && text(a.url) ? `${text(a.label)}: ${text(a.url)}` : '';
        })
      : [];
    return (
      [text(card.title), text(card.description), ...children, ...actions].filter(Boolean).join('\n\n') ||
      text(content.fallbackText) ||
      null
    );
  }
  return text(content.fallbackText) || (typeof plain === 'string' ? plain : null);
}
