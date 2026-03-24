/**
 * Dev Agent Daemon
 *
 * Runs pi in RPC mode as a background process. Watches the pi-queue
 * for messages forwarded from Discord, sends them to pi via the RPC
 * protocol, and writes responses to the pi-outbox for NanoClaw to
 * send back through Discord.
 *
 * Run as: npx tsx src/dev-agent.ts
 * Or via launchd for persistent operation.
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const QUEUE_DIR = path.join(os.homedir(), '.config', 'nanoclaw', 'pi-queue');
const OUTBOX_DIR = path.join(os.homedir(), '.config', 'nanoclaw', 'pi-outbox');
const SESSION_DIR = path.join(process.cwd(), '.pi', 'dev-session');
const LOG_DIR = path.join(process.cwd(), 'logs');
const DB_DIR = path.join(process.cwd(), 'db');
const STATE_FILE = path.join(DB_DIR, 'dev-agent-state.json');
const LEGACY_STATE_FILE = path.join(LOG_DIR, 'dev-agent-state.json');
const RPC_TRACE_LOG = path.join(LOG_DIR, 'dev-agent.rpc.jsonl');
const POLL_MS = 500;
const PROJECT_DIR = process.cwd();
const PRIMARY_MODEL = {
  provider: 'anthropic',
  modelId: 'claude-opus-4-6',
};
const FALLBACK_MODEL = {
  provider: 'openai-codex',
  modelId: 'gpt-5.4',
};

// Track state
let piProcess: ChildProcess | null = null;
let isStreaming = false;
let currentChatJid: string | null = null;
let responseBuffer = '';
let currentRouteModel = PRIMARY_MODEL;
let activePrompt: {
  id: string;
  sourceFile?: string;
  chatJid: string | null;
  message: string;
  retriedWithFallback: boolean;
  startedAt: number;
  queuedAs: 'prompt' | 'follow_up';
} | null = null;
let pendingRetryAfterModelSwitch = false;
let fallbackSwitchInProgress = false;
let forceFallbackUntil: string | null = null;
let sendDiscordUsedInCurrentRun = false;
let stdoutBufferRemainder = '';
let textDeltaCount = 0;

function log(msg: string) {
  const ts = new Date().toISOString();
  console.error(`[dev-agent ${ts}] ${msg}`);
}

function trace(kind: string, data: Record<string, unknown>) {
  try {
    fs.appendFileSync(
      RPC_TRACE_LOG,
      JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n',
    );
  } catch {
    // ignore trace write failures
  }
}

function summarize(text: string, max = 160) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function ensureDirs() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function loadState() {
  try {
    const statePath = fs.existsSync(STATE_FILE)
      ? STATE_FILE
      : fs.existsSync(LEGACY_STATE_FILE)
        ? LEGACY_STATE_FILE
        : STATE_FILE;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
      forceFallbackUntil?: string | null;
    };
    forceFallbackUntil = state.forceFallbackUntil || null;

    if (statePath === LEGACY_STATE_FILE) {
      saveState();
      try {
        fs.unlinkSync(LEGACY_STATE_FILE);
      } catch {
        // ignore cleanup failures
      }
    }
  } catch {
    forceFallbackUntil = null;
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ forceFallbackUntil }, null, 2),
    );
  } catch {
    // ignore state write failures
  }
}

function isForceFallbackActive() {
  return Boolean(
    forceFallbackUntil && new Date(forceFallbackUntil).getTime() > Date.now(),
  );
}

function clearForceFallbackIfExpired() {
  if (
    forceFallbackUntil &&
    new Date(forceFallbackUntil).getTime() <= Date.now()
  ) {
    log(
      `Fallback window expired at ${forceFallbackUntil}; returning to primary model`,
    );
    forceFallbackUntil = null;
    saveState();
  }
}

function startPi(): ChildProcess {
  clearForceFallbackIfExpired();
  const initialModel = isForceFallbackActive() ? FALLBACK_MODEL : PRIMARY_MODEL;
  log(
    `Starting pi in RPC mode (session: ${SESSION_DIR}, model: ${initialModel.provider}/${initialModel.modelId})`,
  );

  currentRouteModel = initialModel;
  activePrompt = null;
  pendingRetryAfterModelSwitch = false;
  fallbackSwitchInProgress = false;
  sendDiscordUsedInCurrentRun = false;

  const proc = spawn(
    'pi',
    [
      '--mode',
      'rpc',
      '--session-dir',
      SESSION_DIR,
      '--provider',
      initialModel.provider,
      '--model',
      initialModel.modelId,
    ],
    {
      cwd: PROJECT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );

  proc.stdout!.on('data', (chunk: Buffer) => {
    stdoutBufferRemainder += chunk.toString();
    const lines = stdoutBufferRemainder.split('\n');
    stdoutBufferRemainder = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        trace('rpc_event', { event });
        handlePiEvent(event);
      } catch {
        log(`pi stdout (non-json): ${summarize(line, 240)}`);
        trace('rpc_stdout_non_json', { line });
      }
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      log(`[pi stderr] ${text}`);
      trace('rpc_stderr', { text });
    }
  });

  proc.on('exit', (code) => {
    log(`Pi process exited with code ${code}, restarting in 5s...`);
    piProcess = null;
    isStreaming = false;
    setTimeout(() => {
      piProcess = startPi();
    }, 5000);
  });

  proc.on('error', (err) => {
    log(`Pi process error: ${err.message}`);
  });

  setTimeout(() => {
    sendToPi({ type: 'set_auto_retry', enabled: true });
  }, 1000);

  return proc;
}

function sendToPi(command: Record<string, unknown>) {
  if (!piProcess?.stdin?.writable) {
    log(`Pi process not ready, dropping command: ${JSON.stringify(command)}`);
    trace('rpc_command_dropped', { command });
    return;
  }
  const json = JSON.stringify(command);
  log(`→ pi: ${summarize(json, 220)}`);
  trace('rpc_command', { command });
  piProcess.stdin.write(json + '\n');
}

function handlePiEvent(event: Record<string, unknown>) {
  const type = event.type as string;

  if (type === 'response') {
    const cmd = event.command as string;
    const success = event.success as boolean;
    log(`← pi response: ${cmd} success=${success}`);
    trace('rpc_response', { command: cmd, success, event });

    if ((cmd === 'prompt' || cmd === 'follow_up') && success) {
      isStreaming = true;
    }
    if (cmd === 'set_model' && success) {
      const data = (event.data || {}) as Record<string, unknown>;
      currentRouteModel = {
        provider: (data.provider as string) || currentRouteModel.provider,
        modelId: (data.id as string) || currentRouteModel.modelId,
      };
      log(
        `Active model: ${currentRouteModel.provider}/${currentRouteModel.modelId}`,
      );
      if (pendingRetryAfterModelSwitch && activePrompt) {
        pendingRetryAfterModelSwitch = false;
        fallbackSwitchInProgress = false;
        const retryMessage = activePrompt.message;
        log(`Retrying prompt on fallback model: ${retryMessage.slice(0, 120)}`);
        sendToPi({
          type: 'prompt',
          message: retryMessage,
          streamingBehavior: 'followUp',
        });
      }
    }
    return;
  }

  const eventType =
    type === 'event'
      ? ((event.event as Record<string, unknown> | undefined)?.type as
          | string
          | undefined)
      : type;
  const payload =
    type === 'event'
      ? (event.event as Record<string, unknown> | undefined) || {}
      : event;

  if (!eventType) return;

  if (eventType === 'agent_end') {
    const messages =
      (payload.messages as Array<Record<string, unknown>> | undefined) || [];
    const lastMessage = messages[messages.length - 1];
    const stopReason = (lastMessage?.stopReason as string | undefined) || '';
    const errorMessage = String(lastMessage?.errorMessage || '');
    const endedWithThrottleError =
      stopReason === 'error' && isThrottleError(errorMessage);

    log(
      `agent_end prompt=${activePrompt?.id || 'none'} model=${currentRouteModel.provider}/${currentRouteModel.modelId} textDeltas=${textDeltaCount} bufferChars=${responseBuffer.length} stopReason=${stopReason || 'unknown'}`,
    );
    trace('agent_end', {
      activePrompt,
      model: currentRouteModel,
      textDeltaCount,
      responseBufferLength: responseBuffer.length,
      stopReason,
      errorMessage,
    });
    isStreaming = false;
    textDeltaCount = 0;

    if (
      responseBuffer.trim() &&
      currentChatJid &&
      !sendDiscordUsedInCurrentRun
    ) {
      writeOutbox(currentChatJid, `⚙️ ${responseBuffer.trim()}`);
      responseBuffer = '';
      activePrompt = null;
      return;
    }

    responseBuffer = '';
    sendDiscordUsedInCurrentRun = false;

    if (!endedWithThrottleError) {
      activePrompt = null;
    }
    return;
  }

  if (eventType === 'message_update') {
    const assistantEvent = payload.assistantMessageEvent as
      | Record<string, unknown>
      | undefined;
    if (assistantEvent?.type === 'text_delta') {
      responseBuffer += assistantEvent.delta as string;
      textDeltaCount += 1;
      if (textDeltaCount === 1 || textDeltaCount % 25 === 0) {
        log(
          `assistant stream prompt=${activePrompt?.id || 'none'} deltas=${textDeltaCount} chars=${responseBuffer.length}`,
        );
      }
    }
    return;
  }

  if (eventType === 'message_start') {
    const msg = payload.message as Record<string, unknown> | undefined;
    if (msg?.role === 'assistant') {
      responseBuffer = '';
      textDeltaCount = 0;
      log(`assistant message_start prompt=${activePrompt?.id || 'none'}`);
    }
    return;
  }

  if (eventType === 'tool_execution_start') {
    const toolName = payload.toolName as string;
    if (toolName === 'send_discord') {
      responseBuffer = '';
      sendDiscordUsedInCurrentRun = true;
    }
    return;
  }

  if (eventType === 'auto_retry_start') {
    const errorMessage = String(payload.errorMessage || '');
    log(
      `Auto-retry starting on ${currentRouteModel.provider}/${currentRouteModel.modelId}: ${errorMessage}`,
    );

    if (
      activePrompt &&
      !activePrompt.retriedWithFallback &&
      !fallbackSwitchInProgress &&
      currentRouteModel.provider === PRIMARY_MODEL.provider &&
      currentRouteModel.modelId === PRIMARY_MODEL.modelId &&
      isThrottleError(errorMessage)
    ) {
      activePrompt.retriedWithFallback = true;
      fallbackSwitchInProgress = true;
      sendToPi({ type: 'abort_retry' });
      switchToFallbackAndRetry();
    }
    return;
  }

  if (eventType === 'auto_retry_end') {
    const success = Boolean(payload.success);
    if (success) return;

    const finalError = String(payload.finalError || '');
    log(
      `Auto-retry exhausted: ${finalError} | activePrompt=${Boolean(activePrompt)} | model=${currentRouteModel.provider}/${currentRouteModel.modelId} | fallbackSwitchInProgress=${fallbackSwitchInProgress}`,
    );

    // Expected when we intentionally abort Anthropic retry after first throttle signal.
    // Do not treat this as a terminal failure — wait for set_model success, then retry on fallback.
    if (fallbackSwitchInProgress && finalError === 'Retry cancelled') {
      return;
    }

    if (
      activePrompt &&
      !activePrompt.retriedWithFallback &&
      currentRouteModel.provider === PRIMARY_MODEL.provider &&
      currentRouteModel.modelId === PRIMARY_MODEL.modelId &&
      isThrottleError(finalError)
    ) {
      activePrompt.retriedWithFallback = true;
      switchToFallbackAndRetry();
      return;
    }

    if (activePrompt?.chatJid) {
      writeOutbox(
        activePrompt.chatJid,
        `⚙️ Dev session hit a provider error and couldn't recover automatically: ${finalError || 'unknown error'}`,
      );
    }
    isStreaming = false;
    activePrompt = null;
    responseBuffer = '';
    fallbackSwitchInProgress = false;
  }
}

function writeOutbox(chatJid: string, message: string) {
  const outFile = path.join(OUTBOX_DIR, `${Date.now()}-reply.json`);
  fs.writeFileSync(outFile, JSON.stringify({ chatJid, message }));
  log(`Wrote outbox: ${summarize(message, 100)}`);
  trace('outbox_write', { chatJid, outFile, message: summarize(message, 300) });
}

function isThrottleError(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes('429') ||
    normalized.includes('529') ||
    normalized.includes('rate limit') ||
    normalized.includes('rate_limit') ||
    normalized.includes('throttle') ||
    normalized.includes('overloaded')
  );
}

function detectAnthropicResetTime(): string | null {
  try {
    const probe = spawnSync('claude', ['-p', 'hello?'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env },
    });
    const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    trace('anthropic_probe', {
      status: probe.status,
      output: summarize(output, 500),
    });

    const m = output.match(
      /resets\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm))\s*\(([^)]+)\)/i,
    );
    if (!m) return null;
    const timeText = m[1].trim();
    const tz = m[2].trim();

    const py = spawnSync(
      'python3',
      [
        '-c',
        `
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import sys,re
now = datetime.now(ZoneInfo(sys.argv[2]))
t = sys.argv[1].strip().lower()
m = re.match(r'^(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)$', t)
if not m:
    raise SystemExit(1)
h = int(m.group(1)) % 12
minute = int(m.group(2) or '0')
if m.group(3) == 'pm':
    h += 12
candidate = now.replace(hour=h, minute=minute, second=0, microsecond=0)
if candidate <= now:
    candidate = candidate + timedelta(days=1)
print(candidate.isoformat())
`,
        timeText,
        tz,
      ],
      { encoding: 'utf-8', timeout: 5000 },
    );
    const iso = (py.stdout || '').trim();
    return iso || null;
  } catch (err) {
    trace('anthropic_probe_error', { error: String(err) });
    return null;
  }
}

function maybeSwitchBackToPrimary() {
  clearForceFallbackIfExpired();
  if (
    !isForceFallbackActive() &&
    currentRouteModel.provider === FALLBACK_MODEL.provider &&
    currentRouteModel.modelId === FALLBACK_MODEL.modelId &&
    !fallbackSwitchInProgress &&
    !isStreaming
  ) {
    log(
      `Fallback window ended; switching back to ${PRIMARY_MODEL.provider}/${PRIMARY_MODEL.modelId}`,
    );
    sendToPi({
      type: 'set_model',
      provider: PRIMARY_MODEL.provider,
      modelId: PRIMARY_MODEL.modelId,
    });
  }
}

function switchToFallbackAndRetry() {
  if (!activePrompt) return;

  const resetAt = detectAnthropicResetTime();
  if (resetAt) {
    forceFallbackUntil = resetAt;
    saveState();
    log(
      `Anthropic limit reset detected at ${resetAt}; forcing fallback until then`,
    );
  }

  log(
    `Switching to fallback model ${FALLBACK_MODEL.provider}/${FALLBACK_MODEL.modelId} after throttling`,
  );
  writeOutbox(
    activePrompt.chatJid || 'dc:1485414819614949377',
    resetAt
      ? `⚙️ Anthropic is throttling right now — switching dev session to ${FALLBACK_MODEL.modelId} until ${resetAt} and retrying.`
      : `⚙️ Anthropic is throttling right now — switching dev session to ${FALLBACK_MODEL.modelId} and retrying.`,
  );
  isStreaming = false;
  responseBuffer = '';
  pendingRetryAfterModelSwitch = true;
  sendToPi({
    type: 'set_model',
    provider: FALLBACK_MODEL.provider,
    modelId: FALLBACK_MODEL.modelId,
  });
}

function drainQueue() {
  try {
    maybeSwitchBackToPrimary();
    const files = fs
      .readdirSync(QUEUE_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    if (files.length > 0) {
      log(
        `Queue poll found ${files.length} file(s); isStreaming=${isStreaming}`,
      );
      trace('queue_poll', {
        files,
        isStreaming,
        activePrompt,
        forceFallbackUntil,
        currentRouteModel,
      });
    }

    if (
      files.length > 0 &&
      isForceFallbackActive() &&
      currentRouteModel.provider !== FALLBACK_MODEL.provider &&
      !isStreaming
    ) {
      log(
        `Force-fallback active until ${forceFallbackUntil}; switching to fallback before processing queue`,
      );
      sendToPi({
        type: 'set_model',
        provider: FALLBACK_MODEL.provider,
        modelId: FALLBACK_MODEL.modelId,
      });
      return;
    }

    for (const file of files) {
      const filePath = path.join(QUEUE_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);

        const sender = data.senderName || data.sender || 'Unknown';
        const content = data.content || '';
        currentChatJid = data.chatJid || null;

        if (!content) continue;

        const prompt = `[Discord /dev from ${sender}]: ${content}`;
        const promptId = crypto.randomUUID().slice(0, 8);
        const queuedAs = isStreaming ? 'follow_up' : 'prompt';
        log(
          `Processing prompt=${promptId} queuedAs=${queuedAs} chat=${currentChatJid} text=${summarize(prompt, 100)}`,
        );
        trace('queue_dequeue', {
          promptId,
          queuedAs,
          file,
          filePath,
          chatJid: currentChatJid,
          prompt,
          isStreaming,
        });

        activePrompt = {
          id: promptId,
          sourceFile: file,
          chatJid: currentChatJid,
          message: prompt,
          retriedWithFallback: false,
          startedAt: Date.now(),
          queuedAs,
        };
        sendDiscordUsedInCurrentRun = false;

        if (isStreaming) {
          sendToPi({
            id: promptId,
            type: 'follow_up',
            message: prompt,
          });
        } else {
          sendToPi({
            id: promptId,
            type: 'prompt',
            message: prompt,
          });
        }
      } catch (err) {
        log(`Failed to process queue file ${file}: ${err}`);
        trace('queue_error', { file, error: String(err) });
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    // Queue dir might not exist yet
  }
}

// Main
ensureDirs();
loadState();
piProcess = startPi();

// Wait a moment for pi to initialize, then start polling
setTimeout(() => {
  log('Starting queue poll');
  setInterval(drainQueue, POLL_MS);
}, 3000);

// Handle shutdown
process.on('SIGTERM', () => {
  log('Shutting down...');
  if (piProcess) {
    sendToPi({ type: 'abort' });
    piProcess.kill('SIGTERM');
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Interrupted, shutting down...');
  if (piProcess) piProcess.kill('SIGTERM');
  process.exit(0);
});
