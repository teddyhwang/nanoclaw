/**
 * LLM-based message router
 *
 * Classifies incoming messages as either "dev" (code/config changes → pi)
 * or "assistant" (normal requests → container agent).
 *
 * Uses a keyword heuristic first for speed, falls back to a fast Haiku
 * call for ambiguous messages.
 */

import http from 'http';
import { spawn } from 'child_process';
import { logger } from './logger.js';
const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);

export type RouteDecision = 'dev' | 'assistant';

// Track whether the last message in a chat was routed to dev
// Reset when a message routes to assistant
const lastRouteWasDev = new Map<string, boolean>();

export function markDevRoute(chatJid: string) {
  lastRouteWasDev.set(chatJid, true);
}

export function markAssistantRoute(chatJid: string) {
  lastRouteWasDev.set(chatJid, false);
}

export function isInDevContext(chatJid: string): boolean {
  return lastRouteWasDev.get(chatJid) === true;
}

// Keywords that strongly suggest a dev/config message
const DEV_KEYWORDS = [
  /\b(modify|change|update|edit|fix|add|remove|install|uninstall|configure|setup|set up)\b.*\b(bot|nanoclaw|optimus|code|config|setting|skill|container|docker|extension|watcher|service|cron|schedule|alarm|security system)\b/i,
  /\b(bot|nanoclaw|optimus|code|config|setting|skill|container|docker|extension|watcher|service)\b.*\b(modify|change|update|edit|fix|add|remove|install|uninstall|configure|setup|broken|bug|error|crash)\b/i,
  /\b(rebuild|restart|redeploy|deploy|build)\b/i,
  /\b(the bot|yourself|your code|your config|your settings|your memory)\b/i,
  /\bdev\b/i,
  /\b\/dev\b/i,
];

// Keywords that strongly suggest a normal assistant message
const ASSISTANT_KEYWORDS = [
  /\b(what'?s|how'?s|tell me|show me|find|search|look up|remind|schedule|check)\b.*\b(weather|calendar|email|gmail|time|news|event|meeting|task|light|temperature|alarm|security|security system)\b/i,
  /\b(turn|toggle|switch)\b.*\b(on|off|light|lamp|fan|blind)\b/i,
  /\b(send|write|draft|reply)\b.*\b(email|message|text)\b/i,
  /\b(is|are)\b.*\b(alarm|security|security system|light|lights|lamp|fan)\b.*\b(on|off|armed|disarmed)\b/i,
  /\b(good morning|good night|hey|hi|hello|thanks|thank you)\b/i,
  /\b(what time|what day|what date)\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function classifyByKeywords(text: string): RouteDecision | null {
  const isDev = matchesAny(text, DEV_KEYWORDS);
  const isAssistant = matchesAny(text, ASSISTANT_KEYWORDS);

  // Clear signal in one direction
  if (isDev && !isAssistant) return 'dev';
  if (isAssistant && !isDev) return 'assistant';

  // Both or neither — ambiguous, need LLM
  return null;
}

export async function classifyWithLLM(text: string): Promise<RouteDecision> {
  const prompt = `Classify this message as either "dev" or "assistant".

"dev" = the user wants to modify the bot's code, configuration, infrastructure, settings, extensions, skills, or anything about how the bot works.
"assistant" = the user wants the bot to help them with a task, answer a question, control devices, check email/calendar, or anything a personal assistant would do.

Message: "${text}"

Reply with exactly one word: dev or assistant`;

  try {
    const response = await callHaiku(prompt);
    return normalizeDecision(response);
  } catch (err) {
    logger.warn(
      { err },
      'LLM router: Anthropic classification failed, retrying with OpenAI mini',
    );
    try {
      const response = await callOpenAIMiniViaPi(prompt);
      return normalizeDecision(response);
    } catch (fallbackErr) {
      logger.warn(
        { err: fallbackErr },
        'LLM router: OpenAI fallback failed, defaulting to assistant',
      );
      return 'assistant';
    }
  }
}

export async function classifyMessage(
  text: string,
  chatJid?: string,
): Promise<RouteDecision> {
  // Explicit /dev prefix always routes to dev
  if (text.trim().startsWith('/dev')) return 'dev';

  // Try keyword heuristic first so obvious assistant requests don't get
  // hijacked just because the previous message was a dev task.
  const keywordResult = classifyByKeywords(text);
  if (keywordResult) {
    logger.debug(
      { route: keywordResult, method: 'keywords' },
      'Message classified',
    );
    return keywordResult;
  }

  // Short messages (< 30 chars) in an active dev context continue to dev
  // This handles replies like "no", "yes", "testing", "try again", etc.
  if (chatJid && text.trim().length < 30 && isInDevContext(chatJid)) {
    logger.debug(
      { route: 'dev', method: 'context' },
      'Short message in dev context',
    );
    return 'dev';
  }

  // If in active dev context, bias towards dev for ambiguous messages
  if (chatJid && isInDevContext(chatJid)) {
    logger.debug(
      { route: 'dev', method: 'context-bias' },
      'Ambiguous message in dev context',
    );
    return 'dev';
  }

  // Ambiguous — fall back to LLM
  logger.debug('Message ambiguous, using LLM classification');
  const llmResult = await classifyWithLLM(text);
  logger.info({ route: llmResult, method: 'llm' }, 'Message classified');
  return llmResult;
}

function normalizeDecision(response: string): RouteDecision {
  const decision = response.trim().toLowerCase();
  if (decision === 'dev' || decision === 'assistant') return decision;
  if (decision.includes('dev')) return 'dev';
  return 'assistant';
}

function callHaiku(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-20250514',
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: CREDENTIAL_PROXY_PORT,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.content?.[0]?.text) {
              resolve(parsed.content[0].text);
            } else {
              reject(new Error(`Unexpected response: ${data.slice(0, 200)}`));
            }
          } catch {
            reject(
              new Error(`Failed to parse response: ${data.slice(0, 200)}`),
            );
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Anthropic classification timed out'));
    });

    req.write(body);
    req.end();
  });
}

function callOpenAIMiniViaPi(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'pi',
      [
        '--mode',
        'rpc',
        '--no-session',
        '--provider',
        'openai-codex',
        '--model',
        'gpt-5.4-mini',
      ],
      {
        cwd: '/tmp',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );

    let stdoutBuffer = '';
    let responseText = '';
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.kill('SIGTERM');
      if (err) reject(err);
      else resolve(responseText);
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const type = event.type as string;
          if (type === 'message_update') {
            const assistantEvent = event.assistantMessageEvent as
              | Record<string, unknown>
              | undefined;
            if (assistantEvent?.type === 'text_delta') {
              responseText += String(assistantEvent.delta || '');
            }
          }
          if (type === 'agent_end') {
            finish();
            return;
          }
          if (
            type === 'response' &&
            event.command === 'prompt' &&
            event.success === false
          ) {
            finish(new Error(`OpenAI prompt failed: ${JSON.stringify(event)}`));
            return;
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => finish(err));
    proc.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(
          new Error(
            `OpenAI classifier exited with code ${code}: ${stderr.slice(0, 200)}`,
          ),
        );
      }
    });

    const timeout = setTimeout(() => {
      finish(new Error('OpenAI classification timed out'));
    }, 12000);

    proc.stdin.write(
      JSON.stringify({ id: 'classify-1', type: 'prompt', message: prompt }) +
        '\n',
    );
  });
}
