import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let initial: Record<string, unknown>;
let liveEffort: unknown;
let rejectControl = false;
let inputs: { prompt: string; effort: unknown }[] = [];
let controls: unknown[] = [];
let onInput: ((index: number) => void) | undefined;
let beforeResult: ((index: number) => Promise<void>) | undefined;
let beforeControl: ((index: number) => Promise<void>) | undefined;
let atResult: unknown[] = [];
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => {
      resolve = r;
    }),
    resolve: () => resolve(),
  };
}
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
        const index = inputs.length;
        inputs.push({ prompt: input.message.content, effort: liveEffort });
        onInput?.(index);
        yield { type: 'system', subtype: 'init', session_id: 'fixture-session' };
        await beforeResult?.(index);
        atResult.push(liveEffort);
        yield { type: 'result', subtype: 'success', result: 'fixture-only' };
      }
    })();
    return Object.assign(events, {
      applyFlagSettings: async (settings: { effortLevel: unknown }) => {
        controls.push(settings);
        await beforeControl?.(controls.length - 1);
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
  onInput = undefined;
  beforeResult = undefined;
  beforeControl = undefined;
  atResult = [];
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
function query(effort?: string, prompt = 'fixture initial') {
  const provider = createProvider('claude', { model: 'claude-sonnet-5-5', effort });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider.query({ prompt, cwd: tmp });
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
  it('paused active Low stays frozen; queued High then Low are individually ACKed and completed before the next control', async () => {
    let selected = 'low';
    const reads: string[] = [];
    setClaudeInputEffortResolver(() => {
      reads.push(selected);
      return selected;
    });
    const starts = [deferred(), deferred(), deferred()];
    const answers = [deferred(), deferred(), deferred()];
    const ackStarts = [deferred(), deferred()];
    const acks = [deferred(), deferred()];
    onInput = (i) => starts[i].resolve();
    beforeResult = (i) => answers[i].promise;
    beforeControl = async (i) => {
      ackStarts[i].resolve();
      await acks[i].promise;
    };
    const q = query();
    const output: { type: string }[] = [];
    const consume = (async () => {
      for await (const e of q.events) output.push(e);
    })();
    await starts[0].promise;
    selected = 'high';
    q.push('queued High');
    selected = 'low';
    q.push('queued Low');
    selected = 'max'; // later config changes must not rewrite queued snapshots
    await new Promise<void>((r) => setImmediate(r));
    expect(controls).toEqual([]);
    expect(liveEffort).toBe('low');
    expect(inputs).toHaveLength(1);
    answers[0].resolve();
    await ackStarts[0].promise;
    expect(atResult).toEqual(['low']);
    expect(inputs).toHaveLength(1); // no forwarding before High ACK
    acks[0].resolve();
    await starts[1].promise;
    await new Promise<void>((r) => setImmediate(r));
    expect(controls).toEqual([{ effortLevel: 'high' }]);
    expect(liveEffort).toBe('high');
    expect(inputs).toHaveLength(2); // queued Low cannot overwrite active High
    answers[1].resolve();
    await ackStarts[1].promise;
    expect(atResult).toEqual(['low', 'high']);
    expect(inputs).toHaveLength(2); // no forwarding before Low ACK
    acks[1].resolve();
    await starts[2].promise;
    q.end(); // graceful EOF drains the accepted final input
    answers[2].resolve();
    await consume;
    expect(inputs).toEqual([
      { prompt: 'fixture initial', effort: 'low' },
      { prompt: 'queued High', effort: 'high' },
      { prompt: 'queued Low', effort: 'low' },
    ]);
    expect(atResult).toEqual(['low', 'high', 'low']);
    expect(reads).toEqual(['low', 'high', 'low']);
    expect(output.filter((e) => e.type === 'result')).toHaveLength(3);
  });

  it('Stop cancels queued setting changes and prompts without reordering or replay', async () => {
    let selected = 'low';
    setClaudeInputEffortResolver(() => selected);
    const started = deferred();
    const answer = deferred();
    onInput = () => started.resolve();
    beforeResult = () => answer.promise;
    const q = query();
    const consume = (async () => {
      for await (const _ of q.events) {
        /* drain */
      }
    })();
    await started.promise;
    selected = 'high';
    q.push('must remain queued');
    q.abort();
    answer.resolve();
    await consume;
    expect(controls).toEqual([]);
    expect(inputs).toHaveLength(1);
  });

  it('empty prewarm input does not create a result gate or send an empty prompt', async () => {
    let selected = 'low';
    setClaudeInputEffortResolver(() => selected);
    const q = query(undefined, '');
    selected = 'high';
    q.push('first real fixture');
    const events = q.events[Symbol.asyncIterator]();
    await untilResult(events);
    expect(inputs).toEqual([{ prompt: 'first real fixture', effort: 'high' }]);
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
