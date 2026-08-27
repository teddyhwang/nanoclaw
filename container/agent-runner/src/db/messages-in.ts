/**
 * Legacy runner-facing inbound API, backed by the registered mailbox.
 */
import { getConfig } from '../config.js';
import { getAgentMailbox } from '../mailbox/index.js';
import type { InboundMessage } from '../mailbox/types.js';

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: InboundMessage['kind'];
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  /**
   * Stable identity across recurrences. Recurring tasks get a fresh row id
   * per occurrence while `series_id` remains stable across the series.
   */
  series_id: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only. */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
  on_wake: number;
}

function messageRow(message: InboundMessage): MessageInRow {
  return {
    id: message.id,
    seq: message.sequence,
    kind: message.kind,
    timestamp: message.timestamp,
    status: message.status,
    process_after: message.processAfter,
    recurrence: message.recurrence,
    series_id: message.seriesId,
    tries: message.tries,
    trigger: message.trigger ? 1 : 0,
    platform_id: message.platformId,
    channel_type: message.channelType,
    thread_id: message.threadId,
    content: message.content,
    source_session_id: message.sourceSessionId,
    on_wake: message.onWake ? 1 : 0,
  };
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default.
    return 10;
  }
}

/**
 * Fetch due pending messages while excluding work already claimed by this
 * runner. The mailbox implementation owns filtering and cap accounting so
 * system/claimed/stale/off-route rows cannot crowd real wake rows out.
 */
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  return getAgentMailbox().operations.getPendingMessages(getMaxMessagesPerPrompt(), isFirstPoll).map(messageRow);
}

/** Test-only compatibility hook for the SQLite driver's schema-probe cache. */
export function _resetOnWakeCacheForTests(): void {
  getAgentMailbox().operations.resetPendingMessageSchemaCacheForTesting?.();
}

export function markProcessing(ids: string[]): void {
  getAgentMailbox().operations.markMessages(ids, 'processing');
}

export function markCompleted(ids: string[]): void {
  getAgentMailbox().operations.markMessages(ids, 'completed');
}

export function markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
  getAgentMailbox().operations.markScriptSkipped(skips);
}

export function markFailed(id: string): void {
  getAgentMailbox().operations.markMessages([id], 'failed');
}

export function getMessageIn(id: string): MessageInRow | undefined {
  const message = getAgentMailbox().operations.getMessageIn(id);
  return message && messageRow(message);
}

export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const message = getAgentMailbox().operations.findQuestionResponse(questionId);
  return message && messageRow(message);
}

export function findCliResponse(requestId: string): MessageInRow | undefined {
  const message = getAgentMailbox().operations.findCliResponse(requestId);
  return message && messageRow(message);
}
