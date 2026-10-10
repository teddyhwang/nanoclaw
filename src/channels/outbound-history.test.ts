import { expect, it } from 'vitest';
import { outboundHistoryText } from './outbound-history.js';

it('keeps ordinary message text unchanged', () => {
  expect(outboundHistoryText({ text: ' hello\n' })).toBe(' hello\n');
  expect(outboundHistoryText({ markdown: '**hello**' })).toBe('**hello**');
  expect(outboundHistoryText({})).toBeNull();
});
it('renders labels, not hidden callback values', () => {
  expect(
    outboundHistoryText({
      type: 'ask_question',
      title: 'Choose an agent',
      question: 'Which?',
      options: [{ label: 'Degenerates', value: 'private-id' }, 'Ignore'],
    }),
  ).toBe('Choose an agent\n\nWhich?\nOptions: Degenerates, Ignore');
});
it('renders display card text, children and supported link actions even with a short fallback', () => {
  expect(
    outboundHistoryText({
      type: 'card',
      fallbackText: 'short',
      card: {
        title: 'Alert',
        description: 'Details',
        children: ['More', { text: 'Last' }],
        actions: [
          { label: 'Read', url: 'https://example.com' },
          { label: 'Hidden', value: 'callback' },
        ],
      },
    }),
  ).toBe('Alert\n\nDetails\n\nMore\n\nLast\n\nRead: https://example.com');
});
it('handles absent optional fields and resolution-only custom terminal cards', () => {
  expect(outboundHistoryText({ type: 'ask_question', title: 'Question' })).toBe('Question');
  expect(outboundHistoryText({ terminalCard: { resolution: 'Rejected' } })).toBe('Rejected');
  expect(outboundHistoryText({ type: 'card', fallbackText: 'Fallback' })).toBe('Fallback');
});
