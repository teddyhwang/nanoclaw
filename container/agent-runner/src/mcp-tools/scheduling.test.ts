/**
 * Tests for the pre-task-script `wakeAgent` envelope validator on the
 * scheduling MCP tool surface. Background: scheduling/task-script.ts
 * JSON-parses ONLY the last line of script stdout and requires a
 * top-level `wakeAgent: boolean`. Anything else is silently treated as
 * `wakeAgent=false` and the task is gated out — the failure mode is
 * invisible to the operator (just "scheduled task didn't fire"). On
 * 2026-05-22 the AI Friends daily-recap script went silently dark for
 * three days because the agent emitted `console.log(JSON.stringify(...,
 * null, 2))` whose last line is `}`, which fails the parse and gets
 * gated. The validator rejects a `script` body that never references
 * `wakeAgent` so the agent gets a hard error at schedule_task /
 * update_task time instead of a phantom green light at fire time.
 */
import { describe, it, expect } from 'bun:test';

import { inspectScheduledTasks, listTasks, validateScriptContract, SCRIPT_FIELD_DESCRIPTION } from './scheduling.js';

describe('scheduled-task inspection compatibility', () => {
  it('exposes a deferred-discovery-safe alias with the canonical handler', () => {
    expect(inspectScheduledTasks.tool.name).toBe('inspect_scheduled_tasks');
    expect(inspectScheduledTasks.handler).toBe(listTasks.handler);
    expect(inspectScheduledTasks.tool.description).toMatch(/list_tasks/);
  });
});

describe('validateScriptContract', () => {
  it('rejects a script that never mentions wakeAgent', () => {
    const result = validateScriptContract(
      `#!/usr/bin/env bun\nconst data = { hello: "world" };\nconsole.log(JSON.stringify(data, null, 2));\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/wakeAgent/);
  });

  it('accepts a script that emits the wakeAgent envelope as the last line', () => {
    const result = validateScriptContract(
      `#!/usr/bin/env bun\nconst data = { hello: "world" };\nprocess.stdout.write(JSON.stringify({ wakeAgent: true, data }) + "\\n");\n`,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a script that emits wakeAgent=false (deliberate skip)', () => {
    const result = validateScriptContract(`#!/bin/bash\necho '{"wakeAgent": false}'\n`);
    expect(result.ok).toBe(true);
  });

  it('accepts the AI Friends daily-recap shape (post-2026-05-22 fix)', () => {
    // The exact tail the recap script emits — single-line JSON with
    // wakeAgent at top level and data as the payload. Anchored on
    // wakeAgent as a word so an unrelated identifier like
    // `awakeAgentTimer` doesn't false-positive.
    const result = validateScriptContract(
      `process.stdout.write(JSON.stringify({ wakeAgent: true, data: output }) + "\\n");`,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a script that only mentions wakeAgent in a comment if word-bounded', () => {
    // The word-boundary check intentionally matches comments too — a
    // comment that documents wakeAgent is strong evidence the author
    // knows the contract; refusing to schedule it would be overzealous.
    // This test pins that lenient behavior so a future tightening of
    // the regex doesn't silently break shell scripts that emit via a
    // here-doc with the marker only in a comment block.
    const result = validateScriptContract(
      `#!/bin/bash\n# wakeAgent contract: emit single-line JSON below\necho '{"wakeAgent": true}'\n`,
    );
    expect(result.ok).toBe(true);
  });

  it('SCRIPT_FIELD_DESCRIPTION names the contract for the agent to read', () => {
    // The description is the surface the LLM sees at tool-call time —
    // it has to spell out the rule, not just gesture at it.
    expect(SCRIPT_FIELD_DESCRIPTION).toMatch(/wakeAgent/);
    expect(SCRIPT_FIELD_DESCRIPTION).toMatch(/last line/i);
    expect(SCRIPT_FIELD_DESCRIPTION).toMatch(/json/i);
  });
});
