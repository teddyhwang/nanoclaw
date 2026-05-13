/**
 * Session-level MCP tools: rotate_session.
 *
 * `rotate_session` clears the per-provider continuation rows (and their
 * `started_at` stamps) from the session's outbound.db so the next user
 * message starts a fresh provider conversation rather than resuming and
 * re-compacting an aging transcript. Bounds drift from weeks of
 * accumulated compactions.
 *
 * Two callers exist for this primitive:
 *   - This MCP tool, invoked by the agent itself (end of the nightly dream
 *     prompt, or any time the agent decides the thread has gotten too
 *     stale to keep resuming).
 *   - The poll-loop's lazy rotation hook in `../session-rotation.ts`,
 *     which fires automatically at the start of each turn when the
 *     transcript trips a drift threshold (day boundary, compact count,
 *     size, tokens).
 *
 * The two callers share the same underlying function so the on-disk
 * state stays consistent regardless of which path rotated.
 *
 * Container-side: the agent-runner already owns outbound.db, so the SQL
 * runs in-process. The current turn keeps its in-memory `resume` id (it
 * was passed into sdkQuery before the tool call) — only the *next* wake
 * sees the cleared row and starts fresh. That's the correct semantics:
 * the agent finishes its current task on the existing thread, then the
 * rotation takes effect on the next user message.
 */
import { clearAllSessionTrackingState } from '../db/session-state.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export const rotateSession: McpToolDefinition = {
  tool: {
    name: 'rotate_session',
    description:
      "Clear every provider continuation id (and its startedAt stamp) for this session so the next user message starts a fresh provider conversation. The current turn finishes on the existing thread; rotation takes effect on the next wake. Drift-based rotation already runs automatically at the start of each turn — call this tool when you want to force rotation outside that automatic check, e.g. at the end of the nightly dream maintenance prompt or when you've decided the current thread is too stale or corrupted to keep resuming.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler() {
    const cleared = clearAllSessionTrackingState();
    log(`rotate_session: cleared ${cleared} session-tracking row(s)`);
    return ok(
      `Session rotated — cleared ${cleared} session-tracking row(s) (provider continuations + startedAt stamps). Next user message will start a fresh conversation.`,
    );
  },
};

registerTools([rotateSession]);
