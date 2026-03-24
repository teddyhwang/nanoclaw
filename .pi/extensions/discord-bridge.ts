/**
 * Discord Bridge Extension
 *
 * Works in both TUI and RPC mode:
 * - TUI mode: watches pi-queue for messages, injects them into session
 * - RPC mode: the dev-agent daemon sends prompts via RPC protocol instead
 *
 * In both modes, provides the send_discord tool and loads dev memory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const QUEUE_DIR = path.join(process.env.HOME || "", ".config/nanoclaw/pi-queue");
const OUTBOX_DIR = path.join(process.env.HOME || "", ".config/nanoclaw/pi-outbox");

// Allowed paths for file operations triggered by /dev messages
const ALLOWED_PATHS = [
  path.resolve("./"),                                                        // NanoClaw project root
  path.join(process.env.HOME || "", ".config/nanoclaw"),                     // NanoClaw config
  path.join(process.env.HOME || "", "Library/LaunchAgents/com.nanoclaw"),    // launchd plist
];

// Dangerous bash patterns that could escape the project
const DANGEROUS_BASH_PATTERNS = [
  /\bsudo\b/,                              // sudo
  /\bcurl\b.*\|\s*(ba)?sh/,               // curl | sh
  /\beval\b/,                              // eval
];

// In RPC daemon mode, never allow the agent to restart/stop its own service.
const SELF_RESTART_PATTERNS = [
  /launchctl\s+(?:kickstart|bootstrap|bootout|load|unload)[^\n]*com\.nanoclaw\.dev-agent/i,
  /systemctl[^\n]*(?:start|stop|restart)[^\n]*nanoclaw[^\n]*dev-agent/i,
];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });

    const daemonMode = process.env.NANOCLAW_DEV_AGENT_RPC === "1";

    // Only watch the queue in interactive TUI mode when daemon mode is off.
    // In daemon/RPC mode, src/dev-agent.ts is the sole queue consumer.
    if (ctx.hasUI && !daemonMode) {
      drainQueue(pi, ctx);
      fs.watch(QUEUE_DIR, () => {
        drainQueue(pi, ctx);
      });
      ctx.ui.notify("Discord bridge active (TUI mode)", "info");
    } else if (daemonMode && ctx.hasUI) {
      ctx.ui.notify("Discord bridge active (daemon/RPC mode)", "info");
    }
  });

  // Load dev memory into context at the start of each agent turn
  const DEV_MEMORY_PATH = path.join(path.resolve("./"), "groups/dev/MEMORY.md");
  pi.on("before_agent_start", async (event) => {
    try {
      if (fs.existsSync(DEV_MEMORY_PATH)) {
        const memory = fs.readFileSync(DEV_MEMORY_PATH, "utf-8");
        return {
          systemPrompt: event.systemPrompt + "\n\n<dev_memory>\n" + memory + "\n</dev_memory>",
        };
      }
    } catch {
      // ignore read errors
    }
    return undefined;
  });

  // Detect /dev messages from RPC prompts (sent by dev-agent daemon)
  // Format: "[Discord /dev from Sender]: content"
  const DEV_MESSAGE_PATTERN = /^\[Discord \/dev from .+\]: /;
  pi.on("input", async (event) => {
    if (DEV_MESSAGE_PATTERN.test(event.text)) {
      isHandlingDevMessage = true;
      // Extract chatJid from the dev memory or use the default owner DM
      lastChatJid = "dc:1485414819614949377";
    }
    return { action: "continue" as const };
  });

  // Security: restrict file operations when handling /dev messages
  pi.on("tool_call", async (event, ctx) => {
    if (!isHandlingDevMessage) return undefined;

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = event.input.path as string;
      const resolved = path.resolve(filePath);

      if (!isAllowedPath(resolved)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`🔒 Blocked write to ${filePath} (outside NanoClaw project)`, "warning");
        }
        return { block: true, reason: `Path "${filePath}" is outside the allowed NanoClaw directories. /dev commands can only modify files within the NanoClaw project.` };
      }
    }

    if (event.toolName === "bash") {
      const command = (event.input as { command: string }).command;

      if (process.env.NANOCLAW_DEV_AGENT_RPC === "1") {
        for (const pattern of SELF_RESTART_PATTERNS) {
          if (pattern.test(command)) {
            return {
              block: true,
              reason:
                "Blocked command: the RPC dev agent cannot restart/stop its own service from inside a /dev task. Make the code/config change first, then restart the service outside the agent flow.",
            };
          }
        }
      }

      for (const pattern of DANGEROUS_BASH_PATTERNS) {
        if (pattern.test(command)) {
          if (ctx.hasUI) {
            const ok = await ctx.ui.confirm(
              "⚠️ Potentially dangerous command from /dev",
              `Command: ${command}\n\nAllow?`
            );
            if (!ok) {
              return { block: true, reason: "Blocked by security gate" };
            }
          } else {
            // In RPC mode, block dangerous commands outright (no UI to confirm)
            return { block: true, reason: `Blocked dangerous command from /dev: ${command}` };
          }
          return undefined;
        }
      }
    }

    return undefined;
  });

  // Tool for sending replies back to Discord
  pi.registerTool({
    name: "send_discord",
    label: "Send Discord",
    description:
      "Send a message back to the user via Discord. Use this to reply to /dev requests that were forwarded from Discord.",
    promptSnippet: "Reply to Discord /dev messages",
    parameters: Type.Object({
      message: Type.String({ description: "Message to send back via Discord" }),
      chatJid: Type.Optional(
        Type.String({
          description:
            "Discord chat JID to send to. Defaults to the JID from the last received message.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const jid = params.chatJid || lastChatJid;
      if (!jid) {
        throw new Error(
          "No chat JID available. Specify chatJid or wait for a Discord message first."
        );
      }

      const outFile = path.join(OUTBOX_DIR, `${Date.now()}-reply.json`);
      fs.writeFileSync(
        outFile,
        JSON.stringify({ chatJid: jid, message: `⚙️ ${params.message}` })
      );

      return {
        content: [{ type: "text" as const, text: `Sent to Discord (${jid})` }],
        details: {},
      };
    },
  });

  // Track when the agent is done handling a /dev message
  pi.on("agent_end", async () => {
    isHandlingDevMessage = false;
  });
}

let lastChatJid: string | undefined;
let isHandlingDevMessage = false;

function isAllowedPath(resolved: string): boolean {
  return ALLOWED_PATHS.some((allowed) => resolved.startsWith(allowed));
}

function drainQueue(pi: ExtensionAPI, ctx: { hasUI: boolean; ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } }) {
  try {
    const files = fs
      .readdirSync(QUEUE_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();

    for (const file of files) {
      const filePath = path.join(QUEUE_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        fs.unlinkSync(filePath);

        lastChatJid = data.chatJid;
        isHandlingDevMessage = true;
        const sender = data.senderName || data.sender || "Unknown";
        const content = data.content || "";

        if (ctx.hasUI) {
          ctx.ui.notify(`Discord /dev from ${sender}`, "info");
        }

        pi.sendMessage(
          {
            customType: "discord-dev",
            content: `[Discord /dev from ${sender}]: ${content}`,
            display: true,
            details: { chatJid: data.chatJid, sender, originalContent: content },
          },
          { triggerTurn: true, deliverAs: "followUp" }
        );
      } catch {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  } catch {
    // Queue dir might not exist yet
  }
}
