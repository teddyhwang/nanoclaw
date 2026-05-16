import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { writeTaskFire, type TaskFireDispatch } from './db/task-fires.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  clearContinuation,
  clearContinuationStartedAt,
  getContinuationStartedAt,
  migrateLegacyContinuation,
  setContinuation,
  setContinuationStartedAt,
} from './db/session-state.js';
import { computeRotationDate, evaluateRotation } from './session-rotation.js';
import { TIMEZONE } from './timezone.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import fs from 'fs';
import {
  formatMessages,
  extractRouting,
  pickInReplyToMessage,
  extractMessageSender,
  extractImageAttachments,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type InboundImageRef,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ImageContentBlock, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
// Host-side IDLE_TIMEOUT defaults to 120s; refresh well under that so
// one slow tick still leaves multiple ticks of headroom.
const QUERY_KEEPALIVE_MS = 30_000;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Read inbound image attachments off disk and convert to Anthropic
 * vision content blocks. The host writes raw bytes to
 * `<sessDir>/inbox/<msgId>/<file>` (resized client-side via sharp when
 * over Anthropic's 5MB cap; see src/media/image-processing.ts), and the
 * session dir is mounted at `/workspace`. We base64-encode and emit the
 * blocks for the provider.
 *
 * Per-image read failure is logged + skipped so one bad attachment
 * doesn't kill the whole turn. Returns empty array when the input is
 * empty or all reads failed.
 */
function loadImageBlocks(refs: InboundImageRef[]): ImageContentBlock[] {
  const blocks: ImageContentBlock[] = [];
  for (const ref of refs) {
    try {
      const buffer = fs.readFileSync(ref.absolutePath);
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: ref.mediaType,
          data: buffer.toString('base64'),
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to read image attachment ${ref.absolutePath}: ${errMsg}`);
    }
  }
  return blocks;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Task/chat isolation: a kind='task' trigger row must NEVER share a
    // provider turn with chat rows. If the batch contains any task
    // trigger, isolate the task(s) into their own stream and defer ALL
    // chat/chat-sdk rows (left pending — they ride along the next
    // chat-triggered wake). Without this, silent-maintenance tasks
    // ("do NOT send any messages") get chat shoved into the prompt and
    // the model overrides the silence instruction to reply to what
    // looks like a live user turn. RSS-style tasks that *do* want to
    // post still post via MCP send_message — isolation only removes
    // chat-as-context from the prompt, not outbound delivery.
    //
    // Two incidents motivate the *generalized* form below:
    //  - 2026-05-11 04:01 (shit-talk): mackchiu's trigger=0 accumulate
    //    chats from May 10 20:42 dragged into the 04:02 maintenance
    //    wake; agent posted a chat reply despite the silent-task
    //    instruction. The original fix dropped only trigger=0 chat when
    //    `taskOnlyWake` (every trigger=1 row is a task).
    //  - 2026-05-16 13:22 (AI Friends dream leak): the original fix's
    //    hole. The dream task (trigger=1, kind=task) co-arrived with
    //    AI-Friends mention-sticky chat that the router had marked
    //    trigger=1. `taskOnlyWake` = triggerRows.every(kind==='task')
    //    was therefore false, isolation was skipped, the conversation
    //    folded into the silent dream turn, and the agent reply-pilled
    //    the dream-cycle summary onto "Lame…" in AI Friends. The fix:
    //    isolation triggers on *any* task trigger present, and defers
    //    chat rows regardless of their trigger flag (sticky-engage
    //    chat is still chat — it must not ride a maintenance turn).
    const triggerRows = messages.filter((m) => m.trigger === 1);
    const hasTaskTrigger = triggerRows.some((m) => m.kind === 'task');
    const isChatRow = (m: MessageInRow) => m.kind === 'chat' || m.kind === 'chat-sdk';
    let batch = messages;
    if (hasTaskTrigger) {
      const dropped = messages.filter(isChatRow);
      if (dropped.length > 0) {
        const stickyDeferred = dropped.filter((m) => m.trigger === 1).length;
        log(
          `Task trigger present: isolating task turn, deferring ${dropped.length} chat row(s) ` +
            `(${stickyDeferred} trigger=1 sticky-engage) — left pending for next chat wake`,
        );
        batch = messages.filter((m) => !isChatRow(m));
      }
    }

    const ids = batch.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(batch);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of batch) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        clearContinuationStartedAt(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${batch.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
      // Record a 'gated' fire per skipped task. The task fired on
      // schedule and its script ran — it just decided not to wake the
      // agent. Without this row the dashboard shows "never ran" for a
      // healthy quiet task (RSS pollers, dream/maintenance checks that
      // usually no-op). One row per occurrence; series_id groups them.
      for (const g of preTask.gated) {
        try {
          writeTaskFire({
            id: generateId(),
            seriesId: g.seriesId,
            taskId: g.taskId,
            status: 'gated',
            assistantText: null,
            dispatched: [],
            errorMessage: g.reason === 'script error/no output' ? g.reason : null,
          });
        } catch (err) {
          log(`task_fires gated-write failed for ${g.taskId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Re-check the accumulate gate after script filtering. The gate at the
    // top of the loop lets the batch through if ANY message has trigger=1,
    // but a recurring task with wakeAgent=false (e.g. dream/maintenance
    // scripts that decide nothing's worth waking for) is the only trigger=1
    // row in the batch and gets stripped here. Without this re-check, the
    // trigger=0 accumulate rows that rode along get processed as prompts —
    // exactly the v1 requires_trigger gap operators reported (2026-05-09
    // AI Friends "close.. just gotta suppress those embeds" echo).
    if (!keep.some((m) => m.trigger === 1)) {
      log(
        `Skipping ${keep.length} accumulate-only message(s) after script filter — leaving pending until next trigger`,
      );
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    // Capture the active turn's trigger sender. Follow-up messages from a
    // different sender are deferred (left pending) instead of pushed into
    // this query — pushing folds both senders' requests into one combined
    // reply (boysnight 2026-04-27, ported from v1 apps/nanoclaw/src/index.ts).
    const triggerRow = keep.find((m) => m.trigger === 1) ?? keep[0];
    const activeSender = extractMessageSender(triggerRow);

    // Task-fire tracking: if a task row triggered this stream, capture its
    // series_id + id so processQuery can write a task_fires row when the
    // stream ends. `series_id` falls back to `id` for pre-migration rows
    // (matches the host-side backfill in src/db/session-db.ts:349). Only
    // the kind='task' branch participates — chat-triggered wakes don't
    // produce fire rows.
    // Shared, mutable list seeded with the initial-batch task rows; the
    // follow-up poll closure appends a context per follow-up task that
    // survives its pre-task script. One context per due task occurrence so
    // each gets exactly one fire row even when several fold into one
    // provider stream (multiple recurring tasks coming due in the same
    // wake, or follow-ups arriving mid-turn). `series_id` falls back to
    // `id` for pre-migration rows (matches host-side backfill in
    // src/db/session-db.ts:349). Chat-triggered wakes produce no context.
    const taskFireContexts: TaskFireContext[] = [];
    for (const m of keep) {
      if (m.trigger !== 1 || m.kind !== 'task') continue;
      registerTaskFireContextOnce(taskFireContexts, m);
    }

    // Load any inbound image attachments as Anthropic vision content blocks.
    // The host wrote bytes to <sessDir>/inbox/<msgId>/<file> (sized to fit
    // the 5MB API cap by chat-sdk-bridge before insert), and the session dir
    // mounts at /workspace, so absolutePath is `/workspace/inbox/...`.
    // Empty array on no images / all reads failed — provider sends text-only.
    const imageRefs = extractImageAttachments(keep);
    const imageBlocks = loadImageBlocks(imageRefs);
    if (imageBlocks.length > 0) {
      log(`Loaded ${imageBlocks.length} image attachment(s) for multimodal turn`);
    }

    // Lazy session rotation — fires BEFORE provider.query() so the current
    // turn always runs on a coherent thread (rotating mid-flight would
    // destroy the in-memory `resume` id while the SDK is still using it).
    //
    // Rationale: the host-side 04:00 dream task already calls the
    // `rotate_session` MCP tool for the common "session has gotten too old"
    // case. This hook adds the v1 drift-trigger axes that 04:00 alone can't
    // cover — a single very chatty day that compacts multiple times before
    // the next dream pass arrives. The original ai-friends 2026-04-16
    // incident (4 days / 2+ compacts / 7.6 MB) is the canonical shape.
    //
    // The provider owns the stats reader (see AgentProvider.readSessionStats);
    // a provider that returns EMPTY_STATS effectively degrades to "rotate
    // only at the 04:00 day boundary," which is the v2-only baseline.
    if (continuation) {
      const stats = config.provider.readSessionStats(continuation);
      const startedAt = getContinuationStartedAt(config.providerName);
      const decision = evaluateRotation(new Date(), TIMEZONE, startedAt, stats);
      if (decision.reason !== 'no-session' && decision.reason !== 'same-day') {
        log(
          `Rotation evaluator: reason=${decision.reason} ` +
            `rotate=${decision.rotate} compactCount=${stats.compactCount} ` +
            `sizeBytes=${stats.sizeBytes} tokensUsed=${stats.tokensUsed ?? 'n/a'} ` +
            `startedAt=${startedAt ?? 'unstamped'}`,
        );
      }
      if (decision.rotate) {
        log(`Rotating session before query: ${decision.reason} ` + `(previous continuation: ${continuation})`);
        clearContinuation(config.providerName);
        clearContinuationStartedAt(config.providerName);
        continuation = undefined;
      }
    }

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
      imageBlocks: imageBlocks.length > 0 ? imageBlocks : undefined,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        activeSender,
        taskFireContexts,
      );
      if (result.continuation && result.continuation !== continuation) {
        const isNewThread = continuation === undefined;
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
        // Stamp the rotation-day this continuation started on. Only on a
        // newly-adopted thread — resuming an existing one keeps the
        // original stamp so the day-boundary check measures from when the
        // thread truly began, not when this container happened to attach.
        if (isNewThread) {
          setContinuationStartedAt(config.providerName, computeRotationDate(new Date(), TIMEZONE));
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
        clearContinuationStartedAt(config.providerName);
      }

      if (shouldSendErrorResponseForBatch(keep)) {
        // Write error response so the user knows something went wrong.
        // Task-only failures stay in logs: scheduled maintenance prompts are
        // often explicitly silent and should not leak raw runtime errors to chat.
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: `Error: ${errMsg}` }),
        });
      } else {
        log(`Suppressing user-visible error for task-only batch: ${errMsg}`);
      }

      // Task-fire error record. Captures the error message so the
      // dashboard can show "this fire failed and why" instead of leaving
      // the fire row missing entirely (which would look like the task
      // simply didn't run). One row per still-unwritten due task; mark
      // each written so processQuery's finally can't also write a
      // completed/silent row for it (the single-fire invariant).
      for (const ctx of taskFireContexts) {
        if (ctx.written) continue;
        try {
          writeTaskFire({
            id: generateId(),
            seriesId: ctx.seriesId,
            taskId: ctx.taskId,
            status: 'error',
            assistantText: null,
            dispatched: [],
            errorMessage: errMsg,
          });
          ctx.written = true;
        } catch (writeErr) {
          log(`task_fires error-write failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
        }
      }
    } finally {
      clearCurrentInReplyTo();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

export function shouldSendErrorResponseForBatch(messages: MessageInRow[]): boolean {
  return !messages.every((m) => m.kind === 'task');
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

/**
 * Per-stream task-fire tracking. Set when the initial batch that opened
 * this query stream included a `kind='task'` trigger row — we record one
 * task_fires row at stream end (or on error) capturing what the agent
 * produced. Follow-up pushes within the same stream are user-driven and
 * don't count as new fires (a new task fire would arrive on a fresh
 * wake via host-sweep). seriesId is the stable per-task identity;
 * taskId is the concrete messages_in.id that fired.
 */
export interface TaskFireContext {
  seriesId: string;
  taskId: string;
  // Per-task accumulators. One stream can fold MULTIPLE task triggers
  // (the initial batch task + any follow-up task rows that came due while
  // the container was already running — RSS + dream + reflection in one
  // container lifetime). Each due task occurrence gets exactly ONE fire
  // row keyed by its own (seriesId, taskId); these accumulate the
  // dispatch/text attributed to it. `written` is the write-once guard
  // shared between the error path (outer catch) and the normal-completion
  // path (finally) so a task can never produce two rows.
  dispatched: TaskFireDispatch[];
  assistantText: string | null;
  written: boolean;
}

/**
 * Register a task-fire context for `m` unless one already exists for the
 * same concrete row (`taskId`). Idempotent so the multiple seeding
 * points — initial batch, the post-markProcessing follow-up pass (which
 * runs ahead of every early-return for Issue A), and the pre-push
 * re-affirmation — can all call it without ever double-counting a fire.
 * `series_id` falls back to `id` for pre-migration rows (matches the
 * host-side backfill in src/db/session-db.ts:349).
 */
// Exported for unit tests — the Issue-A seed/drop invariant (idempotent
// registration, drop-only-unwritten) is timing-independent and worth
// covering directly rather than through the flaky in-query fold race.
export function registerTaskFireContextOnce(contexts: TaskFireContext[], m: MessageInRow): void {
  if (contexts.some((c) => c.taskId === m.id)) return;
  contexts.push({
    seriesId: m.series_id ?? m.id,
    taskId: m.id,
    dispatched: [],
    assistantText: null,
    written: false,
  });
}

/**
 * Remove fire contexts for `rows` that were seeded ahead of a bail
 * (accumulate-only follow-up, or stream-already-done) and therefore did
 * NOT run this turn. Only drops still-unwritten contexts — a context the
 * writers already flushed stays (its fire is real). Without this, the
 * Issue-A seeding (which deliberately registers before every early
 * return) would make processQuery's finally emit a 'silent' fire for a
 * task that never actually executed; the genuine fire is recorded when
 * the released row is re-triggered and runs in its own isolated turn.
 */
export function dropUnrunTaskContexts(contexts: TaskFireContext[], rows: MessageInRow[]): void {
  const ids = new Set(rows.filter((m) => m.kind === 'task' && m.trigger === 1).map((m) => m.id));
  if (ids.size === 0) return;
  for (let i = contexts.length - 1; i >= 0; i--) {
    if (!contexts[i].written && ids.has(contexts[i].taskId)) contexts.splice(i, 1);
  }
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  activeSender: string | null,
  // Shared by reference with the follow-up poll closure so a follow-up
  // task that survives its pre-task script can register its own fire
  // context (see the scheduling-pre-task-followup hook). Pre-bug this was
  // a single nullable context captured once from the initial batch, so
  // every follow-up task fire (the dream/maintenance common case, since
  // those agents are usually already-active) was silently never recorded.
  taskFireContexts: TaskFireContext[],
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  // Attribution: result events fold into one provider stream and the SDK
  // does not tag which pushed prompt produced a given <message> block, so
  // per-task dispatch provenance across a task↔chat or task↔task boundary
  // is best-effort. We attribute each result's text/dispatch to the most
  // recently registered, still-unwritten task context (the initial task
  // until a follow-up task is appended; thereafter the latest follow-up).
  // The ROW COUNT and KEYS are always exact (one row per due task, keyed
  // by its own series_id/id); only the dispatched/assistantText payload is
  // approximate when chat and task turns interleave in a single long
  // stream. For the canonical silent maintenance/dream task this is exact:
  // it dispatches nothing → status='silent'. Errors set `streamErrored`
  // so the finally skips the normal-completion write; the outer catch in
  // startMessageLoop writes one error fire per unwritten context instead.
  const mostRecentTaskContext = (): TaskFireContext | null => {
    for (let i = taskFireContexts.length - 1; i >= 0; i--) {
      if (!taskFireContexts[i].written) return taskFireContexts[i];
    }
    return null;
  };
  let streamErrored = false;

  // Write a fire row for every still-unwritten task context. Called at
  // the `result` event (eager — a result means the turn is done) AND in
  // the finally (backstop for contexts that never produced a result,
  // e.g. stream torn down before result). The `written` guard makes the
  // second call a no-op for anything the first already flushed, so a
  // task can never produce two rows.
  //
  // Why eager-at-result, not finally-only (2026-05-16, telegram_dm_teddy
  // 23folg): the finally only runs when the `for await` stream closes.
  // On a warm agent-shared container the query is held open for the
  // follow-up window and the container does not idle-kill for many
  // minutes (browser pre-warm + 10 MCP servers keep it resident), so a
  // silent dream task that finished its turn at T had its fire stuck
  // unwritten until the stream finally closed — the dashboard showed
  // "never ran" for a task that completed. The `result` event is the
  // authoritative "this turn finished" signal; flush there.
  const flushUnwrittenTaskFires = (): void => {
    if (streamErrored) return; // error path writes its own 'error' fires
    for (const ctx of taskFireContexts) {
      if (ctx.written) continue;
      try {
        writeTaskFire({
          id: generateId(),
          seriesId: ctx.seriesId,
          taskId: ctx.taskId,
          status: ctx.dispatched.length > 0 ? 'completed' : 'silent',
          assistantText: ctx.assistantText,
          dispatched: ctx.dispatched,
        });
        ctx.written = true;
      } catch (err) {
        log(`task_fires write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  // Keepalive: while the query stream is open, refresh heartbeat at a
  // cadence well under IDLE_TIMEOUT (default 120s). The for-await loop
  // below bumps heartbeat on every SDK event, and Pre/PostToolUse hooks
  // bump on every tool boundary, but neither fires during LLM-only
  // intervals — a long text generation after the last tool call, or
  // SDK ramp-up between query.push() and the first new event, can
  // exceed IDLE_TIMEOUT and trip the host's `stop-idle` kill mid-
  // thought. The query being open is itself proof of liveness; the
  // host already detects truly-dead containers via the absolute ceiling
  // and claim-stuck paths, so a keepalive here only suppresses
  // false-positive idle kills, not real wedges.
  const keepaliveHandle = setInterval(() => {
    if (done) return;
    touchHeartbeat();
  }, QUERY_KEEPALIVE_MS);
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. End the stream and leave the rows
        // pending; the outer loop handles them on next iteration via the
        // canonical command path + formatMessagesWithCommands.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        let newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        // Accumulate gate (mirror of the cold-start gate above): if the
        // follow-up batch contains only trigger=0 rows, do NOT push them
        // into the active query. They're context-only (router stored them
        // under ignored_message_policy='accumulate' because the engagement
        // gate didn't fire) and pushing them as prompts makes the agent
        // respond to messages that were never addressed to it. Leave them
        // pending; the next trigger=1 message picks them up as context.
        // Without this gate, a warm container that's mid-turn responds to
        // every accumulate message in the channel — exactly the v1
        // requires_trigger gap operators reported (2026-05-09 AI Friends
        // "F" echo).
        if (!newMessages.some((m) => m.trigger === 1)) {
          // Don't markCompleted these — they need to ride along with the
          // next real trigger so the agent sees them as context.
          //
          // End the active query so the outer loop can unwind. Without
          // this, the SDK turn stays open indefinitely and this poll
          // interval keeps firing every 500ms forever — observed
          // 2026-05-12 ai_friends container in a 500ms hot loop
          // logging "Skipping 7 accumulate-only follow-up(s)" after
          // the agent had already returned a result; ambient Discord
          // chatter kept arriving as trigger=0 rows but no trigger=1
          // wake came. Stream lifecycle does NOT affect Anthropic
          // prompt-cache lifetime (5-min server-side TTL keyed on
          // prefix hash, see comment ~L376), so close+reopen within
          // 5 min still gets cache hits. Same shape as the
          // cross-sender stream-end below; accumulate-only is the
          // other "nothing to do here, let the outer loop sleep
          // cleanly" condition.
          log(`Ending active query — ${newMessages.length} accumulate-only follow-up(s) pending, no trigger=1 work`);
          if (!endedForCommand) {
            endedForCommand = true;
            query.end();
          }
          return;
        }

        // Cross-sender deferral: in a shared-session group chat, a trigger from
        // a different sender than the one currently being answered must NOT
        // get pushed into the active query — the SDK folds both into one
        // combined reply. Leave those rows pending; the outer loop re-queries
        // them after the current turn ends, where they get their own respond_to
        // marker and native platform reply-threading.
        //
        // **End the active query when ALL pending messages are cross-sender.**
        // The query intentionally stays open across same-sender follow-ups to
        // avoid re-spawning the SDK every turn. But when the only thing
        // pending is from a different sender, the query has nothing to do —
        // it just keeps deferring on every poll iteration. Without ending,
        // the outer loop never gets to start a fresh query for the deferred
        // sender, and the host's absolute-ceiling watchdog eventually kills
        // the container after ~30 min. Symptom: pending escalation/task rows
        // sit untouched while the log spams `Deferring N cross-sender
        // follow-up(s)` every 500ms (boysnight 2026-05-09: Adrian's
        // re-escalation request + a maintenance task pending 30 min before
        // container kill). Ending the stream lets the outer for-await unwind,
        // the outer loop re-queries fresh, and `activeSender` gets bound to
        // the deferred sender so the right respond_to lands.
        // Track whether either deferral fired this tick — used below to
        // decide whether to end the active stream when nothing pushable
        // remains. Without this, a batch containing BOTH cross-sender
        // rows AND a maintenance task row spins forever: cross-sender
        // branch leaves the task in `sameSender` (so length!=0, no
        // stream-end), task-wake branch strips the task and returns
        // silently (no stream-end either), outer loop never gets to
        // re-query for the deferred sender, host's 30-min absolute
        // ceiling eventually SIGKILLs. Observed 2026-05-13 in
        // discord_ai_friends from 16:35 onward.
        let crossSenderDeferred = false;
        if (activeSender) {
          const sameSender: typeof newMessages = [];
          const deferred: string[] = [];
          for (const m of newMessages) {
            const s = extractMessageSender(m);
            if (s && s !== activeSender) {
              deferred.push(m.id);
            } else {
              sameSender.push(m);
            }
          }
          if (deferred.length > 0) {
            log(`Deferring ${deferred.length} cross-sender follow-up(s) — will re-process after active turn`);
            crossSenderDeferred = true;
          }
          newMessages = sameSender;
          if (newMessages.length === 0) {
            if (deferred.length > 0 && !endedForCommand) {
              log(
                `All pending messages are cross-sender — ending active query so outer loop can re-query for deferred sender`,
              );
              endedForCommand = true;
              query.end();
            }
            return;
          }
        }

        // Task-wake deferral: maintenance task rows (kind='task',
        // typically reflection/dream/recurring) that arrive mid-user-turn
        // must NOT be pushed into the active query. The SDK folds the
        // task prompt onto the live conversation, which produces a
        // second result event with a near-duplicate <message> block —
        // the user sees the same reply twice ~3 sec apart (observed
        // 2026-05-12 Tico+Janathan WA group: reflection fired at 13:17:44
        // between two outbound rows for Janice's "lol but how do I
        // listen", agent re-replied with the same Suno suggestion).
        // The "DO NOT MESSAGE THE USER" prompt instruction is backstop,
        // not gate — the model can rationalize a second reply when the
        // immediately-prior user turn is still vivid in context. Leave
        // task rows pending; the outer loop picks them up on the next
        // iteration where they get their own respond_to context and a
        // task-only batch (chat row is already markCompleted, so won't
        // ride along). Same shape as the cross-sender deferral above.
        if (activeSender) {
          const userOnly: typeof newMessages = [];
          const taskDeferred: string[] = [];
          for (const m of newMessages) {
            if (m.kind === 'task' && m.trigger === 1) {
              taskDeferred.push(m.id);
            } else {
              userOnly.push(m);
            }
          }
          if (taskDeferred.length > 0) {
            log(`Deferring ${taskDeferred.length} maintenance task wake(s) — will re-process after active user turn`);
          }
          newMessages = userOnly;
          if (newMessages.length === 0) {
            // Nothing pushable remains — end the active stream regardless of
            // whether cross-sender deferred too. The earlier rationale here
            // ("if only task rows deferred, leave open so Result: can land")
            // assumed the active turn was still mid-response. That's a wrong
            // proxy: when the model has finished its turn the SDK simply
            // stops emitting events — there is no "still typing" signal we
            // can read from in here. Leaving the stream open in that case
            // produces an infinite spin: every poll tick re-defers the same
            // task row, host-sweep sees `dueCount > 0` so the idle-timeout
            // never fires, and the container stays up forever (observed
            // 2026-05-14 in discord_degenerates: agent finished a 4-message
            // burst at 23:09, then RSS + reflection task rows arrived and
            // were deferred every 500ms for 20+ min).
            //
            // `query.end()` only signals "no more inputs from us" — pending
            // SDK output events still drain through the for-await loop, so
            // an in-flight Result: lands cleanly. Same shape as the
            // accumulate-only end above, which has been proven not to
            // truncate output. Outer loop picks up the deferred task on
            // the next iteration.
            if (!endedForCommand) {
              const reason = crossSenderDeferred ? `re-query for deferred sender` : `re-query for deferred task`;
              log(`Remaining pending are only deferred — ending active query so outer loop can ${reason}`);
              endedForCommand = true;
              query.end();
            }
            return;
          }
        }

        // Task-turn chat deferral — the symmetric counterpart of the
        // task-wake deferral above, and the follow-up-path half of the
        // Bug D fix (the initial-batch half is the hasTaskTrigger
        // isolation up top). When the ACTIVE turn is a task-only turn
        // (activeSender null — tasks carry no chat sender — and a task
        // context was seeded), chat/chat-sdk rows that arrive mid-turn
        // must NOT be pushed into the task's stream: folding live chat
        // into a silent maintenance turn is exactly the 2026-05-16
        // AI-Friends dream-summary leak. Bug 6's end-stream-at-result
        // shrinks this window to a single LLM generation, but the
        // follow-up poll runs concurrently during that generation, so
        // chat can still arrive before the result event — this closes
        // it. Leave the chat rows pending; the outer loop gives them
        // their own chat-triggered turn. Non-chat follow-ups (another
        // due task) still flow through.
        if (!activeSender && taskFireContexts.length > 0) {
          const chatDeferred = newMessages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
          if (chatDeferred.length > 0) {
            log(
              `Task-only turn active — deferring ${chatDeferred.length} chat follow-up(s); left pending for next chat wake`,
            );
            newMessages = newMessages.filter((m) => !(m.kind === 'chat' || m.kind === 'chat-sdk'));
            if (newMessages.length === 0) {
              if (!endedForCommand) {
                log('Only chat follow-ups during a task turn — ending stream so outer loop re-queries them');
                endedForCommand = true;
                query.end();
              }
              return;
            }
          }
        }

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Register fire contexts for follow-up task triggers BEFORE the
        // pre-task-script await and BEFORE any early-return below.
        //
        // Issue A (telegram_dm_teddy 23folg, 2026-05-16): a busy
        // agent-shared session had 6 completed dream-task rows and ZERO
        // task_fires rows. Cause: a follow-up task is markProcessing'd
        // here, then the pre-task `await import()` yields; the active
        // outer query can finish during that await, so `if (done)
        // return;` (and the accumulate-only return) bail *before* the
        // original seeding loop further down. The row is left
        // 'processing' with no fire context, gets swept to 'completed'
        // host-side, and no fire is ever written — the dashboard shows
        // "never ran" for a task that ran every day. Seeding here, ahead
        // of every bail, guarantees the finally/error writers in
        // processQuery flush a (silent|completed|error) fire for it.
        // The later seeding loop is now idempotent (registerTaskFire-
        // ContextOnce) so a task that DOES survive to the push isn't
        // double-counted.
        for (const m of newMessages) {
          if (m.kind !== 'task' || m.trigger !== 1) continue;
          registerTaskFireContextOnce(taskFireContexts, m);
        }

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
          // Record a 'gated' fire per skipped follow-up task — the exact
          // mirror of the initial-batch gated-write at the
          // scheduling-pre-task hook above. Without this, a script-gated
          // task that arrives while the container is already running
          // (the dream/maintenance common case, since those agents are
          // usually mid-turn when the 04:00 occurrence comes due) shows
          // "never ran" on the dashboard despite firing on schedule.
          for (const g of preTask.gated) {
            try {
              writeTaskFire({
                id: generateId(),
                seriesId: g.seriesId,
                taskId: g.taskId,
                status: 'gated',
                assistantText: null,
                dispatched: [],
                errorMessage: g.reason === 'script error/no output' ? g.reason : null,
              });
            } catch (err) {
              log(`task_fires gated-write failed for ${g.taskId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;

        // Re-check the accumulate gate after script filtering. The gate
        // above lets the batch through if ANY message has trigger=1, but
        // a recurring task with wakeAgent=false (e.g. dream/maintenance
        // scripts that decide nothing's worth waking for) is the only
        // trigger=1 row in the batch and gets stripped here. Without this
        // re-check, the trigger=0 accumulate rows that rode along get
        // pushed to the agent as if they were prompts — defeating the
        // requires_trigger contract.
        if (!keep.some((m) => m.trigger === 1)) {
          log(
            `Skipping ${keep.length} accumulate-only follow-up(s) after script filter — leaving pending until next trigger`,
          );
          // These tasks did NOT run this turn — drop the contexts seeded
          // right after markProcessing so processQuery's finally can't
          // write a spurious 'silent' fire for a task that never ran.
          // The real fire is recorded when the task is re-triggered and
          // runs in its own (now Bug-D-isolated) turn.
          dropUnrunTaskContexts(taskFireContexts, newMessages);
          return;
        }
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim
        // sweep and re-triggered, where they record their fire properly.
        if (done) {
          dropUnrunTaskContexts(taskFireContexts, newMessages);
          return;
        }

        // Re-affirm fire contexts for the follow-up tasks that survived
        // the pre-task script and are about to be pushed. Idempotent:
        // the seeding right after markProcessing(newIds) above already
        // registered these; this is a no-op for them and only matters
        // if `keep` somehow gained a task row the earlier pass missed.
        // The finally/error writers iterate every registered context.
        for (const m of keep) {
          if (m.kind !== 'task' || m.trigger !== 1) continue;
          registerTaskFireContextOnce(taskFireContexts, m);
        }

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        // Load inbound image attachments for the follow-up batch too —
        // operator can drop a screenshot mid-turn and the agent should see
        // it without waiting for a fresh query. Same /workspace/inbox/ path
        // shape as the initial turn.
        const followupImageRefs = extractImageAttachments(keep);
        const followupImageBlocks = loadImageBlocks(followupImageRefs);
        if (followupImageBlocks.length > 0) {
          log(
            `Pushing ${keep.length} follow-up message(s) with ${followupImageBlocks.length} image(s) into active query`,
          );
        } else {
          log(`Pushing ${keep.length} follow-up message(s) into active query`);
        }
        // Reset the unwrapped-output nudge gate so the next turn's
        // formatter check fires fresh (upstream v2.0.58 fix(poll-loop):
        // nudge agent when output lacks message wrapping).
        unwrappedNudged = false;
        // Bump heartbeat before pushing. The push hands work to the SDK,
        // but the SDK ramp-up (LLM API call, first tool call) can exceed
        // IDLE_TIMEOUT (120s) — host-sweep would then read a stale
        // heartbeat (last bumped at the previous PostToolUse) with
        // current_tool empty and dueCount=0 (we're about to markCompleted),
        // and fire `stop-idle` mid-stream. Signal "we just gave the agent
        // more work" so the idle clock restarts from now.
        touchHeartbeat();
        query.push(prompt, followupImageBlocks.length > 0 ? followupImageBlocks : undefined);
        markCompleted(keptIds);
        // Refresh routing.inReplyTo so subsequent outbound rows reply to the
        // most recent triggering message, not the one captured when this
        // processQuery turn started. Without this, all outbound writes in a
        // long-lived turn (subsequent dispatchResultText calls or single-
        // destination shortcut writes) point at the original first inbound,
        // rendering Discord's reply pill against the oldest message in the
        // chain rather than the last @mention/reply that the agent is
        // actually responding to.
        //
        // Pick the newest *triggering* row, not just the newest row. A
        // non-trigger drive-by ("Sorta", emoji, ack) that arrives between
        // an @mention and the agent's reply would otherwise capture the
        // pill. See pickInReplyToMessage for the contract; the accumulate
        // gate above guarantees `keep` has at least one trigger=1 row.
        const target = pickInReplyToMessage(keep);
        if (target?.id) {
          routing.inReplyTo = target.id;
        }
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    try {
      // Inner try only exists to flip streamErrored before re-throwing —
      // the outer try/finally still owns interval cleanup + task-fire
      // write. Without this flag we'd write a 'silent'/'completed' row
      // in the finally below AND an 'error' row in the outer caller's
      // catch, double-counting the fire.
      for await (const event of query.events) {
        handleEvent(event, routing);
        touchHeartbeat();

        if (event.type === 'init') {
          queryContinuation = event.continuation;
          // Persist immediately so a mid-turn container crash still lets the
          // next wake resume the conversation. Without this, the session id
          // was only written after the full stream completed — if the
          // container died between `init` and `result`, the SDK session was
          // effectively orphaned and the next message started a blank
          // Claude session with no prior context.
          setContinuation(providerName, event.continuation);
        } else if (event.type === 'result') {
          // A result — with or without text — means the turn is done. Mark
          // the initial batch completed now so the host sweep doesn't see
          // stale 'processing' claims while the query stays open for
          // follow-up pushes. The agent may have responded via MCP
          // (send_message) mid-turn, or the message may not need a response
          // at all — either way the turn is finished.
          markCompleted(initialBatchIds);
          if (event.text) {
            // Attribute this result to the most-recent unwritten task
            // context (best-effort — see processQuery's attribution note).
            const fireCtx = mostRecentTaskContext();
            if (fireCtx) fireCtx.assistantText = event.text;
            const { hasUnwrapped, dispatched } = dispatchResultText(event.text, routing);
            if (fireCtx && dispatched.length > 0) {
              fireCtx.dispatched.push(...dispatched);
            }
            if (hasUnwrapped && !unwrappedNudged) {
              unwrappedNudged = true;
              const destinations = getAllDestinations();
              const names = destinations.map((d) => d.name).join(', ');
              query.push(
                `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                  `Your destinations: ${names}. ` +
                  `Please re-send your response with the correct wrapping.</system>`,
              );
            }
          }
          // Eager flush: a `result` means the turn finished. Write the
          // fire(s) now instead of waiting for the stream to close —
          // a warm agent-shared container holds the query open for many
          // minutes, so finally-only left silent task fires unwritten
          // (telegram_dm_teddy 23folg, 2026-05-16: 0 fires after a
          // 7-min watch; the container never idle-killed). Runs after
          // attribution/dispatch above so status + assistantText +
          // dispatched are populated. Unconditional (outside the
          // `if (event.text)` block) so a silent / `<internal>`-only
          // turn — the canonical dream/maintenance shape, empty
          // event.text — also records its 'silent' fire. The finally
          // remains as a backstop for contexts that never see a result.
          flushUnwrittenTaskFires();

          // Bug 6 (telegram_dm_teddy 23folg, 2026-05-16): end the stream
          // after a task-only turn's result. `activeSender` is null when
          // the trigger was a task row (tasks have no chat sender — the
          // same signal the task-wake-deferral keys off below), and
          // taskFireContexts is non-empty iff ≥1 task trigger drove this
          // turn. A scheduled task has no human follow-up sender to wait
          // for, so holding the query open serves nothing — it only
          // keeps the keepalive (poll-loop.ts:675) bumping the heartbeat
          // every 30s, which permanently suppresses the host's
          // `stop-idle` kill (heartbeatAge never exceeds the 120s
          // idleTimeout). The container then lingers until orphan-reap
          // or a host restart (~30 min observed) instead of idle-killing
          // in ~2 min. `query.end()` only signals "no more inputs from
          // us" — pending SDK output still drains through this for-await
          // so nothing is truncated; the outer loop re-queries cleanly
          // if another task came due meanwhile. Identical shape to the
          // accumulate-only / cross-sender stream-ends below. A chat
          // turn (activeSender set) is left open as before so a human
          // can follow up without re-spawning the SDK.
          if (!activeSender && taskFireContexts.length > 0 && !endedForCommand) {
            log('Task-only turn complete — ending stream so the container can idle-kill');
            endedForCommand = true;
            query.end();
          }
        }
      }
    } catch (err) {
      streamErrored = true;
      throw err;
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
    clearInterval(keepaliveHandle);
    // Backstop: flush any task context that never saw a `result` event
    // (stream torn down before result, etc.). The eager flush at the
    // `result` event already wrote the common case; `written` makes this
    // a no-op for those. Status reflects whether that task's attributed
    // output dispatched anything ('completed') or finished silent
    // ('silent' — the maintenance/dream task that intentionally didn't
    // post). Error fires are written by the outer caller
    // (startMessageLoop's catch) so flushUnwrittenTaskFires self-skips
    // when streamErrored; `written` is the per-context guard so the
    // result-event flush, this backstop, and the error path can never
    // double-write one task.
    flushUnwrittenTaskFires();
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
// Exported for tests. Local-fork patch: the safety-net branch needs
// focused coverage so the silent-drop class of bug stays caught.
// Returns { sent, hasUnwrapped, dispatched } so callers can also kick off the
// upstream nudge re-prompt — safety-net delivery is belt-and-suspenders
// against silent drops, the nudge teaches the agent to wrap correctly
// next turn. `dispatched` is the list of { destination, body } pairs
// actually sent (post-dedup, post-safety-net) so the poll-loop's
// task_fires writer can record what the agent emitted on a task fire.
export interface DispatchedMessage {
  destination: string;
  body: string;
}
export function dispatchResultText(
  text: string,
  routing: RoutingContext,
): { sent: number; hasUnwrapped: boolean; dispatched: DispatchedMessage[] } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];
  const dispatched: DispatchedMessage[] = [];
  // Per-turn dedup: model occasionally emits two near-identical
  // <message to="X">…</message> blocks in a single result (observed
  // 2026-05-12 in the Tico+Janathan WA group — second block differed
  // only by a single trailing whitespace before \n). Without this guard
  // both blocks dispatch and the user sees the same reply twice. Key by
  // destination + whitespace-normalized body so the common LLM
  // redundant-block pattern is caught while still allowing intentional
  // repeats that differ in substance.
  const seen = new Set<string>();

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    const dedupKey = `${toName} ${body.replace(/\s+/g, ' ')}`;
    if (seen.has(dedupKey)) {
      log(`Suppressing duplicate <message to="${toName}"> block within one turn`);
      continue;
    }
    seen.add(dedupKey);
    sendToDestination(dest, body, routing);
    dispatched.push({ destination: toName, body });
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join('')).trim();

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  // Safety-net only fires when there's user-facing content the runner
  // would otherwise silently drop. `<internal>...</internal>` is the
  // agent's private-thoughts tag — content inside it is *meant* to stay
  // private (e.g. "Nothing new to save" from a maintenance reflection).
  // Use the post-strip scratchpad as the trigger so internal-only output
  // doesn't get force-emitted with a degraded label.
  const hasUnwrapped = sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — emitting via safety-net to origin channel`);
    deliverSafetyNet(scratchpad, routing);
    // Caller may also push an upstream-style nudge re-prompt via the
    // hasUnwrapped return value; the safety-net delivery is the "user
    // gets something now" half, the nudge is the "agent learns to wrap
    // next turn" half. Don't emit silent_turn_complete here — the
    // safety-net just wrote a user-facing message.
    // Surface the safety-net delivery in `dispatched` so task_fires
    // records that *something* was sent (status='completed'), with a
    // synthetic destination name marking the degraded path.
    dispatched.push({ destination: '__safety_net__', body: scratchpad });
    return { sent, hasUnwrapped, dispatched };
  }

  // Truly silent turn: no <message> blocks AND no user-facing scratchpad
  // (e.g. agent emitted only `<internal>...</internal>`, or returned an
  // empty result). Tell the host the turn is over so it can stop the
  // typing indicator immediately, instead of letting it refresh on
  // heartbeat freshness for the full HEARTBEAT_FRESH_MS window after the
  // container goes idle. The host's typing module registers the
  // matching `silent_turn_complete` delivery-action handler.
  if (sent === 0) {
    emitSilentTurnComplete();
  }
  return { sent, hasUnwrapped, dispatched };
}

/**
 * Last-resort delivery when the agent emitted result text but never wrapped
 * any of it in `<message to="...">`. Without this we silently drop the turn
 * and the user sees nothing — same shape as the silent-fallback regression
 * incident 2026-05-10 in `#boysnight`. Mirrors the v2 runner's
 * `assistant-fallback`: send the bare text to the originating channel with
 * a label so the user (a) gets *something*, and (b) knows the agent
 * skipped the wrap so the problem is visible instead of invisible.
 *
 * Stays local-fork-only — upstream's poll-loop has the strict drop
 * contract on purpose; this is Optimus-side belt-and-suspenders against
 * agent-prompt drift.
 */
/**
 * Emit a system-kind control row that tells the host this turn finished
 * with no user-facing output. The host's typing module picks it up via a
 * registered delivery-action handler and clears the typing indicator
 * immediately — without this, the indicator keeps refreshing on
 * heartbeat freshness for ~6s after the container goes idle, leaving the
 * user staring at "is typing…" with no message coming.
 *
 * Sent as kind='system' so the host's existing `kind === 'system'` branch
 * routes it to `handleSystemAction` → registered handler. No channel
 * delivery, no platform_id/channel_type needed.
 */
function emitSilentTurnComplete(): void {
  writeMessageOut({
    id: generateId(),
    in_reply_to: null,
    kind: 'system',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ action: 'silent_turn_complete' }),
  });
}

function deliverSafetyNet(body: string, routing: RoutingContext): void {
  if (!routing.platformId || !routing.channelType) {
    log(`safety-net: no origin channel in routing context, dropping`);
    return;
  }
  const labeled = `[degraded — agent did not wrap reply in <message> block]\n\n${body}`;
  const destRouting = resolveDestinationThread(routing.channelType, routing.platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: labeled }),
  });
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and reply-target message id from the most recent
 * inbound messages for the given channel+platform.
 *
 * `threadId` comes from the very latest row in the channel — any row's
 * thread is fine for routing, the destination's thread context doesn't
 * care which row produced it.
 *
 * `inReplyTo` is filtered: never a `kind='task'` row (id is a synthetic
 * UUID, not a platform message id — using it leaks a "reply to nothing"
 * pill that Discord falls back to the channel's most-recent real message
 * for, observed 2026-05-11 + 2026-05-13) and never a `trigger=0`
 * drive-by (accumulate-only chat that the agent isn't actually answering
 * — using it makes maintenance-task posts render as a reply to whoever
 * happened to chat most recently). Same exclusion shape as
 * `pickInReplyToMessage` in formatter.ts. If no matching `trigger=1`
 * non-task row exists, returns `inReplyTo: null` so the post lands as a
 * standalone message — the safer of the two failure modes.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const threadRow = db
      .prepare(
        `SELECT thread_id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null } | undefined;
    if (!threadRow) return null;
    const replyRow = db
      .prepare(
        `SELECT id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
           AND kind != 'task' AND trigger = 1
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { id: string } | undefined;
    return { threadId: threadRow.thread_id, inReplyTo: replyRow?.id ?? null };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
