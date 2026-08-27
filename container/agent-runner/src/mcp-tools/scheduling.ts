/**
 * Scheduling MCP tools: schedule_task, list_tasks, cancel_task, pause_task, resume_task.
 *
 * With the two-DB split, the container cannot write to inbound.db (host-owned).
 * Scheduling operations are sent as system actions via messages_out — the host
 * reads them during delivery and applies the changes to inbound.db.
 */
import fs from 'fs';

import { writeMessageOut } from '../db/messages-out.js';
import { getAgentMailbox } from '../mailbox/index.js';
import { getSessionRouting } from '../db/session-routing.js';
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

/**
 * Read the requesting user's dashboard account id from the per-session
 * sender-identity file the host writes per inbound message. Returns null
 * when the file is missing/malformed or the sender is not linked to a
 * dashboard account — in those cases the task is still scheduled but
 * the host records no owner, and per-user MCP routes refuse at fire-time
 * (matches v1 security posture for synthetic/orphaned tasks).
 *
 * The container mounts the file at `/workspace/sender-identity.json` (per-
 * session) — see the host's optimus-sender-identity plugin.
 */
function readRequestingUserId(): string | null {
  try {
    const raw = fs.readFileSync('/workspace/sender-identity.json', 'utf-8');
    const parsed = JSON.parse(raw) as { user?: { id?: string } | null; account?: { id?: string } | null };
    return parsed.user?.id ?? parsed.account?.id ?? null;
  } catch {
    return null;
  }
}

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/**
 * Pre-task script contract — replicated verbatim into `schedule_task` and
 * `update_task`'s `script` field descriptions so the agent sees the rules
 * at the exact moment it's about to author or rewrite one. The container
 * runtime (scheduling/task-script.ts) JSON-parses ONLY the LAST LINE of
 * stdout and requires a top-level boolean `wakeAgent` field. Anything
 * else (raw data, multi-line pretty-printed JSON whose last line is `}`,
 * plain text, empty output) gets silently treated as `wakeAgent=false`
 * and the task is gated out. That gating is invisible to the operator —
 * the dashboard records a `task_fires` row with `status='gated'`, but
 * the symptom is just "scheduled task didn't run" (see daily-recap
 * incident 2026-05-20 → 2026-05-22). The validator below blocks the
 * obvious shape of that mistake at tool-call time.
 */
export const SCRIPT_FIELD_DESCRIPTION =
  'Optional pre-agent script (bash). Runs before the agent turn; its stdout LAST LINE must be a single-line JSON object with a boolean `wakeAgent` field — e.g. `{"wakeAgent": true, "data": {...}}`. wakeAgent=false skips the task this tick (use it for cheap polls that should idle when there is no new signal). Any other output shape (raw data, multi-line pretty JSON, plain text) is gated out silently and the agent never runs. When wakeAgent=true the optional `data` field becomes available to the prompt as `scriptOutput`.';

export interface ScriptValidationResult {
  ok: boolean;
  message: string;
}

/**
 * Lightweight syntactic check that the script references the wakeAgent
 * envelope at all. We can't statically prove a runtime-emitted JSON
 * shape — but if the script body never mentions `wakeAgent`, it almost
 * certainly forgot the contract and will be gated silently. False
 * positives are tolerable (the agent can re-author); false negatives
 * are the recurring footgun this is closing.
 */
export function validateScriptContract(script: string): ScriptValidationResult {
  if (!/\bwakeAgent\b/.test(script)) {
    return {
      ok: false,
      message:
        'script does not reference `wakeAgent` — pre-task scripts MUST emit a final stdout line of the form `{"wakeAgent": true|false, "data"?: ...}` or the task will be silently gated out. Wrap your output: `process.stdout.write(JSON.stringify({ wakeAgent: true, data: output }) + "\\n")` (or shell equivalent). Pass wakeAgent=false to skip the agent turn this tick. If you really need to send a script with no wakeAgent emission, the task harness has no way to know whether to run the agent — there is no escape hatch.',
    };
  }
  return { ok: true, message: '' };
}

export const scheduleTask: McpToolDefinition = {
  tool: {
    name: 'schedule_task',
    description: `Schedule a one-shot or recurring task. The user's timezone is declared in the <context timezone="..."/> header of your prompt — interpret the user's "9pm" etc. in that zone. Cron expressions are interpreted in the user's timezone too.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Task instructions/prompt' },
        processAfter: {
          type: 'string',
          description: `ISO 8601 timestamp for the first run. Accepts either UTC (ending in "Z" or "+00:00") or a naive local timestamp (no offset) which is interpreted in the user's timezone (e.g. "2026-01-15T21:00:00" = 9pm user-local). Prefer naive local.`,
        },
        recurrence: {
          type: 'string',
          description:
            'Cron expression for recurring tasks (e.g., "0 9 * * 1-5" = weekdays at 9am user-local). Evaluated in the user\'s timezone.',
        },
        script: {
          type: 'string',
          description: SCRIPT_FIELD_DESCRIPTION,
        },
      },
      required: ['prompt', 'processAfter'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    const processAfterIn = args.processAfter as string;
    if (!prompt || !processAfterIn) return err('prompt and processAfter are required');
    if (typeof args.script === 'string' && args.script.length > 0) {
      const v = validateScriptContract(args.script);
      if (!v.ok) return err(v.message);
    }

    let processAfter: string;
    try {
      const d = parseZonedToUtc(processAfterIn, TIMEZONE);
      if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${processAfterIn}`);
      processAfter = d.toISOString();
    } catch {
      return err(`invalid processAfter: ${processAfterIn}`);
    }

    const id = generateId();
    const r = routing();
    const recurrence = (args.recurrence as string) || null;
    const script = (args.script as string) || null;

    // Write as a system action — host will insert into inbound.db
    await writeMessageOut({
      id,
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        action: 'schedule_task',
        taskId: id,
        prompt,
        script,
        processAfter,
        recurrence,
        platformId: r.platform_id,
        channelType: r.channel_type,
        threadId: r.thread_id,
        // Pass the requesting user's dashboard account id through so a
        // host plugin can record (taskId, agentGroupId, userId) and stamp
        // the per-session sender-identity at fire-time. Null when the
        // sender is unlinked — host treats that as "no owner."
        createdByUserId: readRequestingUserId(),
      }),
    });

    log(`schedule_task: ${id} at ${processAfter}${recurrence ? ` (recurring: ${recurrence})` : ''}`);
    return ok(`Task scheduled (id: ${id}, runs at: ${processAfter}${recurrence ? `, recurrence: ${recurrence}` : ''})`);
  },
};

export const listTasks: McpToolDefinition = {
  tool: {
    name: 'list_tasks',
    description:
      'List scheduled tasks. Returns one row per series — the live (pending or paused) occurrence. The id shown is the series id, which is what update_task / cancel_task / pause_task / resume_task expect.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status: pending or paused (default: both)' },
      },
    },
  },
  async handler(args) {
    const status = args.status as string | undefined;
    // Task series live in host-only schedule.db. The host projects a read-only
    // `task_series` snapshot into this session mailbox; the driver owns how
    // that projection is queried.
    const rows = getAgentMailbox().operations.listTaskSeries(status);
    if (rows.length === 0) return ok('No tasks found.');

    const lines = rows.map((row) => {
      const content = JSON.parse(row.content) as { prompt?: unknown };
      const prompt = (typeof content.prompt === 'string' ? content.prompt : '').slice(0, 80);
      return `- ${row.id} [${row.status}] at=${row.processAfter || 'now'} ${row.recurrence ? `recur=${row.recurrence} ` : ''}→ ${prompt}`;
    });

    return ok(lines.join('\n'));
  },
};

/**
 * Claude Code's deferred ToolSearch reserves/strongly aliases `TaskList` and
 * can omit the similarly named MCP `list_tasks` from its search index even
 * though the MCP server registered it. Keep the canonical tool for existing
 * callers and expose a semantically explicit alias that survives deferred
 * discovery. Both names intentionally share one handler.
 */
export const inspectScheduledTasks: McpToolDefinition = {
  tool: {
    ...listTasks.tool,
    name: 'inspect_scheduled_tasks',
    description:
      'Inspect scheduled task series. Compatibility alias for list_tasks when a provider does not expose that name. Returns the stable series ids expected by update_task / cancel_task / pause_task / resume_task.',
  },
  handler: listTasks.handler,
};

export const cancelTask: McpToolDefinition = {
  tool: {
    name: 'cancel_task',
    description: 'Cancel a scheduled task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    // Write as a system action — host will update inbound.db
    await writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'cancel_task', taskId }),
    });

    log(`cancel_task: ${taskId}`);
    return ok(`Task cancellation requested: ${taskId}`);
  },
};

export const pauseTask: McpToolDefinition = {
  tool: {
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to pause' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    await writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'pause_task', taskId }),
    });

    log(`pause_task: ${taskId}`);
    return ok(`Task pause requested: ${taskId}`);
  },
};

export const resumeTask: McpToolDefinition = {
  tool: {
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to resume' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    await writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'resume_task', taskId }),
    });

    log(`resume_task: ${taskId}`);
    return ok(`Task resume requested: ${taskId}`);
  },
};

export const updateTask: McpToolDefinition = {
  tool: {
    name: 'update_task',
    description:
      'Update a scheduled task. Pass the series id from list_tasks. Any field omitted is left unchanged. Use this instead of cancel + reschedule when adjusting an existing task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Series id of the task to update (as shown by list_tasks)' },
        prompt: { type: 'string', description: 'New task prompt (optional)' },
        recurrence: {
          type: 'string',
          description: 'New cron expression (optional). Pass empty string to clear and make the task one-shot.',
        },
        processAfter: {
          type: 'string',
          description: `New ISO 8601 timestamp for the next run (optional). Accepts either UTC (ending in "Z" / "+00:00") or a naive local timestamp interpreted in the user's timezone.`,
        },
        script: {
          type: 'string',
          description: `New pre-agent script (optional). Pass empty string to clear. ${SCRIPT_FIELD_DESCRIPTION}`,
        },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    if (typeof args.script === 'string' && args.script.length > 0) {
      const v = validateScriptContract(args.script);
      if (!v.ok) return err(v.message);
    }

    const update: Record<string, unknown> = { taskId };
    if (typeof args.prompt === 'string') update.prompt = args.prompt;
    if (typeof args.processAfter === 'string') {
      try {
        const d = parseZonedToUtc(args.processAfter, TIMEZONE);
        if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${args.processAfter}`);
        update.processAfter = d.toISOString();
      } catch {
        return err(`invalid processAfter: ${args.processAfter}`);
      }
    }
    // Empty string clears recurrence/script; undefined leaves them as-is.
    if (typeof args.recurrence === 'string') update.recurrence = args.recurrence === '' ? null : args.recurrence;
    if (typeof args.script === 'string') update.script = args.script === '' ? null : args.script;

    if (Object.keys(update).length === 1) return err('at least one field to update is required');

    await writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'update_task', ...update }),
    });

    log(`update_task: ${taskId}`);
    return ok(`Task update requested: ${taskId}`);
  },
};

registerTools([scheduleTask, listTasks, inspectScheduledTasks, updateTask, cancelTask, pauseTask, resumeTask]);
