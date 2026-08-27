/**
 * Scheduling module — one-shot and recurring tasks.
 *
 * Registers:
 *   - Five delivery action handlers: schedule_task, cancel_task, pause_task,
 *     resume_task, update_task. The container's scheduling MCP tools
 *     (container/agent-runner/src/mcp-tools/scheduling.ts) write system
 *     messages with these actions; the host applies them to the owning agent
 *     group's host-only `schedule.db`.
 *
 * Host integration points:
 *   - `src/host-sweep.ts` calls `handleRecurrence` through the narrow mailbox
 *     materialization capability each sweep tick. A due series copies one
 *     transient occurrence into the active session mailbox.
 *   - `container/agent-runner/src/poll-loop.ts` runs `applyPreTaskScripts`
 *     before the provider call so occurrences carrying a pre-agent script can
 *     gate their own execution.
 *
 * `schedule.db` is provisioned lazily per agent group and is never mounted into
 * a container. Session mailbox task helpers are compatibility primitives, not
 * the live recurrence source of truth.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import {
  handleCancelTask,
  handlePauseTask,
  handleResumeTask,
  handleScheduleTask,
  handleUpdateTask,
} from './actions.js';

const schedulingAction = unguarded(
  'The container scheduling MCP surface performs its own sensitive-action confirmation before emitting these host actions.',
);
registerDeliveryAction('schedule_task', handleScheduleTask, schedulingAction);
registerDeliveryAction('cancel_task', handleCancelTask, schedulingAction);
registerDeliveryAction('pause_task', handlePauseTask, schedulingAction);
registerDeliveryAction('resume_task', handleResumeTask, schedulingAction);
registerDeliveryAction('update_task', handleUpdateTask, schedulingAction);
