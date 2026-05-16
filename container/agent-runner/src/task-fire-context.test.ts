import { describe, expect, it } from 'bun:test';

import { dropUnrunTaskContexts, registerTaskFireContextOnce, type TaskFireContext } from './poll-loop.js';
import type { MessageInRow } from './db/messages-in.js';

// Issue A (telegram_dm_teddy 23folg, 2026-05-16): a busy agent-shared
// session showed 6 completed dream-task rows and ZERO task_fires. The
// fix seeds a fire context right after markProcessing — ahead of every
// early-return — and drops it again only if the task genuinely didn't
// run. Both helpers are pure and the invariant is timing-independent,
// so it's covered here directly rather than through the flaky in-query
// fold race in integration.test.ts.

function taskRow(id: string, seriesId?: string, trigger = 1): MessageInRow {
  return {
    id,
    series_id: seriesId ?? null,
    kind: 'task',
    trigger,
    content: JSON.stringify({ prompt: 'maintenance' }),
  } as unknown as MessageInRow;
}

describe('registerTaskFireContextOnce', () => {
  it('registers a context for a new task row', () => {
    const ctxs: TaskFireContext[] = [];
    registerTaskFireContextOnce(ctxs, taskRow('t-1', 'series-A'));
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]).toMatchObject({ taskId: 't-1', seriesId: 'series-A', written: false });
  });

  it('is idempotent — multiple seeding points never double-count a fire', () => {
    const ctxs: TaskFireContext[] = [];
    const row = taskRow('t-dup', 'series-B');
    // initial-batch seed, post-markProcessing seed, pre-push re-affirm
    registerTaskFireContextOnce(ctxs, row);
    registerTaskFireContextOnce(ctxs, row);
    registerTaskFireContextOnce(ctxs, row);
    expect(ctxs).toHaveLength(1);
  });

  it('falls back series_id → id for pre-migration rows', () => {
    const ctxs: TaskFireContext[] = [];
    registerTaskFireContextOnce(ctxs, taskRow('t-old')); // series_id null
    expect(ctxs[0].seriesId).toBe('t-old');
  });

  it('keeps distinct contexts for distinct tasks in one wake', () => {
    const ctxs: TaskFireContext[] = [];
    registerTaskFireContextOnce(ctxs, taskRow('t-rss', 'rss'));
    registerTaskFireContextOnce(ctxs, taskRow('t-dream', 'dream'));
    expect(ctxs.map((c) => c.taskId).sort()).toEqual(['t-dream', 't-rss']);
  });
});

describe('dropUnrunTaskContexts', () => {
  it('drops a still-unwritten context for a task that bailed before running', () => {
    const ctxs: TaskFireContext[] = [];
    const row = taskRow('t-bailed', 'series-C');
    registerTaskFireContextOnce(ctxs, row);
    dropUnrunTaskContexts(ctxs, [row]);
    // No spurious 'silent' fire — the real fire is recorded on re-trigger.
    expect(ctxs).toHaveLength(0);
  });

  it('keeps a context the writers already flushed (real fire stays)', () => {
    const ctxs: TaskFireContext[] = [];
    const row = taskRow('t-ran', 'series-D');
    registerTaskFireContextOnce(ctxs, row);
    ctxs[0].written = true; // a writer already emitted its fire
    dropUnrunTaskContexts(ctxs, [row]);
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0].taskId).toBe('t-ran');
  });

  it('only drops the bailed rows, not co-resident contexts', () => {
    const ctxs: TaskFireContext[] = [];
    const ran = taskRow('t-ran', 'a');
    const bailed = taskRow('t-bailed', 'b');
    registerTaskFireContextOnce(ctxs, ran);
    registerTaskFireContextOnce(ctxs, bailed);
    dropUnrunTaskContexts(ctxs, [bailed]);
    expect(ctxs.map((c) => c.taskId)).toEqual(['t-ran']);
  });

  it('ignores non-task / non-trigger rows in the bail set', () => {
    const ctxs: TaskFireContext[] = [];
    const task = taskRow('t-1', 's');
    registerTaskFireContextOnce(ctxs, task);
    const chatRow = { id: 'm-chat', kind: 'chat-sdk', trigger: 1, series_id: null } as unknown as MessageInRow;
    const triggerZeroTask = taskRow('t-1', 's', 0);
    dropUnrunTaskContexts(ctxs, [chatRow, triggerZeroTask]);
    // chat row isn't a task; trigger=0 task isn't a fire-bearing trigger →
    // the real t-1 context survives.
    expect(ctxs).toHaveLength(1);
  });

  it('is a no-op when the bail set has no fire-bearing task rows', () => {
    const ctxs: TaskFireContext[] = [];
    registerTaskFireContextOnce(ctxs, taskRow('t-1', 's'));
    dropUnrunTaskContexts(ctxs, []);
    expect(ctxs).toHaveLength(1);
  });
});
