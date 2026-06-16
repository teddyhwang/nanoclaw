import fs from 'fs';
import os from 'os';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight, touchHeartbeat } from '../db/connection.js';
import { clearContinuationStartedAt, getContinuationStartedAt } from '../db/session-state.js';
import { resolvePressureThresholdTokens } from '../pressure-rotation.js';
import { evaluateRotation } from '../session-rotation.js';
import { EMPTY_STATS, type SessionStats } from '../session-stats.js';
import { TIMEZONE } from '../timezone.js';
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
const INTERNAL_BLOCK_RE = /<internal>[\s\S]*?<\/internal>/g;

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

  return parts.length > 0 ? parts.join('\n') : null;
}

export function selectResultTextForDelivery(
  resultText: string | null,
  lastAssistantTextWithMessage: string | null,
): string | null {
  if (resultText && MESSAGE_BLOCK_RE.test(resultText)) return resultText;

  const publicResultText = (resultText ?? '').replace(INTERNAL_BLOCK_RE, '').trim();
  if (!publicResultText && lastAssistantTextWithMessage) {
    return lastAssistantTextWithMessage;
  }

  return resultText;
}

export function isRetryableClaudeApiRateLimitResult(resultText: string | null): boolean {
  if (!resultText) return false;
  const text = resultText.toLowerCase();
  if (!/\b(api error|request rejected|429|quota|exceeded)\b/.test(text)) return false;
  return (
    /\b429\b/.test(text) ||
    text.includes("exceed your account's rate limit") ||
    text.includes('exceeded your current quota') ||
    text.includes('quota exceeded') ||
    text.includes('request rejected')
  );
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

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

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
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

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  touchHeartbeat();
  return { continue: true };
};

/**
 * Read a Claude transcript .jsonl, render a markdown summary, and drop it into
 * the agent's `conversations/` folder so context survives a compaction or a
 * session rotation. Best-effort: returns false (and logs) on any failure.
 */
function archiveTranscriptFile(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  assistantName?: string,
): boolean {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return false;

    // Try to get summary from sessions index
    let summary: string | undefined;
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        summary = index.entries?.find(
          (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
        )?.summary;
      } catch {
        /* ignore */
      }
    }

    const name = summary
      ? summary
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 50)
      : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
    fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
    log(`Archived conversation to ${filename}`);
    return true;
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveTranscriptFile(preCompact.transcript_path, preCompact.session_id, assistantName);
    return {};
  };
}

// ── Continuation rotation (cold-resume guard) ──

/**
 * Resume cost is dominated by transcript size. Past this many bytes a fresh
 * cold container can't reload the .jsonl before the host's 30-min idle ceiling
 * fires, so the session is dropped and started clean. Operator-overridable.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/**
 * Secondary age trigger, measured from the transcript's first entry. 0 (or a
 * non-positive value) disables the age check; size alone then governs.
 */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; size alone governs.
  return days > 0 ? days * 86_400_000 : Infinity;
}

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * Locate the .jsonl backing a session id. The SDK names project dirs by a
 * mangled cwd; rather than reproduce that convention we scan project dirs for
 * `<sessionId>.jsonl` (session ids are UUIDs, so this is unambiguous).
 */
function findTranscriptPath(sessionId: string): string | null {
  const projects = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      const ts = JSON.parse(firstLine)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
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
    MCP_TIMEOUT: inherited.MCP_TIMEOUT ?? MCP_TIMEOUT,
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
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      // Bound MCP tool calls / connections so a hung MCP server can't wedge
      // the turn. A host/operator override in options.env still wins.
      ...mcpTimeoutEnv(options.env),
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

  /**
   * Decide whether to drop the current continuation before resuming. Combines
   * upstream's reactive size/age guard with our day-aware drift-prevention
   * evaluator (`session-rotation.ts`) so both failure modes are covered:
   *
   * 1. Cold-resume hang — transcript too large (>12 MB default) or too old
   *    (>14 d default) for the SDK to reload before the host's idle ceiling
   *    fires. Operator-overridable via `CLAUDE_TRANSCRIPT_ROTATE_BYTES` /
   *    `CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS`.
   *
   * 2. Post-compact content drift — v1 ai-friends 2026-04-16 incident
   *    (4 days / 2+ compacts / 7.6 MB → post-compact hallucination). The
   *    day-aware evaluator catches this before the cold-resume threshold
   *    by scanning for `isCompactSummary:true` markers and tripping at
   *    much smaller sizes (2 MB) once the day boundary (04:00 local) has
   *    crossed. Same-day sessions never rotate — mid-chat rotation
   *    destroys conversation continuity.
   *
   * Returns a non-null reason string to tell the poll-loop to clear the
   * continuation (and accompanying started-at marker). The transcript is
   * archived as a readable markdown summary and renamed aside before this
   * method returns so the SDK starts a fresh session and the disk is
   * reclaimed.
   *
   * Best-effort: any file-system error returns null (no rotation) so a
   * malformed transcript never blocks message processing.
   */
  maybeRotateContinuation(continuation: string): string | null {
    const transcriptPath = findTranscriptPath(continuation);
    if (!transcriptPath) return null;

    let reason: string | null = null;

    // Reactive cold-resume guard (upstream).
    let size: number | null = null;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      size = null;
    }
    if (size !== null) {
      const maxBytes = transcriptRotateBytes();
      const startMs = transcriptStartMs(transcriptPath);
      const ageMs = startMs === null ? 0 : Date.now() - startMs;
      const maxAgeMs = transcriptRotateAgeMs();
      if (size > maxBytes) {
        reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
      } else if (startMs !== null && ageMs > maxAgeMs) {
        reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
      }
    }

    // Preemptive day-aware drift guard (Optimus fork). Only consulted when
    // the cold-resume guard didn't already fire — there's no point doing the
    // heavier compact-scan if we're rotating anyway. Reading startedAt is
    // best-effort — boot-time / test contexts without an initialized session
    // DB degrade to the disk-evidence-only branch.
    if (!reason) {
      const stats = readClaudeSessionStats(continuation);
      let startedAt: string | undefined;
      try {
        startedAt = getContinuationStartedAt('claude');
      } catch {
        startedAt = undefined;
      }
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
        reason = decision.reason;
      }
    }

    if (!reason) return null;

    // Preserve a readable summary, then move the heavy .jsonl out of the
    // resume path so the SDK starts a fresh session and the disk is reclaimed.
    archiveTranscriptFile(transcriptPath, continuation, this.assistantName);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (err) {
      log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Clear started-at alongside the continuation (poll-loop clears
    // continuation itself). Best-effort — guarded so tests / boot-time
    // contexts without an initialized session DB still get the rotation
    // decision back.
    try {
      clearContinuationStartedAt('claude');
    } catch (err) {
      log(
        `clearContinuationStartedAt failed (likely no session DB yet): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return reason;
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt, input.imageBlocks);

    const instructions = input.systemContext?.instructions;

    // Per-spawn model override. Set by the host via container env when a
    // plugin (e.g. Optimus' maintenance-task) wants the SDK to run on a
    // different model than the SDK default — typically a cheaper "dream
    // model" for nightly maintenance work. NANOCLAW_AGENT_MODEL is the
    // host-controlled name; the SDK also reads ANTHROPIC_MODEL natively
    // so we accept either, preferring ours.
    const modelOverride = process.env.NANOCLAW_AGENT_MODEL || process.env.ANTHROPIC_MODEL;

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
        allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: modelOverride || this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        mcpServers: this.mcpServers,
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
      let lastAssistantTextWithMessage: string | null = null;
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
          const assistantText = extractAssistantText(message);
          if (assistantText && MESSAGE_BLOCK_RE.test(assistantText)) {
            lastAssistantTextWithMessage = assistantText;
          }
        } else if (message.type === 'result') {
          const rawText = 'result' in message ? ((message as { result?: string }).result ?? null) : null;
          if (isRetryableClaudeApiRateLimitResult(rawText)) {
            yield {
              type: 'error',
              message: rawText ?? 'Claude API rate limit',
              retryable: true,
              classification: 'quota',
            };
            continue;
          }
          const text = selectResultTextForDelivery(rawText, lastAssistantTextWithMessage);
          lastAssistantTextWithMessage = null;
          yield { type: 'result', text, tokensUsed: lastContextTokens };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: true, classification: 'quota' };
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

registerProvider('claude', (opts) => new ClaudeProvider(opts));
