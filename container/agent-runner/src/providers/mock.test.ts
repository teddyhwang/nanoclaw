import { describe, expect, it } from 'bun:test';

import { MockProvider } from './mock.js';
import type { ProviderEvent } from './types.js';

async function collect(provider: MockProvider): Promise<ProviderEvent[]> {
  const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
  query.end();
  const events: ProviderEvent[] = [];
  for await (const event of query.events) events.push(event);
  return events;
}

describe('MockProvider merged behavior and streaming API', () => {
  it('accepts the upstream text factory shape and emits text before result', async () => {
    const events = await collect(
      new MockProvider(
        {},
        (prompt) => `result:${prompt}`,
        (prompt) => [`segment:${prompt}`],
      ),
    );

    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: 'segment:hello' },
      { type: 'text', text: 'result:hello' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'result', text: 'result:hello' });
  });

  it('accepts the Optimus behavior object without treating it as a text factory', async () => {
    const events = await collect(
      new MockProvider({}, undefined, {
        retryableErrorNoResult: 'transport died',
      }),
    );

    expect(events.some((event) => event.type === 'text')).toBe(false);
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'transport died', retryable: true });
  });

  it('retains nullable result fixtures without inventing a text event', async () => {
    const events = await collect(new MockProvider({}, () => null));

    expect(events.some((event) => event.type === 'text')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'result', text: null });
  });
});
