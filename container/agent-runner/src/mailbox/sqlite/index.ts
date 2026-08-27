import {
  closeSessionDb,
  isTransientInboundError,
  sqliteClearContainerToolInFlight,
  sqliteClearStaleProcessingAcks,
  sqliteSetContainerToolInFlight,
} from './connection.js';
import {
  sqliteConsumeState,
  sqliteCountChatMessagesSince,
  sqliteDeleteState,
  sqliteDeleteStateByPrefixes,
  sqliteFindByName,
  sqliteFindByRouting,
  sqliteFindCliResponse,
  sqliteFindQuestionResponse,
  sqliteGetAllDestinations,
  sqliteGetLatestInboundRoute,
  sqliteGetMessageIn,
  sqliteGetMessageIdBySeq,
  sqliteGetOutboundCursor,
  sqliteGetPendingMessages,
  sqliteGetReplyTargetMessageIdBySeq,
  sqliteGetRoutingBySeq,
  sqliteGetSessionRouting,
  sqliteGetState,
  sqliteGetUndeliveredMessages,
  sqliteHasChatMessageTextSince,
  sqliteHasChatMessageToDestinationSince,
  sqliteHasIdenticalSend,
  sqliteIsTaskOnlyTurn,
  sqliteListTaskSeries,
  sqliteMarkCompleted,
  sqliteMarkFailed,
  sqliteMarkProcessing,
  sqliteMarkScriptSkipped,
  sqliteResetPendingMessageSchemaCacheForTesting,
  sqliteSetState,
  sqliteTimestamp,
  sqliteWriteMessageOut,
  sqliteWriteTaskFire,
} from './operations.js';
import type { MessageInRow } from '../../db/messages-in.js';
import type { MessageOutRow } from '../../db/messages-out.js';
import {
  parseContainerRecord,
  parseInboundRecord,
  parseOutboundRecord,
  parseSessionRoutingRecord,
} from '../model.generated.js';
import type {
  AgentMailbox,
  InboundMessage,
  MailboxOperations,
  MailboxSessionKey,
  OutboundMessage,
  ProcessingStatus,
} from '../types.js';

function inboundMessage(row: MessageInRow): InboundMessage {
  return parseInboundRecord({
    id: row.id,
    sequence: row.seq,
    kind: row.kind,
    timestamp: sqliteTimestamp(row.timestamp),
    status: row.status,
    processAfter: row.process_after === null ? null : sqliteTimestamp(row.process_after),
    recurrence: row.recurrence,
    seriesId: row.series_id ?? null,
    tries: row.tries,
    trigger: row.trigger === 1,
    platformId: row.platform_id,
    channelType: row.channel_type,
    threadId: row.thread_id,
    content: row.content,
    sourceSessionId: row.source_session_id ?? null,
    onWake: row.on_wake === 1,
  });
}

function outboundMessage(row: MessageOutRow): OutboundMessage {
  return parseOutboundRecord({
    id: row.id,
    sequence: row.seq,
    inReplyTo: row.in_reply_to,
    timestamp: sqliteTimestamp(row.timestamp),
    deliverAfter: row.deliver_after === null ? null : sqliteTimestamp(row.deliver_after),
    recurrence: row.recurrence,
    kind: row.kind,
    platformId: row.platform_id,
    channelType: row.channel_type,
    threadId: row.thread_id,
    content: row.content,
  });
}

function parseInboundMessage(row: MessageInRow): InboundMessage | undefined {
  try {
    return inboundMessage(row);
  } catch (error) {
    console.error(`[agent-runner] Skipping invalid inbound mailbox row ${row.id}: ${String(error)}`);
    return undefined;
  }
}

export class SqliteAgentMailbox implements AgentMailbox {
  readonly operations: MailboxOperations = this;

  shouldRestartAfter(error: unknown): boolean {
    return isTransientInboundError(error);
  }

  async start(_key: MailboxSessionKey | null): Promise<void> {}

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    return action();
  }

  async stop(): Promise<void> {
    closeSessionDb();
  }

  getPendingMessages(limit: number, isFirstPoll: boolean): InboundMessage[] {
    return sqliteGetPendingMessages(isFirstPoll, limit).flatMap((row) => {
      const message = parseInboundMessage(row);
      return message ? [message] : [];
    });
  }

  resetPendingMessageSchemaCacheForTesting(): void {
    sqliteResetPendingMessageSchemaCacheForTesting();
  }

  markMessages(ids: string[], status: ProcessingStatus): void {
    if (status === 'processing') sqliteMarkProcessing(ids);
    else if (status === 'completed') sqliteMarkCompleted(ids);
    else if (status === 'failed') ids.forEach(sqliteMarkFailed);
    else sqliteMarkScriptSkipped(ids.map((id) => ({ id, reason: 'error' })));
  }

  markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
    sqliteMarkScriptSkipped(skips);
  }

  getMessageIn(id: string): InboundMessage | undefined {
    const row = sqliteGetMessageIn(id);
    return row && parseInboundMessage(row);
  }

  findQuestionResponse(questionId: string): InboundMessage | undefined {
    const row = sqliteFindQuestionResponse(questionId);
    return row && parseInboundMessage(row);
  }

  findCliResponse(requestId: string): InboundMessage | undefined {
    const row = sqliteFindCliResponse(requestId);
    return row && parseInboundMessage(row);
  }

  isTaskOnlyTurn(): boolean {
    return sqliteIsTaskOnlyTurn();
  }

  listTaskSeries(status?: string) {
    return sqliteListTaskSeries(status);
  }

  writeTaskFire(fire: Parameters<MailboxOperations['writeTaskFire']>[0]): void {
    sqliteWriteTaskFire(fire);
  }

  async writeMessageOut(message: Parameters<MailboxOperations['writeMessageOut']>[0]): Promise<number> {
    return sqliteWriteMessageOut(message);
  }

  getMessageIdBySeq(sequence: number): string | null {
    return sqliteGetMessageIdBySeq(sequence);
  }

  getReplyTargetMessageIdBySeq(sequence: number): string | null {
    return sqliteGetReplyTargetMessageIdBySeq(sequence);
  }

  getRoutingBySeq(sequence: number) {
    const row = sqliteGetRoutingBySeq(sequence);
    return (
      row &&
      parseSessionRoutingRecord({
        channelType: row.channel_type,
        platformId: row.platform_id,
        threadId: row.thread_id,
      })
    );
  }

  getLatestInboundRoute(channelType: string, platformId: string) {
    return sqliteGetLatestInboundRoute(channelType, platformId);
  }

  getUndeliveredMessages(): OutboundMessage[] {
    return sqliteGetUndeliveredMessages().map(outboundMessage);
  }

  getOutboundCursor(): string {
    return sqliteGetOutboundCursor();
  }

  countChatMessagesSince(cursor: string): number {
    return sqliteCountChatMessagesSince(cursor);
  }

  hasChatMessageTextSince(cursor: string, text: string): boolean {
    return sqliteHasChatMessageTextSince(cursor, text);
  }

  hasChatMessageToDestinationSince(cursor: string, destination: { channelType: string; platformId: string }): boolean {
    return sqliteHasChatMessageToDestinationSince(cursor, destination);
  }

  hasIdenticalSend(platformId: string, channelType: string, text: string): boolean {
    return sqliteHasIdenticalSend(platformId, channelType, text);
  }

  getState(key: string) {
    return sqliteGetState(key);
  }

  setState(key: string, value: string): void {
    sqliteSetState(key, value);
  }

  deleteState(key: string): void {
    sqliteDeleteState(key);
  }

  deleteStateByPrefixes(prefixes: readonly string[]): number {
    return sqliteDeleteStateByPrefixes(prefixes);
  }

  consumeState(key: string) {
    return sqliteConsumeState(key);
  }

  getSessionRouting() {
    return sqliteGetSessionRouting();
  }

  getDestinations() {
    return sqliteGetAllDestinations();
  }

  findDestinationByName(name: string) {
    return sqliteFindByName(name);
  }

  findDestinationByRouting(channelType: string, platformId: string) {
    return sqliteFindByRouting(channelType, platformId);
  }

  setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
    const timeout =
      declaredTimeoutMs !== null && Number.isSafeInteger(declaredTimeoutMs) && declaredTimeoutMs >= 0
        ? declaredTimeoutMs
        : null;
    const record = parseContainerRecord({
      currentTool: tool,
      toolDeclaredTimeoutMs: timeout,
      toolStartedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    sqliteSetContainerToolInFlight(record.currentTool!, record.toolDeclaredTimeoutMs);
  }

  clearContainerToolInFlight = sqliteClearContainerToolInFlight;
  clearStaleProcessingAcks = sqliteClearStaleProcessingAcks;
}
