import type {
  DestinationRecord,
  InboundRecord,
  OutboundRecord,
  OutboundWrite,
  ProcessingStatus,
  SessionRoutingRecord,
  StateRecord,
} from './model.generated.js';

export type {
  ContainerRecord,
  DeliveryRecord,
  DestinationRecord,
  DirectOutboundWrite,
  InboundRecord,
  InboundStatus,
  InboundWrite,
  IsoTimestamp,
  OutboundDelivery,
  OutboundRecord,
  OutboundWrite,
  ProcessingAckRecord,
  ProcessingStatus,
  SessionRoutingRecord,
  StateRecord,
  TaskRecord,
  TaskStatus,
  TaskWrite,
} from './model.generated.js';

export interface MailboxSessionKey {
  agentGroupId: string;
  sessionId: string;
  mailbox: unknown;
}

export type InboundMessage = InboundRecord;
export type OutboundMessage = OutboundRecord;
export type Destination = DestinationRecord;
export type SessionRouting = SessionRoutingRecord;
export type OutboundMessageDraft = OutboundWrite;
export type StateValue = Omit<StateRecord, 'key'>;

export interface TaskFireDispatch {
  destination: string;
  body: string;
}

export type TaskFireStatus = 'completed' | 'silent' | 'error' | 'gated';

export interface TaskFireWrite {
  id: string;
  seriesId: string;
  taskId: string;
  status: TaskFireStatus;
  assistantText: string | null;
  dispatched: TaskFireDispatch[];
  errorMessage?: string | null;
}

export interface TaskSeriesSnapshot {
  id: string;
  status: string;
  processAfter: string | null;
  recurrence: string | null;
  content: string;
}

export interface MailboxOperations {
  getPendingMessages(limit: number, isFirstPoll: boolean): InboundMessage[];
  /** Optional because only schema-probing drivers need a process-lifetime test reset. */
  resetPendingMessageSchemaCacheForTesting?(): void;
  markMessages(ids: string[], status: ProcessingStatus): void;
  markScriptSkipped(skips: Array<{ id: string; reason: string }>): void;
  getMessageIn(id: string): InboundMessage | undefined;
  findQuestionResponse(questionId: string): InboundMessage | undefined;
  findCliResponse(requestId: string): InboundMessage | undefined;
  /** Legacy rollout fallback used only when no authoritative batch reply target exists. */
  isTaskOnlyTurn(): boolean;
  listTaskSeries(status?: string): TaskSeriesSnapshot[];
  writeTaskFire(fire: TaskFireWrite): void;
  writeMessageOut(message: OutboundMessageDraft): Promise<number>;
  getMessageIdBySeq(sequence: number): string | null;
  getReplyTargetMessageIdBySeq(sequence: number): string | null;
  getRoutingBySeq(sequence: number): SessionRouting | null;
  getLatestInboundRoute(channelType: string, platformId: string): { threadId: string | null; inReplyTo: string } | null;
  getUndeliveredMessages(): OutboundMessage[];
  /** Opaque cursor used to scope outbound queries to one push/turn. */
  getOutboundCursor(): string;
  countChatMessagesSince(cursor: string): number;
  hasChatMessageTextSince(cursor: string, text: string): boolean;
  hasChatMessageToDestinationSince(cursor: string, destination: { channelType: string; platformId: string }): boolean;
  hasIdenticalSend(platformId: string, channelType: string, text: string): boolean;
  getState(key: string): StateValue | undefined;
  setState(key: string, value: string): void;
  deleteState(key: string): void;
  deleteStateByPrefixes(prefixes: readonly string[]): number;
  consumeState(key: string): StateValue | undefined;
  getSessionRouting(): SessionRouting;
  getDestinations(): Destination[];
  findDestinationByName(name: string): Destination | undefined;
  findDestinationByRouting(channelType: string, platformId: string): Destination | undefined;
  setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void;
  clearContainerToolInFlight(): void;
  clearStaleProcessingAcks(): void;
}

export interface AgentMailbox {
  readonly operations: MailboxOperations;
  /** True when repeated read failures require a fresh runner process. */
  shouldRestartAfter?(error: unknown): boolean;
  /** Null only during runner-before-host upgrades; implementations that need context must reject it explicitly. */
  start(key: MailboxSessionKey | null): Promise<void>;
  run<T>(action: () => T | Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

export type AgentMailboxFactory = () => AgentMailbox;
