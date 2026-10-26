import { expect, it } from 'vitest';
import { outboundHistory, outboundHistoryText } from './outbound-history.js';

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
it('picks text/markdown in the bridge order: sends markdown first, edits text first', () => {
  const both = { text: 'plain fallback', markdown: '**shown**' };
  expect(outboundHistoryText(both)).toBe('**shown**');
  expect(outboundHistory(both, 'send')).toEqual({ text: '**shown**', plainText: true });
  expect(outboundHistory({ ...both, operation: 'edit', messageId: 'm' }, 'edit')).toEqual({
    text: 'plain fallback',
    plainText: false,
  });
  // An empty first choice falls through, like the bridge's `||`.
  expect(outboundHistoryText({ text: 'used', markdown: '' })).toBe('used');
  expect(outboundHistoryText({ text: '', markdown: 'used' }, 'edit')).toBe('used');
});
it('flags only sends the bridge posts as (splittable) plain text; long cards and questions are whole', () => {
  const long = 'x'.repeat(2500);
  expect(outboundHistory({ text: long })).toEqual({ text: long, plainText: true });
  const card = outboundHistory({ type: 'card', fallbackText: 'short', card: { title: 'Alert', description: long } });
  expect(card).toEqual({ text: `Alert\n\n${long}`, plainText: false });
  const question = outboundHistory({
    type: 'ask_question',
    questionId: 'q1',
    title: 'Pick',
    question: long,
    options: ['Yes', 'No'],
  });
  expect(question).toEqual({ text: `Pick\n\n${long}\nOptions: Yes, No`, plainText: false });
  // A card carrying a text field is still posted as a card, never split.
  expect(outboundHistory({ type: 'card', text: long, card: { title: 'T' } }).plainText).toBe(false);
  expect(outboundHistory({ fallbackText: 'only' }).plainText).toBe(false);
});
it('handles absent optional fields and resolution-only custom terminal cards', () => {
  expect(outboundHistoryText({ type: 'ask_question', title: 'Question' })).toBe('Question');
  expect(outboundHistoryText({ terminalCard: { resolution: 'Rejected' } })).toBe('Rejected');
  expect(outboundHistoryText({ type: 'card', fallbackText: 'Fallback' })).toBe('Fallback');
});
