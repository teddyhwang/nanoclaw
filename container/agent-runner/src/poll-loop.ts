import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import {
  countChatMessagesSince,
  getReplyTargetMessageIdBySeq,
  getRoutingBySeq,
  outboundDbNow,
  writeMessageOut,
} from './db/messages-out.js';
import { writeTaskFire, type TaskFireDispatch } from './db/task-fires.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  clearContinuation,
  clearContinuationStartedAt,
  clearCurrentBatchReplyTarget,
  migrateLegacyContinuation,
  setContinuation,
  setContinuationStartedAt,
  setCurrentBatchReplyTarget,
} from './db/session-state.js';
import { computeRotationDate } from './session-rotation.js';
import { TIMEZONE } from './timezone.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import fs from 'fs';
import {
  formatMessages,
  extractRouting,
  isAddressedTurn,
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
import { getConfig } from './config.js';
import type { AgentProvider, AgentQuery, ImageContentBlock, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
// Host-side IDLE_TIMEOUT defaults to 120s; refresh well under that so
// one slow tick still leaves multiple ticks of headroom.
const QUERY_KEEPALIVE_MS = 30_000;
// Maximum SDK-silent gap the keepalive will bridge. The keepalive exists
// to cover legitimate LLM-only intervals (long text generation between
// tool calls, SDK ramp between push() and the first new event). The
// upper bound on a healthy LLM-only window is a few minutes; anything
// past STREAM_INACTIVITY_MS without ANY SDK event is the stream stalled
// half-open, not the model thinking. Past that threshold the keepalive
// stops touching the heartbeat so host-sweep's adaptive idle timeout
// (ACTIVE_IDLE_TIMEOUT=15min by default) can finally fire stop-idle.
//
// Incident 2026-05-20 (whatsapp_tico, telegram_dm_nicole): two Claude
// chat containers ran 2–3h after their last `Result:` event because the
// SDK iterator suspended post-result (legitimate keep-warm shape for
// follow-up turns) but never resumed/closed. The keepalive kept touching
// .heartbeat every 30s, the host saw a fresh heartbeat every sweep, and
// stop-idle could not fire. The codex provider has its own mid-turn
// inactivity watchdog (`9624e9ad`) for the pre-result variant of this
// hang; this is the symmetric post-result fix at the keepalive layer so
// every provider benefits without each implementing their own watchdog.
// Tuned well above any realistic single LLM-only window so a slow
// generation never trips it, well below ACTIVE_IDLE_TIMEOUT so the
// host's stop-idle has time to fire after we stop bumping the
// heartbeat.
const STREAM_INACTIVITY_MS = 5 * 60_000;

/**
 * Pure decision for the keepalive's "should I refresh the heartbeat?"
 * check. Returns true when the SDK stream has emitted an event within
 * the inactivity window — i.e. the keepalive should keep bridging the
 * legitimate LLM-only gap. Returns false once the gap has exceeded
 * `inactivityMs`, at which point the keepalive stops refreshing
 * heartbeat so host-sweep's stop-idle path can fire on a stalled
 * half-open stream. Exported for tests.
 */
export function shouldKeepaliveBridge(args: { lastEventAt: number; now: number; inactivityMs: number }): boolean {
  return args.now - args.lastEventAt <= args.inactivityMs;
}

/**
 * Pure batch-selection for the initial wake. Decides which rows ride
 * this provider turn and which are deferred (left pending for the next
 * wake). Returns the chosen batch plus any log lines the caller should
 * emit. Pure so it can be tested without standing up the SDK.
 *
 * Two isolation layers, applied in order:
 *
 * 1. Task/chat isolation — if any trigger=1 task row is present, drop
 *    ALL chat/chat-sdk rows. Without this, silent-maintenance tasks
 *    ("do NOT send any messages") get chat shoved into the prompt and
 *    the model overrides the silence instruction to reply to what looks
 *    like a live user turn. Two motivating incidents:
 *      - 2026-05-11 04:01 (shit-talk): mackchiu's trigger=0 accumulate
 *        chats from the prior evening dragged into the 04:02 maintenance
 *        wake; agent posted a chat reply despite the silent-task
 *        instruction.
 *      - 2026-05-16 13:22 (AI Friends dream leak): the original fix's
 *        hole — `taskOnlyWake = triggerRows.every(kind==='task')` missed
 *        the case where AI-Friends mention-sticky chat was marked
 *        trigger=1. Now isolation triggers on *any* task trigger, and
 *        defers chat rows regardless of their trigger flag (sticky-
 *        engage chat is still chat).
 *
 * 2. Dream-only isolation — if any dream-series row (`series_id` starts
 *    with `dream-`) is in the post-step-1 batch, defer every non-dream
 *    row too. The dream's silent `<internal>` summary must be the only
 *    result event in the stream so per-push attribution can route the
 *    text to the dream's fire context. Without this, a co-arriving
 *    non-dream task (recap/status-update/RSS — anything that registered
 *    AFTER the dream) wins attribution when the result lands and the
 *    dream fire row ends with `assistant_text=''`. Observed 2026-05-25,
 *    `ag-1778154011329-g9zust` (Degenerate Server): dashboard showed
 *    "Silent fire — no output captured" for a dream that ran correctly.
 *    The dream is silent-by-design — deferring co-arrivers costs at
 *    most one poll tick before they get their own clean stream.
 */
export function selectInitialBatch(messages: MessageInRow[]): {
  batch: MessageInRow[];
  logs: string[];
} {
  const logs: string[] = [];
  const isChatRow = (m: MessageInRow): boolean => m.kind === 'chat' || m.kind === 'chat-sdk';
  const isDreamRow = (m: MessageInRow): boolean => (m.series_id ?? '').startsWith('dream-');

  let batch = messages;

  const hasTaskTrigger = messages.some((m) => m.trigger === 1 && m.kind === 'task');
  if (hasTaskTrigger) {
    const dropped = messages.filter(isChatRow);
    if (dropped.length > 0) {
      const stickyDeferred = dropped.filter((m) => m.trigger === 1).length;
      logs.push(
        `Task trigger present: isolating task turn, deferring ${dropped.length} chat row(s) ` +
          `(${stickyDeferred} trigger=1 sticky-engage) — left pending for next chat wake`,
      );
      batch = messages.filter((m) => !isChatRow(m));
    }
  }

  if (batch.some(isDreamRow)) {
    const dreamRows = batch.filter(isDreamRow);
    const nonDream = batch.filter((m) => !isDreamRow(m));
    if (nonDream.length > 0) {
      logs.push(
        `Dream trigger present: isolating ${dreamRows.length} dream row(s), ` +
          `deferring ${nonDream.length} non-dream row(s) — left pending for next wake`,
      );
      batch = dreamRows;
    }
  }

  return { batch, logs };
}

/**
 * Push-scoped attribution: pick the newest unwritten task context in the
 * oldest push that still has one. The SDK emits `result` events in push
 * order, so the earliest push with pending contexts owns the next result.
 *
 * Pure so the attribution decision is testable without standing up the
 * SDK. See processQuery's attribution comment for the 2026-05-25
 * Degenerate-Server incident this replaces.
 */
export function pickPushScopedContext(pushes: TaskFireContext[][]): TaskFireContext | null {
  for (const push of pushes) {
    for (let i = push.length - 1; i >= 0; i--) {
      if (!push[i].written) return push[i];
    }
  }
  return null;
}

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

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

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

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
    const isolation = selectInitialBatch(messages);
    for (const line of isolation.logs) log(line);
    const batch = isolation.batch;

    const ids = batch.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(batch);
    // Did a human @mention this agent or reply to one of its messages
    // this turn? Computed once here from the same batch routing uses.
    // Threaded into processQuery → dispatchResultText so an addressed
    // turn that produces no deliverable output emits an explicit
    // fallback instead of a bare silent_turn_complete the user never
    // sees (2026-05-17 AI Friends incident).
    //
    // assistantName only powers isAddressedTurn's *secondary*
    // reply-to-bot-by-name path; the primary isMention / replyTo.toBot
    // signals don't need it. Resolve it defensively: getConfig() throws
    // if loadConfig() hasn't run (the production entrypoint always calls
    // it first, but integration tests drive runPollLoop directly without
    // it). A throw here would crash the whole loop for a name-match
    // nicety — degrade to "" (skip only the name path) instead.
    let assistantName = '';
    try {
      assistantName = getConfig().assistantName;
    } catch {
      // config not loaded (test harness / very early boot) — name-match
      // path is skipped, isMention/toBot still work.
    }
    const addressed = isAddressedTurn(batch, assistantName);

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

    // Per-dequeue session rotation — fires BEFORE provider.query() so the
    // current turn always runs on a coherent thread (rotating mid-flight
    // would destroy the in-memory `resume` id while the SDK is still using
    // it). Upstream calls maybeRotateContinuation once at container boot;
    // we additionally call it before every query so drift-axis triggers
    // (post-compact summaries, day-boundary crossings — see
    // session-rotation.ts) fire even in a long-lived warm container.
    if (continuation) {
      const reason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
      if (reason) {
        log(`Rotating session before query: ${reason} (previous continuation: ${continuation})`);
        clearContinuation(config.providerName);
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
    // Two transports, both required: module state for any in-process
    // consumer, AND session_state (outbound.db) because the built-in MCP
    // server runs as a separate stdio subprocess that cannot see this
    // process's module state. The DB value is the AUTHORITATIVE reply
    // target — it is `null` for task-only / accumulate-only turns
    // (extractRouting → pickInReplyToMessage already excluded task rows),
    // which is exactly the signal that stops a recurring RSS/status post
    // from inheriting a stale human @mention's reply pill. See
    // setCurrentBatchReplyTarget's docstring for the full incident chain.
    setCurrentInReplyTo(routing.inReplyTo);
    setCurrentBatchReplyTarget(routing.inReplyTo);
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        activeSender,
        addressed,
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
      // Drop the DB-published target too. Once the key is absent the MCP
      // subprocess falls back to its legacy heuristic — correct for any
      // stray off-turn send, and prevents a finished turn's target from
      // leaking onto the next turn before poll-loop republishes.
      clearCurrentBatchReplyTarget();
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
  // True when the initial batch @mentioned this agent or replied to it.
  // Forwarded to dispatchResultText so a zero-output addressed turn
  // delivers an explicit fallback rather than silent_turn_complete.
  // Note: only the initial-turn dispatch is gated on this — follow-up
  // pushes within a long-lived query keep the prior behavior (the
  // follow-up path is ambient continuation, not a fresh direct address).
  addressed: boolean,
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
  // Flips on the first `result` event. The initial @mention/reply-to-bot
  // batch's response is the first result; later results in the same
  // stream are follow-up-push continuations. Only the first is gated on
  // `addressed` (see the result-event handler for why).
  let firstResultSeen = false;
  // SQLite-UTC stamp captured before the agent runs, so the addressed-
  // silent safety net can tell whether the agent delivered a chat
  // message via an MCP tool (send_file/send_message) during this turn —
  // those write straight to outbound.db and never appear as <message>
  // blocks. Captured once here, passed to every dispatchResultText call.
  const turnStartedAt = outboundDbNow();
  // Attribution: result events fold into one provider stream and the SDK
  // does not tag which pushed prompt produced a given <message> block.
  // The ROW COUNT and KEYS are always exact (one row per due task, keyed
  // by its own series_id/id); only the dispatched/assistantText *payload*
  // needs disambiguation when multiple tasks fold into one stream.
  //
  // Strategy: push-scoped attribution. The SDK delivers `result` events
  // in push order — push 1's result before push 2's — so we partition
  // contexts by which `query.push` (or initial batch) produced them and
  // serve them in that order. Each result picks the OLDEST push that
  // still has an unwritten context, then the newest unwritten context
  // within that push.
  //
  // Why push-scoped beats the prior "most recent unwritten overall":
  //   On 2026-05-25 a Degenerate-Server dream task fired in the initial
  //   batch alongside 30+ gated recap claims; later a real recap task +
  //   a chat-sdk turn arrived as separate follow-up pushes. With "most
  //   recent unwritten overall", the follow-up chat-sdk context became
  //   `mostRecentTaskContext()` when the agent's `result.text` (which
  //   was actually the dream's `<internal>` summary) landed — text was
  //   attributed to the chat task, dream context flushed empty,
  //   dashboard showed "Silent fire — no output captured" for the dream
  //   even though it ran correctly.
  //
  //   Push-scoping makes the initial-batch dream context the only
  //   eligible target for the first result; the chat-sdk follow-up only
  //   becomes eligible after the dream context is written.
  //
  // Paired with the dream-only isolation block above (an initial batch
  // with a dream row defers all non-dream rows), the canonical dream
  // case is now structurally clean: dream is the lone context in push 0,
  // its result attributes to it, fire row carries the `<internal>`
  // summary.
  //
  // Errors set `streamErrored` so the finally skips the normal-completion
  // write; the outer catch in startMessageLoop writes one error fire per
  // unwritten context instead.
  //
  // Each entry is the contexts registered during a single push (initial
  // batch at index 0, each subsequent `query.push` appends a new entry).
  // Contexts can appear in only one push — `registerPushContexts` skips
  // any already present in an earlier push (idempotent with the existing
  // `registerTaskFireContextOnce`).
  const pushes: TaskFireContext[][] = [];
  const registerPushContexts = (ctxs: TaskFireContext[]): void => {
    const seenInPriorPush = new Set<string>();
    for (const earlier of pushes) {
      for (const c of earlier) seenInPriorPush.add(c.taskId);
    }
    const next = ctxs.filter((c) => !seenInPriorPush.has(c.taskId));
    pushes.push(next);
  };
  // Seed push 0 with the initial-batch contexts already populated by
  // the caller. Safe even when empty (chat-only turn — no task contexts;
  // results just won't attribute to any context, matching prior behavior).
  registerPushContexts([...taskFireContexts]);
  const mostRecentTaskContext = (): TaskFireContext | null => pickPushScopedContext(pushes);
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
  // Wall-clock of the last SDK event consumed on the events for-await
  // below. Initialized at stream open (a half-open stream that never
  // emits anything would otherwise leave this at 0 and let the
  // STREAM_INACTIVITY_MS gate fire immediately). Updated on every SDK
  // event in the events for-await loop. Read by the keepalive interval
  // to decide whether to refresh the heartbeat — see STREAM_INACTIVITY_MS.
  let lastEventAt = Date.now();
  // Keepalive: while the query stream is open AND has shown SDK
  // activity within STREAM_INACTIVITY_MS, refresh heartbeat at a cadence
  // well under IDLE_TIMEOUT (default 120s). The for-await loop below
  // bumps heartbeat on every SDK event, and Pre/PostToolUse hooks bump
  // on every tool boundary, but neither fires during LLM-only intervals
  // — a long text generation after the last tool call, or SDK ramp-up
  // between query.push() and the first new event, can exceed
  // IDLE_TIMEOUT and trip the host's `stop-idle` kill mid-thought. The
  // keepalive bridges those windows.
  //
  // BUT: an unconditional keepalive structurally suppresses host-side
  // stop-idle whenever the SDK stream goes silent half-open (Claude
  // SDK post-`result` keep-warm where the iterator suspends awaiting a
  // follow-up that never arrives; observed 2026-05-20, two chat
  // containers ran 2–3h after their last result event because the
  // keepalive kept .heartbeat fresh forever). Gate on lastEventAt:
  // once the SDK has gone silent past STREAM_INACTIVITY_MS, stop
  // touching the heartbeat so host-sweep's adaptive idle timeout can
  // do its job. A legitimately slow LLM-only interval emits SOME
  // SDK message (token delta, tool boundary, sub-agent status) inside
  // this window; only a genuinely stalled stream goes this quiet.
  const keepaliveHandle = setInterval(() => {
    if (done) return;
    if (!shouldKeepaliveBridge({ lastEventAt, now: Date.now(), inactivityMs: STREAM_INACTIVITY_MS })) return;
    touchHeartbeat();
  }, QUERY_KEEPALIVE_MS);
  let corruptionStreak = 0;
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
        lastEventAt = Date.now();
        // Open a new push partition for per-push attribution before the
        // SDK push. Result events that arrive after this point are
        // candidates to attribute to these follow-up task contexts only
        // once every earlier push's contexts have been written. The push
        // entry can be empty (a chat-sdk-only follow-up registers no task
        // contexts) — that's fine; it just means no task-attribution
        // change for this push, and earlier pushes' contexts remain
        // eligible for results.
        const pushTaskContexts = keep
          .filter((m) => m.kind === 'task' && m.trigger === 1)
          .map((m) => taskFireContexts.find((c) => c.taskId === m.id))
          .filter((c): c is TaskFireContext => c !== undefined);
        registerPushContexts(pushTaskContexts);
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
        // Mirror extractRouting's contract EXACTLY: the authoritative
        // reply target is `target?.id ?? null`. Republishing only when
        // `target?.id` was truthy was a bug — for a task-only follow-up
        // (recurring RSS / daily recap, where `keep` is all kind='task'
        // so the picker correctly returns null) the block was skipped,
        // so the authoritative "NO reply pill" null was never written.
        // Combined with the per-iteration `finally` clearCurrentBatch-
        // ReplyTarget(), the session_state key was ABSENT exactly when
        // the follow-up's send_message ran → getCurrentBatchReplyTarget()
        // returned undefined → resolveInReplyTo fell to the racy legacy
        // isTaskOnlyTurn() heuristic → the recap/status post reply-pilled
        // onto a stale ~22h-old chat message (observed live 2026-05-18/19
        // in AI Friends, the regret after the NUL-sentinel fix 999c201).
        // Publish the tri-state unconditionally so a task-only follow-up
        // authoritatively suppresses the pill instead of falling back.
        const nextInReplyTo = target?.id ?? null;
        routing.inReplyTo = nextInReplyTo;
        // Re-publish on BOTH transports. The DB transport is what the
        // stdio MCP subprocess actually reads; without this republish a
        // long multi-batch turn would keep the subprocess pinned to the
        // ORIGINAL batch's target (set at the top of the turn) and
        // reply-pill follow-up sends onto the wrong message — and, for
        // the task-only case, would leave the key absent entirely.
        setCurrentInReplyTo(nextInReplyTo);
        setCurrentBatchReplyTarget(nextInReplyTo);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
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
        lastEventAt = Date.now();

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
          //
          // `addressed` only gates the FIRST result: that's the response
          // to the initial @mention/reply-to-bot batch. Subsequent
          // results in this same stream come from follow-up pushes
          // (ambient continuation within an already-active container) —
          // those keep the prior silent-turn behavior so a long-lived
          // warm container doesn't spam degraded fallbacks on every
          // ambient lull. `initialBatchIds` is only completed once, on
          // this same first result, so they move together.
          const isFirstResult = !firstResultSeen;
          firstResultSeen = true;
          markCompleted(initialBatchIds);
          if (event.text) {
            // Attribute this result push-scoped: the newest unwritten
            // context in the OLDEST push that still has one. The SDK
            // delivers results in push order, so the earliest pending
            // push owns the next result. See processQuery's attribution
            // note for why this beats the prior overall-most-recent walk.
            const fireCtx = mostRecentTaskContext();
            if (fireCtx) fireCtx.assistantText = event.text;
            const { hasUnwrapped, dispatched } = dispatchResultText(
              event.text,
              routing,
              isFirstResult && addressed,
              turnStartedAt,
            );
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
// Exported for tests. Local-fork patch: the unwrapped-output branch needs
// focused coverage so the leak-to-channel class of bug stays caught.
// Returns { sent, hasUnwrapped, dispatched } so callers can also kick off the
// upstream nudge re-prompt. `dispatched` is the list of
// { destination, body } pairs actually sent (post-dedup) so the
// poll-loop's task_fires writer can record what the agent emitted on a
// task fire.
export interface DispatchedMessage {
  destination: string;
  body: string;
}

interface MessageBlock {
  to: string;
  replyToSeq: number | null;
  body: string;
}

/**
 * True when a zero-output addressed turn ended because the agent hit
 * the sensitive-action gate and is correctly WAITING for the user's
 * in-chat Confirm tap — NOT because a tool failed.
 *
 * Why this matters (2026-05-18, the confidence-killer): when the gate
 * fires, the model receives the gate's pending result ("…is awaiting
 * the user's confirmation … End your turn now without commentary") and
 * dutifully ends the turn with only `<internal>Waiting for <X>
 * confirmation.</internal>` — zero `<message>` output. On an addressed
 * turn that fell through to the alarming "[degraded — addressed turn
 * produced no output (likely tool failure)] … This is a bug, try
 * again" safety-net, EVERY gated request, BEFORE the user even taps
 * Confirm. The real answer then arrives ~20s later via the engine
 * replay → appr-note path, but the user has already been told it's
 * broken. This is an expected pause, not a failure: stay silent, the
 * result will follow.
 *
 * Pure + conservative: matches only the gate's own pause signature
 * (an `<internal>`/scratchpad note about waiting for confirmation, or
 * the gate's verbatim pending-result language). A genuine tool failure
 * does NOT produce this coherent "waiting for confirmation" text, so
 * the real degraded-fallback path is preserved.
 */
export function isAwaitingSensitiveConfirmation(text: string): boolean {
  const t = text.toLowerCase();
  // The gate's pending-result verbatim language (mcp-sensitive-gate-
  // wrap.ts pendingResult) reflected by the model, OR the model's own
  // standard "waiting for <provider> confirmation" internal note.
  return (
    /awaiting the user'?s confirmation/.test(t) ||
    /a (confirm|approval) prompt (is|has been) (shown|posted)/.test(t) ||
    /\bwaiting for\b[^.]*\bconfirm(ation)?\b/.test(t) ||
    /\bconfirm(ation)? (prompt|card)\b[^.]*\b(pending|posted|shown|in chat)\b/.test(t)
  );
}

export function dispatchResultText(
  text: string,
  routing: RoutingContext,
  // True when a human @mentioned this agent or replied to one of its
  // messages this turn (computed once per turn via formatter's
  // isAddressedTurn). An addressed turn that produces zero deliverable
  // output must NOT end as a bare silent_turn_complete — that reads as
  // the bot being broken (2026-05-17 AI Friends incident: silent on a
  // reply-to-bot follow-up after search_conversations failed). Defaults
  // false so non-chat callers (tasks, tests that don't care) keep the
  // prior silent-turn behavior unchanged.
  addressed = false,
  // SQLite-UTC timestamp (`outboundDbNow()`) captured at the start of
  // this turn. When set, the addressed-silent safety net checks whether
  // a `kind='chat'` outbound row was written since — i.e. the agent
  // already replied via an MCP tool (`send_file`, `send_message`,
  // `generate_image` → send_file) rather than a `<message>` block.
  // Without it, a turn whose only deliverable was a tool-sent file
  // produces zero parsed `<message>` blocks and mis-fires the scary
  // degraded fallback (2026-05-21: an image-gen reply in the Discord
  // Teddy DM landed fine, then got a bogus "produced no output" note).
  // Undefined for callers that don't track it — they keep prior behavior.
  turnStartedAt?: string,
): { sent: number; hasUnwrapped: boolean; dispatched: DispatchedMessage[] } {
  const MESSAGE_RE = /<message\s+([^>]*)>([\s\S]*?)<\/message>/g;

  // Tolerate a final unclosed `<message to="...">`: long-bodied replies on
  // Claude occasionally drop the closing `</message>` (observed 2026-05-28
  // in degen_server_cook: Epicure pairing reply truncated mid-tag, parser
  // returned 0 blocks and the full answer was suppressed as scratchpad).
  // If the last well-formed `<message ...>` opener has no matching
  // `</message>` after it, synthesize one at end-of-text so the regex
  // captures the body. The opener match requires whitespace + attrs + `>`
  // so a bare `<message` substring in scratchpad doesn't trigger recovery.
  const openerRe = /<message\s+[^>]*>/g;
  let lastOpenerEnd = -1;
  let openerMatch: RegExpExecArray | null;
  while ((openerMatch = openerRe.exec(text)) !== null) {
    lastOpenerEnd = openerMatch.index + openerMatch[0].length;
  }
  const normalizedText =
    lastOpenerEnd !== -1 && !text.slice(lastOpenerEnd).includes('</message>') ? `${text}</message>` : text;

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

  while ((match = MESSAGE_RE.exec(normalizedText)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(normalizedText.slice(lastIndex, match.index));
    }
    const block = parseMessageBlock(match[1], match[2]);
    lastIndex = MESSAGE_RE.lastIndex;
    if (!block) {
      scratchpadParts.push(`[dropped: malformed <message> block] ${match[2].trim()}`);
      continue;
    }
    const toName = block.to;
    const body = block.body;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    const dedupKey = `${toName} ${body.replace(/\s+/g, ' ')}`;
    if (seen.has(dedupKey)) {
      log(`Suppressing duplicate <message to="${toName}"> block within one turn`);
      continue;
    }
    seen.add(dedupKey);
    const sentOk = sendToDestination(dest, body, routing, block.replyToSeq);
    if (!sentOk) {
      scratchpadParts.push(`[dropped: invalid reply target for "${toName}"] ${body}`);
      continue;
    }
    dispatched.push({ destination: toName, body });
    sent++;
  }
  if (lastIndex < normalizedText.length) {
    scratchpadParts.push(normalizedText.slice(lastIndex));
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
    log(`WARNING: agent output had no <message to="..."> blocks — suppressing unwrapped text and nudging retry`);
    emitSilentTurnComplete();
    // Caller pushes an upstream-style nudge re-prompt via the
    // hasUnwrapped return value. Do NOT show the unwrapped text to users:
    // bare text is often scratchpad/meta narration, and the runner cannot
    // know which destination the model intended. The retry prompt lets the
    // agent re-send with an explicit <message to="..."> destination.
    return { sent, hasUnwrapped, dispatched };
  }

  // Truly silent turn: no <message> blocks AND no user-facing scratchpad
  // (e.g. agent emitted only `<internal>...</internal>`, or returned an
  // empty result).
  if (sent === 0) {
    if (addressed && isAwaitingSensitiveConfirmation(text)) {
      // EXPECTED pause, NOT a failure: the agent hit the sensitive-action
      // gate and is waiting for the user's in-chat Confirm tap. The gate
      // told it to "end your turn now without commentary", so it
      // correctly produced zero <message> output. Emitting the scary
      // "[degraded — likely tool failure] this is a bug" safety-net here
      // (which is what happened on EVERY gated request before this guard,
      // 2026-05-18) is wrong and was the single biggest confidence-killer:
      // the user sees "broken" first, then the real answer arrives ~20s
      // later via the engine replay → appr-note path. Stay silent; the
      // result will follow once they confirm. Tell the host the turn is
      // over so typing stops.
      log(
        'addressed turn produced no output but is AWAITING SENSITIVE-GATE ' +
          'CONFIRMATION — suppressing degraded fallback (result will arrive ' +
          'via the post-confirm replay)',
      );
      emitSilentTurnComplete();
      return { sent, hasUnwrapped, dispatched };
    }
    if (addressed) {
      // Before declaring this an empty turn: did the agent already
      // deliver something via an MCP tool? `send_file`, `send_message`,
      // and `generate_image`→send_file all write `kind='chat'` rows
      // straight to outbound.db — they never appear as `<message>`
      // blocks in the result text, so `sent` stays 0 even though the
      // user got a real reply. Firing the degraded "produced no output"
      // fallback here is a false alarm (2026-05-21: an image delivered
      // fine in the Discord Teddy DM, then got a bogus failure note).
      // If a chat row exists since turn start, the turn DID deliver —
      // end it cleanly with silent_turn_complete instead.
      if (turnStartedAt && countChatMessagesSince(turnStartedAt) > 0) {
        log(
          'addressed turn emitted no <message> blocks but delivered a ' +
            'chat message via a tool (send_file/send_message) — ending ' +
            'cleanly, suppressing degraded fallback',
        );
        emitSilentTurnComplete();
        return { sent, hasUnwrapped, dispatched };
      }
      // A human @mentioned this agent or replied to it, and the agent
      // produced nothing to send back. Do not synthesize a visible
      // "[degraded]" channel post: those messages are alarming, can route
      // incorrectly if the batch carries cross-channel context, and are not
      // the agent's actual answer. End the turn quietly; the host logs and
      // task_fires keep the failure visible to operators.
      log(`WARNING: addressed turn produced no deliverable output — suppressing degraded fallback`);
      emitSilentTurnComplete();
      return { sent, hasUnwrapped, dispatched };
    }
    // Genuinely nothing-to-say (ambient chatter / maintenance task).
    // Tell the host the turn is over so it can stop the typing
    // indicator immediately, instead of letting it refresh on heartbeat
    // freshness for the full HEARTBEAT_FRESH_MS window after the
    // container goes idle. The host's typing module registers the
    // matching `silent_turn_complete` delivery-action handler.
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

/**
 * Decide the reply-pill target for a dispatched outbound post.
 *
 * `routing.inReplyTo` is the TURN-AUTHORITATIVE target: poll-loop set it
 * once via `extractRouting → pickInReplyToMessage`, which is `null` for a
 * task-only / accumulate-only turn (RSS status, daily recap, dream/
 * maintenance) and the triggering message id for a real chat turn.
 *
 * `resolveDestinationThread().inReplyTo` is an independent, TURN-BLIND DB
 * hunt for the channel's newest non-task trigger=1 row. It exists only
 * to correct the reply target per-destination in agent-shared sessions
 * (one session fans out to several chats; routing's single target may
 * belong to a different chat than the one we're posting to). It must
 * NEVER resurrect a pill on a turn poll-loop deliberately marked
 * pill-free — doing so is exactly the recurring RSS/recap reply-pill
 * regression: `destRouting.inReplyTo ?? routing.inReplyTo` let the stale
 * DB hunt shadow the authoritative null, so every task fire pilled onto
 * the newest human @mention ever sent in the channel (observed
 * 2026-05-11/13/15/18/19 in AI Friends — a ~22h-old "Direct answers from
 * the chat log…" message). All prior fixes patched the MCP-tool path
 * (resolveInReplyTo / the session_state tri-state); the <message>-tag
 * dispatch path always used this turn-blind resolver and kept regressing.
 *
 * Contract: when the turn is authoritatively pill-free (routing.inReplyTo
 * is null) the post stays standalone, period. Only when routing has a
 * real target do we let the per-destination hunt refine it (or fall back
 * to routing's own target if the hunt found nothing).
 */
function resolveDispatchReplyTarget(
  routing: RoutingContext,
  destRouting: { threadId: string | null; inReplyTo: string | null } | null,
  explicitReplyToSeq: number | null = null,
  explicitRouting?: { channel_type: string; platform_id: string },
): string | null {
  if (explicitReplyToSeq != null && explicitRouting) {
    const explicit = resolveExplicitReplyTarget(explicitReplyToSeq, explicitRouting);
    if (explicit) return explicit;
  }
  if (routing.inReplyTo == null) return null; // task / accumulate turn — never pill
  // Same-channel dispatch: routing.inReplyTo IS the authoritative target
  // (the message that triggered this turn). The per-destination DB hunt
  // (`destRouting.inReplyTo`) was designed for cross-destination fan-out
  // in agent-shared sessions — picking "newest trigger=1 in channel X"
  // when X is NOT the channel that woke this turn. Letting it shadow
  // routing.inReplyTo on a same-channel reply is the recurring "agent
  // quote-replied to the wrong message" bug: later trigger=1 inbounds
  // (a different user's @mention arriving while the agent was thinking)
  // become "newer" by seq DESC, and the reply pill attaches to that
  // stranger's message instead of the one we're actually answering
  // (observed 2026-05-23 in New York Crew WhatsApp — Optimus's reply
  // to Jon's earlier hotel-name request pilled onto Nicole's just-
  // arrived km-conversion request because Nicole's row was newer).
  const sameChannel =
    explicitRouting != null &&
    routing.channelType === explicitRouting.channel_type &&
    routing.platformId === explicitRouting.platform_id;
  if (sameChannel) return routing.inReplyTo;
  return destRouting?.inReplyTo ?? null;
}

function sendToDestination(
  dest: DestinationEntry,
  body: string,
  routing: RoutingContext,
  explicitReplyToSeq: number | null = null,
): boolean {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  const inReplyTo = resolveDispatchReplyTarget(routing, destRouting, explicitReplyToSeq, {
    channel_type: channelType,
    platform_id: platformId,
  });
  if (explicitReplyToSeq != null && inReplyTo == null) {
    log(`Invalid reply_to_message_id #${explicitReplyToSeq} for <message to="${dest.name}">, dropping block`);
    return false;
  }
  writeMessageOut({
    id: generateId(),
    in_reply_to: inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
  return true;
}

function parseMessageBlock(attrs: string, rawBody: string): MessageBlock | null {
  const parsed: Record<string, string> = {};
  const attrRe = /([A-Za-z_][\w:-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrs)) !== null) {
    parsed[match[1]] = match[2];
  }
  const to = parsed.to?.trim();
  if (!to) return null;
  const replyToSeq = parseMessageSeq(parsed.reply_to_message_id);
  if (parsed.reply_to_message_id != null && replyToSeq == null) return null;
  return { to, replyToSeq, body: rawBody.trim() };
}

function parseMessageSeq(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const trimmed = value.trim().replace(/^#/, '');
  if (!/^\d+$/.test(trimmed)) return null;
  const seq = Number(trimmed);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

function resolveExplicitReplyTarget(
  seq: number,
  routing: { channel_type: string; platform_id: string },
): string | null {
  const targetRouting = getRoutingBySeq(seq);
  if (!targetRouting) return null;
  if (targetRouting.channel_type !== routing.channel_type || targetRouting.platform_id !== routing.platform_id) {
    return null;
  }
  return getReplyTargetMessageIdBySeq(seq);
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
         ORDER BY COALESCE(seq, rowid) DESC, datetime(timestamp) DESC, rowid DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null } | undefined;
    if (!threadRow) return null;
    const replyRow = db
      .prepare(
        `SELECT id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
           AND kind != 'task' AND trigger = 1
         ORDER BY COALESCE(seq, rowid) DESC, datetime(timestamp) DESC, rowid DESC LIMIT 1`,
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
