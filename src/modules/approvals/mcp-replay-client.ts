/**
 * Engine → dashboard-server replay client (Fix B, 2026-05-18).
 *
 * After a human taps Confirm on a sensitive-action card, the engine
 * (sensitive-mcp-confirm.ts) creates the `(session,actor)` grant and
 * then POSTs the unique approval id (plus diagnostic gate fields) here.
 * Dashboard-server's `/mcp/_replay` route looks up the stashed,
 * still-bound tool callback and runs the credentialed MCP call IN ITS
 * OWN PROCESS (the grant is now satisfied) and returns the real
 * `CallToolResult`. The engine injects that result back into the agent
 * session as a system message.
 *
 * This is the deliberate, bounded host→dashboard loopback the original
 * grant-based design avoided — it is the price of making re-entry
 * provider/harness-agnostic (codex never reliably re-issued a
 * function_call after the old isError pending result; this removes the
 * model from the re-entry path entirely). It is a single localhost call
 * triggered by a human click, not a hot path.
 *
 * Env contract (same shared secret as the dashboard→host bridge — both
 * daemons already have it; symmetric):
 *   CYBERTRON_DASHBOARD_PORT            default 3002
 *   CYBERTRON_DASHBOARD_BRIDGE_SECRET   default shared dev secret
 *
 * Bounded by a hard fetch timeout so a confirmed action can NEVER hang
 * the engine waiting on the replay (defense matching the dashboard-side
 * REPLAY_TTL_MS / loop-exit guarantee).
 */
import { log } from '../../log.js';

const DEFAULT_PORT = 3002;
const DEFAULT_SHARED_SECRET = 'dev-bridge-secret-set-CYBERTRON_DASHBOARD_BRIDGE_SECRET';
/** Hard cap on the replay round-trip. Generous (a confirmed MCP call can
 *  legitimately take tens of seconds — e.g. a slow calendar query) but
 *  finite: a stuck dashboard can never wedge the confirm handler. */
const REPLAY_FETCH_TIMEOUT_MS = 90_000;

export interface ReplayContent {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export type McpReplayOutcome =
  | { status: 'ok'; content: ReplayContent[]; isError: boolean }
  | { status: 'expired' }
  | { status: 'already_done' }
  | { status: 'error'; message: string };

/**
 * Ask dashboard-server to run the stashed, now-grant-satisfied tool
 * call for this gate identity. Never throws — every failure mode maps
 * to a definitive `McpReplayOutcome` the caller can turn into a clear
 * user-facing message (the confirm path must never hang or loop).
 */
export async function replayConfirmedMcpCall(args: {
  approvalId: string;
  groupFolder: string;
  integration: string;
  tool: string;
}): Promise<McpReplayOutcome> {
  const port = Number(process.env.CYBERTRON_DASHBOARD_PORT ?? DEFAULT_PORT);
  const secret = process.env.CYBERTRON_DASHBOARD_BRIDGE_SECRET ?? DEFAULT_SHARED_SECRET;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REPLAY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/_replay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': secret,
      },
      body: JSON.stringify({
        approvalId: args.approvalId,
        groupFolder: args.groupFolder,
        integration: args.integration,
        tool: args.tool,
      }),
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.ok !== true) {
      const message =
        typeof body.message === 'string'
          ? body.message
          : typeof body.error === 'string'
            ? body.error
            : `replay HTTP ${res.status}`;
      return { status: 'error', message };
    }
    if (body.status === 'expired') return { status: 'expired' };
    if (body.status === 'already_done') return { status: 'already_done' };
    if (body.status === 'ok') {
      const result = body.result as { content?: ReplayContent[]; isError?: boolean } | undefined;
      return {
        status: 'ok',
        content: Array.isArray(result?.content) ? result!.content : [],
        isError: result?.isError === true,
      };
    }
    return {
      status: 'error',
      message: `unexpected replay status: ${String(body.status)}`,
    };
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `replay timed out after ${REPLAY_FETCH_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    log.warn('mcp-replay-client: replay call failed', { message });
    return { status: 'error', message };
  } finally {
    clearTimeout(timer);
  }
}
