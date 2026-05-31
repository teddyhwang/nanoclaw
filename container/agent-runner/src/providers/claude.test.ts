import { describe, expect, it } from 'bun:test';

import { extractAssistantText, mcpTimeoutEnv, selectResultTextForDelivery } from './claude.js';

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

describe('mcpTimeoutEnv', () => {
  it('applies default MCP timeouts when the inherited env has none', () => {
    const env = mcpTimeoutEnv({});
    // Defaults: 120s tool-call bound, 30s connect bound. A hung MCP call is
    // aborted by the CLI instead of wedging the turn for the host's 60-min
    // MCP_TOOL_CEILING_MS (the Cook-chat freeze, 2026-05-31).
    expect(env.MCP_TOOL_TIMEOUT).toBe('120000');
    expect(env.MCP_TIMEOUT).toBe('30000');
  });

  it('lets an explicit host/operator override win over the default', () => {
    const env = mcpTimeoutEnv({ MCP_TOOL_TIMEOUT: '5000', MCP_TIMEOUT: '1000' });
    expect(env.MCP_TOOL_TIMEOUT).toBe('5000');
    expect(env.MCP_TIMEOUT).toBe('1000');
  });

  it('defaults each var independently', () => {
    const env = mcpTimeoutEnv({ MCP_TOOL_TIMEOUT: '90000' });
    expect(env.MCP_TOOL_TIMEOUT).toBe('90000');
    expect(env.MCP_TIMEOUT).toBe('30000');
  });
});
