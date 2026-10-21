import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let initial: Record<string, unknown>;
let liveEffort: unknown;
let rejectControl = false;
let inputs: { prompt: string; effort: unknown }[] = [];
let controls: unknown[] = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<{ message: { content: string } }>;
    options: Record<string, unknown>;
  }) => {
    initial = options;
    liveEffort = options.effort;
    const events = (async function* () {
      for await (const input of prompt) {
        inputs.push({ prompt: input.message.content, effort: liveEffort });
        yield { type: 'system', subtype: 'init', session_id: 'fixture-session' };
        yield { type: 'result', subtype: 'success', result: 'fixture-only' };
      }
    })();
    return Object.assign(events, {
      applyFlagSettings: async (settings: { effortLevel: unknown }) => {
        controls.push(settings);
        if (rejectControl) throw new Error('fixture refusal');
        liveEffort = settings.effortLevel;
      },
      close: () => {},
    });
  },
}));
await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { setClaudeInputEffortResolver } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
let tmp: string;
let oldHome: string | undefined;
beforeEach(() => {
  controls = [];
  inputs = [];
  rejectControl = false;
  oldHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-input-effort-'));
  process.env.HOME = tmp;
});
afterEach(() => {
  setClaudeInputEffortResolver(undefined);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});
async function untilResult(events: AsyncIterator<{ type: string }>) {
  for (;;) {
    const event = await events.next();
    if (event.done || event.value.type === 'result' || event.value.type === 'error') return event;
  }
}
function query(effort?: string) {
  const provider = createProvider('claude', { model: 'claude-sonnet-5-5', effort });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider.query({ prompt: 'fixture initial', cwd: tmp });
}
describe('Claude supported SDK effort boundary', () => {
  it('unchanged standalone callers keep their existing SDK default/options', async () => {
    const q = query();
    const events = q.events[Symbol.asyncIterator]();
    await untilResult(events);
    expect(initial.effort).toBeUndefined();
    q.push('fixture continuation');
    await untilResult(events);
    expect(controls).toEqual([]);
    expect(inputs.map((i) => i.effort)).toEqual([undefined, undefined]);
    q.end();
    await events.next();
  });
  it('effective owner level at startup, ACKed changed warm input, no mid-turn update, explicit override and clear', async () => {
    let selected: string | undefined = 'low';
    setClaudeInputEffortResolver((model, stored) => {
      expect(model).toBe('claude-sonnet-5-5');
      expect(stored).toBeUndefined();
      return selected;
    });
    const q = query();
    const events = q.events[Symbol.asyncIterator]();
    await untilResult(events);
    expect(initial.effort).toBe('low');
    selected = 'high';
    expect(controls).toEqual([]); // only the next ordinary input is affected
    q.push('fixture asks for MAX; task text is not configuration');
    await untilResult(events);
    expect(controls).toEqual([{ effortLevel: 'high' }]);
    selected = 'low'; // persisted per-agent override wins in the install resolver
    q.push('fixture override');
    await untilResult(events);
    selected = undefined; // clear restores SDK's native model default, not app Medium
    q.push('fixture clear');
    await untilResult(events);
    expect(inputs.map((i) => i.effort)).toEqual(['low', 'high', 'low', null]);
    expect(controls).toEqual([{ effortLevel: 'high' }, { effortLevel: 'low' }, { effortLevel: null }]);
    q.end();
    await events.next();
  });
  it('refused control fails closed before forwarding the next prompt', async () => {
    let selected = 'low';
    setClaudeInputEffortResolver(() => selected);
    const q = query();
    const events = q.events[Symbol.asyncIterator]();
    await untilResult(events);
    selected = 'high';
    rejectControl = true;
    q.push('must never reach SDK input');
    const failure = await untilResult(events);
    expect(failure.value).toMatchObject({ type: 'error', retryable: false });
    expect(inputs).toHaveLength(1);
    expect(controls).toEqual([{ effortLevel: 'high' }]);
  });
});
