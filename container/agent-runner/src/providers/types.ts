export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Image content blocks to send with the initial user message as multimodal
   * content. When non-empty, the provider sends `[{type:'text', text: prompt},
   * ...imageBlocks]` instead of a text-only message. Used to deliver inbound
   * chat image attachments (Discord/Slack/Telegram screenshots) to vision-
   * capable models. Providers without vision support should ignore.
   *
   * Built by the poll-loop from `messages_in.attachments[].localPath` for
   * any attachment with `type === 'image'`. The text prompt still references
   * the image marker (`[image: name — saved to /workspace/inbox/<id>/<name>]`)
   * so the model knows which file the bytes correspond to.
   */
  imageBlocks?: ImageContentBlock[];

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

/**
 * Anthropic-shaped image content block. The provider may translate to its
 * own SDK's shape — we use Anthropic's because Claude is the primary
 * vision-capable provider and the SDK accepts this verbatim.
 */
export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

/**
 * MCP server configuration. Discriminated by `type` so callers can carry
 * stdio (process-spawned) or http (remote endpoint) shapes through the
 * same map. Default is stdio for back-compat with configs that omit
 * `type` — pre-existing call sites and container.json files keep
 * working.
 *
 * The Anthropic Agent SDK already supports both shapes natively via
 * `McpServerConfig` in @anthropic-ai/claude-agent-sdk; the agent-runner
 * just needs to pass each variant through. Non-Claude providers
 * (pi-mcp-adapter, codex) have their own translation in their provider
 * module.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpStdioServerConfig {
  /** Optional discriminant. Omitted = 'stdio' for back-compat. */
  type?: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  /** Optional bearer token / custom headers (e.g. `Authorization`). */
  headers?: Record<string, string>;
}

export interface AgentQuery {
  /**
   * Push a follow-up message into the active query. Pass `imageBlocks` to
   * send a multimodal message (text + images) rather than text-only. Empty
   * or omitted `imageBlocks` falls back to a text-only message.
   */
  push(message: string, imageBlocks?: ImageContentBlock[]): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
