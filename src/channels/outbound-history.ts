import { normalizeOptions } from './ask-question.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Searchable, user-visible body for structured Chat SDK deliveries. Never index callback IDs or option values. */
export function outboundHistoryText(content: Record<string, unknown>): string | null {
  const plain = content.text ?? content.markdown;
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
