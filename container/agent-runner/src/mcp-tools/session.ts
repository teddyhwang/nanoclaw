/**
 * Session-level MCP tools: rotate_session.
 *
 * `rotate_session` clears the per-provider continuation rows from the
 * session's outbound.db so the next turn starts a fresh provider
 * conversation (new Claude Code .jsonl, new Codex thread, etc.) rather
 * than resuming and re-compacting an aging transcript. Bounds drift from
 * weeks of accumulated compactions.
 *
 * Container-side: the agent-runner already owns outbound.db, so the SQL
 * runs in-process. The current turn keeps its in-memory `resume` id (it
 * was passed into sdkQuery before the tool call) — only the *next* wake
 * sees the cleared row and starts fresh. That's the correct semantics:
 * the agent finishes its current task on the existing thread, then the
 * rotation takes effect on the next user message.
 */
import { clearAllContinuations } from '../db/session-state.js';
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
      'Clear every provider continuation id for this session so the next user message starts a fresh provider conversation. The current turn finishes on the existing thread; rotation takes effect on the next wake. Use for daily session rotation to bound compaction-induced drift, or when the agent decides the conversation has gotten too long/stale to continue resuming.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler() {
    const cleared = clearAllContinuations();
    log(`rotate_session: cleared ${cleared} continuation row(s)`);
    return ok(`Session rotated — cleared ${cleared} provider continuation(s). Next user message will start a fresh conversation.`);
  },
};

registerTools([rotateSession]);
