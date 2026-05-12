/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { hasChannelDestination } from '../destinations.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

/**
 * Optional gating for channel-specific tools. When `requireChannelType`
 * is set, the tool only registers if the session has at least one
 * channel destination of one of those types. This prevents the agent
 * in a WhatsApp-only group from seeing `discord_channel_history` (and
 * vice versa) — observed 2026-05-12 in Tico+Janathan where the agent
 * was asked to backfill, saw only `discord_channel_history`, and
 * fired it against a WhatsApp chat.
 *
 * Destinations are written by the host before every container wake,
 * so reading them at module-import time (when registerTools runs) is
 * safe — the table is populated by the time MCP boot reaches us. The
 * host re-writes destinations on wiring changes; agents pick up the
 * delta on their next session.
 */
export interface RegisterToolsOptions {
  requireChannelType?: string[];
}

export function registerTools(
  tools: McpToolDefinition[],
  opts?: RegisterToolsOptions,
): void {
  if (opts?.requireChannelType && opts.requireChannelType.length > 0) {
    const reachable = opts.requireChannelType.some((ct) =>
      hasChannelDestination(ct),
    );
    if (!reachable) {
      const skipped = tools.map((t) => t.tool.name).join(', ');
      log(
        `Skipping channel-gated tools (no ${opts.requireChannelType.join('/')} destination): ${skipped}`,
      );
      return;
    }
  }
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    return tool.handler(args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
