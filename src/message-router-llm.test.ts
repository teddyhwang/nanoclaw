import { beforeEach, describe, expect, it } from 'vitest';

import {
  classifyByKeywords,
  classifyMessage,
  markAssistantRoute,
  markDevRoute,
} from './message-router-llm.js';

beforeEach(() => {
  markAssistantRoute('chat-assistant');
  markAssistantRoute('chat-dev');
  markAssistantRoute('chat-explicit');
});

describe('message router LLM heuristics', () => {
  it('classifies alarm status questions as assistant requests', () => {
    expect(classifyByKeywords('is my alarm on?')).toBe('assistant');
  });

  it('keeps short ambiguous replies in dev context routed to dev', async () => {
    markDevRoute('chat-dev');

    await expect(classifyMessage('yes', 'chat-dev')).resolves.toBe('dev');
  });

  it('does not hijack short assistant requests in dev context', async () => {
    markDevRoute('chat-assistant');

    await expect(
      classifyMessage('is my alarm on?', 'chat-assistant'),
    ).resolves.toBe('assistant');
  });

  it('always routes explicit /dev messages to dev', async () => {
    await expect(
      classifyMessage('/dev fix the router', 'chat-explicit'),
    ).resolves.toBe('dev');
  });
});
