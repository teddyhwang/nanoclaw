/** Installed SDK, fake CLI process: no CLI/provider/network is started. */
import { expect, it } from 'bun:test';
import { query, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

it('installed SDK serializes acknowledged live explicit effort controls; null is native-default reset, not Auto omission', async () => {
  const stdout = new PassThrough();
  const process = new EventEmitter();
  const controls: { subtype: string; settings?: unknown }[] = [];
  let pending = '';
  let killed = false;
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      pending += chunk.toString();
      let index: number;
      while ((index = pending.indexOf('\n')) !== -1) {
        const text = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (!text) continue;
        const frame = JSON.parse(text);
        if (frame.type === 'control_request') {
          controls.push(frame.request);
          stdout.write(
            JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response:
                  frame.request.subtype === 'initialize'
                    ? { commands: [], models: [], output_style: 'default', available_output_styles: [] }
                    : {},
              },
            }) + '\n',
          );
        }
      }
      done();
    },
  });
  const fake = Object.assign(process, {
    stdin,
    stdout,
    get killed() {
      return killed;
    },
    exitCode: null,
    kill: () => {
      killed = true;
      stdout.end();
      process.emit('exit', 0, null);
      return true;
    },
  }) as unknown as SpawnedProcess;
  let release!: () => void;
  const finished = new Promise<void>((r) => {
    release = r;
  });
  const q = query({
    prompt: (async function* () {
      await finished;
    })(),
    options: { model: 'claude-sonnet-5-5', effort: 'low', spawnClaudeCodeProcess: () => fake },
  });
  try {
    await q.applyFlagSettings({ effortLevel: 'high' });
    await q.applyFlagSettings({ effortLevel: 'low' });
    await q.applyFlagSettings({ effortLevel: null });
    expect(controls.filter((c) => c.subtype === 'apply_flag_settings')).toEqual([
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } },
      { subtype: 'apply_flag_settings', settings: { effortLevel: null } },
    ]);
  } finally {
    q.close();
    release();
  }
});
