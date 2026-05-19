import { describe, expect, it } from 'bun:test';

import { extractAssistantText, selectResultTextForDelivery } from './claude.js';

describe('ClaudeProvider result delivery helpers', () => {
  it('extracts text from SDK assistant message content blocks', () => {
    const text = extractAssistantText({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '<message to="chat">Done.</message>' },
          { type: 'tool_use', name: 'TodoWrite' },
          { type: 'text', text: '<internal>logged</internal>' },
        ],
      },
    });

    expect(text).toBe('<message to="chat">Done.</message>\n<internal>logged</internal>');
  });

  it('uses the last assistant message when the final SDK result is internal-only', () => {
    const text = selectResultTextForDelivery(
      '<internal>Page updated and notes logged.</internal>',
      '<message to="chat">Done — page is current.</message>',
    );

    expect(text).toBe('<message to="chat">Done — page is current.</message>');
  });

  it('keeps a wrapped final SDK result instead of replaying an earlier assistant message', () => {
    const text = selectResultTextForDelivery(
      '<message to="chat">Final answer.</message>',
      '<message to="chat">Working on it.</message>',
    );

    expect(text).toBe('<message to="chat">Final answer.</message>');
  });

  it('treats message blocks with extra attributes as wrapped final results', () => {
    const text = selectResultTextForDelivery(
      '<message to="chat" reply_to_message_id="#7">Resolved.</message>',
      '<message to="chat">Working on it.</message>',
    );

    expect(text).toBe('<message to="chat" reply_to_message_id="#7">Resolved.</message>');
  });

  it('keeps unwrapped public final text so the poll-loop safety net can label it', () => {
    const text = selectResultTextForDelivery('Done but forgot the wrapper.', '<message to="chat">Working.</message>');

    expect(text).toBe('Done but forgot the wrapper.');
  });
});
