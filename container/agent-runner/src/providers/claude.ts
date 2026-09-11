import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { isAwaitingSensitiveConfirmation, noteToolResult } from '../confirmation-gate-state.js';
import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/container-state.js';
import { clearContinuationStartedAt, getContinuationStartedAt } from '../db/session-state.js';
import { touchHeartbeat } from '../heartbeat.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolvePressureThresholdTokens } from '../pressure-rotation.js';
import { EMPTY_STATS, type SessionStats } from '../session-stats.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import type { ResolvedRuntimeConfiguration } from '../provider-contracts/registry.js';
// The execution-policy, inference, MCP, and memory derivations live in
// claude-config.ts. The runtime contract (provider-contracts/claude.ts)
// declares them; core calls them and hands the results to this provider's
// constructor and registerMemorySessionHook. This module never imports the
// contract — registration is two-step so it compiles on a core without one.
import {
  SDK_DISALLOWED_TOOLS,
  type resolveClaudeExecutionPolicy,
  type resolveClaudeInference,
  type resolveClaudeMcpServers,
  type resolveClaudeMemoryRuntime,
} from './claude-config.js';
// Transcript archiving and rotation are this provider's own concern: both
// read the SDK's on-disk .jsonl, which no other provider has.
import { archiveClaudeTranscript, rotateClaudeContinuation } from './claude-history.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ImageContentBlock,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

const MESSAGE_BLOCK_RE = /<message\s+[^>]*\bto="[^"]+"[^>]*>[\s\S]*?<\/message>/;

export function extractAssistantText(message: unknown): string | null {
  const maybeMessage = message as {
    message?: { content?: unknown };
    content?: unknown;
  };
  const content = maybeMessage.message?.content ?? maybeMessage.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts = content
    .map((block) => {
      if (!block || typeof block !== 'object') return null;
      const maybeText = block as { type?: string; text?: unknown };
      if (maybeText.type !== 'text' || typeof maybeText.text !== 'string') return null;
      return maybeText.text;
    })
    .filter((text): text is string => !!text);

  // The SDK result reports an assistant message's text blocks as adjacent
  // output. Join with no invented separator so streamed text is byte-for-byte
  // aligned with that result-door containment premise.
  return parts.length > 0 ? parts.join('') : null;
}

export function isRetryableClaudeApiRateLimitResult(resultText: string | null): boolean {
  if (!resultText) return false;
  const text = resultText.toLowerCase();
  return (
    /\b429\b/.test(text) ||
    text.includes('usage limit') ||
    text.includes("exceed your account's rate limit") ||
    text.includes('rate limit exceeded') ||
    text.includes('exceeded your current quota') ||
    text.includes('quota exceeded')
  );
}

export interface SdkRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  errorCode?: string;
  overageDisabledReason?: string;
  overageStatus?: string;
}

export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected' && info?.overageStatus !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  let detail = '';
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    detail = ` (resets ${new Date(ms).toISOString()})`;
  }
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
}

export function isRejectedClaudeRateLimitEvent(message: unknown): boolean {
  return classifyRateLimitEvent((message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info) !== null;
}

export { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './claude-config.js';

interface SDKUserMessage {
  type: 'user';
  // content accepts plain text OR an array of multimodal blocks (text + image).
  // The Anthropic SDK's MessageParam.content is `string | Array<ContentBlockParam>`;
  // we mirror that here so MessageStream.push can emit multimodal user turns
  // when inbound chat attachments are present.
  message: {
    role: 'user';
    content: string | Array<{ type: 'text'; text: string } | ImageContentBlock>;
  };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  /**
   * Push a user message into the stream. When `imageBlocks` is non-empty,
   * the message content is `[{type:'text', text}, ...imageBlocks]` —
   * Anthropic's multimodal shape — so the model sees the text and images
   * as a single user turn. With no blocks, falls back to plain text content
   * for back-compat with all existing call sites.
   */
  push(text: string, imageBlocks?: ImageContentBlock[]): void {
    // SDK types `MessageParam.content` as `string | Array<ContentBlockParam>`.
    // Build either form and let the SDK accept whichever matches; the inline
    // ternary's union doesn't narrow into the SDK type cleanly without a
    // cast through the message-shape constructor.
    const message =
      imageBlocks && imageBlocks.length > 0
        ? { role: 'user' as const, content: [{ type: 'text' as const, text }, ...imageBlocks] }
        : { role: 'user' as const, content: text };
    this.queue.push({
      type: 'user',
      message,
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Refresh heartbeat at tool-call boundaries so a long MCP tool that's about
  // to block (e.g. gws-docs read of a large doc) doesn't leave the heartbeat
  // stranded at its pre-call mtime and trip the absolute-ceiling kill while
  // genuine work is in flight. PostToolUse refreshes again on return.
  touchHeartbeat();
  return { continue: true };
};

/** Extract plain text from an SDK tool_response of unknown shape. */
function toolResponseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) {
    return response.map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? ''))).join(' ');
  }
  const r = response as { content?: unknown; text?: string } | null;
  if (r?.content !== undefined) return toolResponseText(r.content);
  return typeof r?.text === 'string' ? r.text : '';
}

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async (input) => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Record whether the sensitive-action gate paused this call. Testing the
  // TOOL RESULT (emitted verbatim by the gate) rather than the model's later
  // prose is what makes the addressed-silent suppression reliable — see
  // confirmation-gate-state.ts for the 2026-08-01 Boys Night false failure
  // this replaces.
  try {
    const i = input as { tool_response?: unknown };
    noteToolResult(toolResponseText(i.tool_response), isAwaitingSensitiveConfirmation);
  } catch (err) {
    log(`PostToolUse: confirmation-gate sniff failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  touchHeartbeat();
  return { continue: true };
};

/** The real clock for archive names and rotation stamps; tests hand the history functions a fixed one. */
const REAL_CLOCK = { now: () => Date.now() };

// The PreCompact hook is provider-originated: the SDK raises it from inside
// the query, and the archive it triggers reads the SDK's own transcript.
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveClaudeTranscript(
      {
        transcriptPath: preCompact.transcript_path,
        sessionId: preCompact.session_id,
        assistantName,
        log,
      },
      REAL_CLOCK,
    );
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * MCP call timeouts (ms), honored natively by the Claude Code CLI
 * (`claude.exe`, verified ≥2.1.128) which owns the MCP client connections
 * in subprocess mode. Without an explicit bound a hung MCP tool call —
 * e.g. a stdio `mcp-remote` bridge whose upstream stalls on a specific
 * request — never returns, the SDK turn blocks on it forever, and the
 * poll-loop wedges. The host watchdog only reaps it after MCP_TOOL_CEILING_MS
 * (60 min) because PreToolUse keeps refreshing the heartbeat, so the chat
 * goes silent for up to an hour (observed 2026-05-31, Cook chat: a
 * `find_pairings(["steak","butter"])` epicure call hung and froze the group).
 *
 * MCP_TOOL_TIMEOUT bounds a single tool *call*: on timeout the CLI returns an
 * error to the agent, which continues the turn and replies instead of hanging.
 * MCP_TIMEOUT bounds server *startup/connection* so an unreachable server
 * fails fast rather than stalling the turn at spawn.
 *
 * Operator-overridable via the same-named host env vars. Defaults: 120s tool
 * call (generous for legitimately slow reads like gws-docs on a large doc,
 * short enough to self-heal), 30s connect.
 */
const MCP_TOOL_TIMEOUT = process.env.MCP_TOOL_TIMEOUT || '120000';
const MCP_TIMEOUT = process.env.MCP_TIMEOUT || '30000';
const DREAM_MCP_TIMEOUT = '120000';

/**
 * Resolve the MCP timeout env vars to inject into the CLI subprocess. A value
 * already present in the inherited env (an explicit host/operator override)
 * always wins; otherwise the module default applies. Exported for testing.
 */
export function mcpTimeoutEnv(inherited: Record<string, string | undefined> = {}): {
  MCP_TOOL_TIMEOUT: string;
  MCP_TIMEOUT: string;
} {
  return {
    MCP_TOOL_TIMEOUT: inherited.MCP_TOOL_TIMEOUT ?? MCP_TOOL_TIMEOUT,
    // Every group's Dream fires in the same 04:00 wave. Under that startup
    // load, Claude's 30s default intermittently discarded otherwise healthy
    // MCP servers for the entire turn (Sameul Moolsan, 2026-08-23/25/26/27).
    // Give maintenance turns enough time to connect their critical nanoclaw
    // stdio server; keep the interactive fast-fail default unchanged.
    MCP_TIMEOUT: inherited.MCP_TIMEOUT ?? (inherited.NANOCLAW_DREAM_HARNESS ? DREAM_MCP_TIMEOUT : MCP_TIMEOUT),
  };
}

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

/**
 * The container's SDK is launched with cwd `/workspace/agent` (see
 * `agent-runner/src/index.ts`). The SDK encodes that cwd into the project
 * directory name it writes transcripts under — slashes become dashes, the
 * leading slash produces a leading dash. Hard-coded here to keep
 * `readSessionStats` a pure function of the continuation id; if the
 * container ever moves to a different cwd, update both sites.
 */
const CLAUDE_AGENT_CWD = '/workspace/agent';

function encodeProjectDir(absoluteCwd: string): string {
  return absoluteCwd.replace(/\//g, '-');
}

/**
 * Snapshot the on-disk state of the given continuation for the day-aware
 * rotation evaluator. The SDK writes each session as
 * `$HOME/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` where
 * `<encoded-cwd>` is the absolute cwd with `/` replaced by `-`.
 *
 * `compactCount` is the number of `isCompactSummary: true` synthetic user
 * turns — even one means the conversation has been summarized and is at
 * elevated drift risk on the next chained compact. Substring check before
 * any JSON parse keeps this cheap.
 *
 * Errors (missing file, permission denied, malformed jsonl) return
 * `EMPTY_STATS` so the rotation path never throws on a transcript hiccup.
 */
function readClaudeSessionStats(continuation: string): SessionStats {
  const jsonlPath = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodeProjectDir(CLAUDE_AGENT_CWD),
    `${continuation}.jsonl`,
  );
  if (!fs.existsSync(jsonlPath)) return { ...EMPTY_STATS };
  const stats: SessionStats = { ...EMPTY_STATS };
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    stats.sizeBytes = Buffer.byteLength(content, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      stats.turnCount++;
      if (line.includes('"isCompactSummary":true')) {
        stats.compactCount++;
      }
    }
  } catch {
    return { ...EMPTY_STATS };
  }
  return stats;
}

/**
 * Anthropic API usage block shape (the fields we read). Every assistant
 * message in the SDK stream carries one for its underlying model call.
 */
export interface ApiUsageShape {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/**
 * Current context footprint of a model call: prompt tokens (fresh + both
 * cache classes) plus the output appended to the thread. Undefined when
 * the usage block is absent or carries no numeric fields.
 */
export function contextTokensFromUsage(usage: ApiUsageShape | undefined): number | undefined {
  if (!usage) return undefined;
  const parts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.output_tokens,
  ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (parts.length === 0) return undefined;
  return parts.reduce((a, b) => a + b, 0);
}

export class ClaudeProvider implements AgentProvider {
  private assistantName?: string;
  private mcp: ReturnType<typeof resolveClaudeMcpServers>;
  private inference: ReturnType<typeof resolveClaudeInference>;
  private executionPolicy: ReturnType<typeof resolveClaudeExecutionPolicy>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private memorySessionHook?: MemorySessionHookRegistration;

  /**
   * `configuration` is the contract's configuration as resolved by core
   * (createProvider): execution policy, inference, and MCP servers. This
   * provider does not call the resolves itself.
   */
  constructor(options: ProviderOptions, configuration: ResolvedRuntimeConfiguration) {
    this.assistantName = options.assistantName;
    this.mcp = configuration.mcpServers as ReturnType<typeof resolveClaudeMcpServers>;
    this.additionalDirectories = options.additionalDirectories;
    this.inference = configuration.inference as ReturnType<typeof resolveClaudeInference>;
    this.executionPolicy = configuration.executionPolicy as ReturnType<typeof resolveClaudeExecutionPolicy>;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      // Bound MCP tool calls / connections so a hung MCP server can't wedge
      // the turn. A host/operator override in options.env still wins.
      ...mcpTimeoutEnv(options.env),
    };
  }

  /**
   * `memory` is the contract's resolved memory capability (the runtime env
   * that keeps the SDK's own auto-memory off). Core registers the hook before
   * any query, so the SDK sees the same env it always did.
   */
  registerMemorySessionHook(hook: MemorySessionHookRegistration, memory?: unknown): void {
    this.memorySessionHook = hook;
    this.env = {
      ...this.env,
      ...((memory as ReturnType<typeof resolveClaudeMemoryRuntime> | undefined) ?? {}),
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  /**
   * Proactive-rotation threshold for the poll-loop's pressure check:
   * default 70% of the auto-compact window (so the consolidate-then-rotate
   * handoff runs well before the SDK's own mid-turn compaction), operator-
   * overridable via PRESSURE_ROTATION_TOKENS / PRESSURE_ROTATION_RATIO.
   */
  pressureRotationTokens(): number | null {
    return resolvePressureThresholdTokens(process.env, Number(CLAUDE_CODE_AUTO_COMPACT_WINDOW));
  }

  /** Pre-resume rotation combines the cold-resume and day-aware drift guards. */
  maybeRotateContinuation(continuation: string, _cwd?: string): string | null {
    return rotateClaudeContinuation(
      {
        continuation,
        assistantName: this.assistantName,
        log,
        readSessionStats: () => readClaudeSessionStats(continuation),
      },
      REAL_CLOCK,
    );
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Claude memory session hook was not registered');
    const stream = new MessageStream();
    stream.push(input.prompt, input.imageBlocks);

    const instructions = input.systemContext?.instructions;

    // Per-spawn model override. Set by the host via container env when a
    // plugin (e.g. Optimus' maintenance-task) wants the SDK to run on a
    // different model than the SDK default — typically a cheaper "dream
    // model" for nightly maintenance work. NANOCLAW_AGENT_MODEL is the
    // host-controlled name; the SDK also reads ANTHROPIC_MODEL natively
    // so we accept either, preferring ours.
    // Constructor options are already the runner's resolved per-provider
    // model. They must win over the process-wide standing-provider env when
    // a quota fallback creates Claude inside a Codex-configured container.

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: [...this.mcp.allowedTools],
        disallowedTools: [...this.executionPolicy.disallowedTools],
        env: this.env,
        model: this.inference.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.inference.effort as any,
        permissionMode: this.executionPolicy.permissionMode,
        allowDangerouslySkipPermissions: this.executionPolicy.allowDangerouslySkipPermissions,
        settingSources: ['project', 'user', 'local'],
        // Only sent when enabled, so an install that never turns it on passes
        // exactly the options it always did. `fastMode` is a Settings member
        // rather than a query option, which is why it rides `settings`.
        ...(this.inference.settings ? { settings: this.inference.settings } : {}),
        mcpServers: this.mcp.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      let assistantTextThisTurn = '';
      // Live context size, refreshed from each assistant message's API
      // usage block. The LAST assistant call's prompt+output tokens are
      // the thread's current context footprint — attached to `result`
      // events so the poll-loop's pressure-rotation check can fire
      // BEFORE the SDK's own auto-compaction does.
      let lastContextTokens: number | undefined;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'assistant') {
          const usage = (message as { message?: { usage?: ApiUsageShape } }).message?.usage;
          const contextTokens = contextTokensFromUsage(usage);
          if (contextTokens !== undefined) lastContextTokens = contextTokens;

          // ONE text event per assistant message, with adjacent text blocks
          // joined in content order. The poll-loop assembles blocks that span
          // assistant messages and owns harness/internal stripping and echo
          // suppression; the provider only preserves the SDK stream exactly.
          const assistantText = extractAssistantText(message);
          if (assistantText) {
            // Buffer only for the legacy rate-limit outcome decision below;
            // delivery remains event-by-event through the poll-loop's assembler.
            assistantTextThisTurn += assistantText;
            yield { type: 'text', text: assistantText };
          }
        } else if (message.type === 'result') {
          // `result` text exists only on subtype:"success"; error subtypes
          // (e.g. a non-retryable 403 billing_error) carry their message in
          // `errors[]` instead. Surface either so the poll-loop can deliver a
          // billing/quota notice to the user rather than dropping the turn.
          const m = message as { result?: string; is_error?: boolean; errors?: string[] };
          const rawText = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
          const hadAssistantMessageBlock = MESSAGE_BLOCK_RE.test(assistantTextThisTurn);
          assistantTextThisTurn = '';
          if (isRetryableClaudeApiRateLimitResult(rawText)) {
            if (hadAssistantMessageBlock) {
              // Optimus historically kept an earlier wrapped answer when the
              // SDK ended on a rate-limit string. That answer has now already
              // streamed through the one content door, so emit only an empty
              // completion signal here: the turn completes without replaying
              // the block at the result door or misclassifying it as failed.
              yield { type: 'result', text: null, tokensUsed: lastContextTokens };
              continue;
            }
            yield {
              type: 'error',
              message: rawText ?? 'Claude API rate limit',
              retryable: true,
              classification: 'quota',
            };
            continue;
          }
          // Assistant text has already gone through the single mid-turn door.
          // Keep the SDK result verbatim for status/error accounting, but never
          // replay an earlier assistant <message> from this result branch.
          yield { type: 'result', text: rawText, tokensUsed: lastContextTokens, isError: m.is_error === true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'rate_limit_event') {
          // The SDK emits this whenever subscription usage INFO changes,
          // including status=allowed/allowed_warning. Only a rejected window
          // is a real quota failure eligible for cross-harness failover.
          const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
          const blocked = classifyRateLimitEvent(info);
          if (!blocked) {
            if (info?.status === 'allowed_warning') {
              log(
                `rate-limit warning: ${info.rateLimitType ?? 'window'} at ${
                  info.utilization != null ? `${Math.round(info.utilization * 100)}%` : 'high'
                } utilization`,
              );
            }
          } else {
            yield {
              type: 'error',
              message: blocked.message,
              retryable: blocked.classification === 'rate_limit',
              classification: blocked.classification,
            };
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          // compact_boundary is an SDK *lifecycle* signal ("your context
          // was just auto-compacted"), NOT an agent turn result. Yielding
          // it as `type:'result'` (the prior bug) made processQuery feed
          // "Context compacted (N tokens)." to dispatchResultText with no
          // <message> wrapper → the unwrapped-output safety-net broadcast
          // it to the channel with a [degraded] label (observed 2026-05-17
          // in AI Friends, mid-turn after the search_conversations fix:
          // user saw "[degraded — agent did not wrap reply...] Context
          // compacted (135,106 tokens compacted)." instead of the agent
          // just compacting and carrying on — which it did, the very next
          // turn). It's a status signal like task_notification below:
          // emit as `progress` so the poll loop logs it and never delivers
          // it. Compaction is transparent to the user by design.
          yield { type: 'progress', message: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg, imageBlocks) => stream.push(msg, imageBlocks),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

// Function-form registration only; the runtime contract attaches itself from
// provider-contracts/claude.ts through the same two-step path any
// skill-installed provider uses.
registerProvider('claude', (opts, configuration) => {
  if (!configuration) {
    throw new Error('Claude provider requires its runtime contract; construct it through createProvider');
  }
  return new ClaudeProvider(opts, configuration);
});
