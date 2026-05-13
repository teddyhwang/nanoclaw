import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { resolveGroupDir } from './engine/paths.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bun /app/src/compact-instructions.ts',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path.
 *
 * Source code and skills are shared RO mounts — not copied per-group.
 * Skill symlinks are synced at spawn time by container-runner.ts.
 *
 * The composed `CLAUDE.md` is NOT written here — it's regenerated on every
 * spawn by `composeGroupClaudeMd()` (see `claude-md-compose.ts`). Initial
 * per-group instructions (if provided) seed `CLAUDE.local.md`.
 */
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = resolveGroupDir(group);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/CLAUDE.local.md — per-group agent scratch memory,
  // auto-loaded by Claude Code. Seeded with caller-provided instructions on
  // first creation. The structured kernel (IDENTITY/CURRENT/KNOWLEDGE/AGENTS)
  // is the primary memory layer; CLAUDE.local.md is the fallback for facts
  // that don't fit a kernel shape.
  const claudeLocalFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(claudeLocalFile)) {
    const body = opts?.instructions ? opts.instructions + '\n' : '';
    fs.writeFileSync(claudeLocalFile, body);
    initialized.push('CLAUDE.local.md');
  }

  // Agent kernel stubs — eagerly imported by the composer when present.
  // Each is created empty (operator/agent fills in over time) so first-spawn
  // composed CLAUDE.md picks them up. Existing groups already have these
  // and this is idempotent; new groups get the kernel shape for free.
  scaffoldKernel(groupDir, initialized);

  // Ensure container_configs row exists in the DB. Idempotent — no-op if
  // the row already exists (e.g. created by backfill or group creation).
  ensureContainerConfig(group.id);
  initialized.push('container_configs');

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    initialized.push('.claude-shared');
  }

  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
    initialized.push('settings.json');
  } else {
    ensurePreCompactHook(settingsFile, initialized);
  }

  // Skills directory — created empty here; symlinks are synced at spawn
  // time by container-runner.ts based on container.json skills selection.
  const skillsDst = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDst)) {
    fs.mkdirSync(skillsDst, { recursive: true });
    initialized.push('skills/');
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}

const KERNEL_STUBS: Record<string, string> = {
  'IDENTITY.md':
    '# Identity\n\n' +
    'Who you are in this group: voice, scope, permissions, who you talk to and how.\n' +
    'Update only when a stable property of the group changes.\n',
  'CURRENT.md':
    '# Current\n\n' +
    'Open items and recent context for fast session cold-starts. Updated each session.\n\n' +
    '## Open Items\n\n## Recent Context\n',
  'KNOWLEDGE.md':
    '# Knowledge Index\n\n' +
    'Files in `knowledge/` for lazy-loading. Add an entry whenever you create a structured-knowledge file.\n',
  'AGENTS.md':
    '<!-- kernel: v1.1 -->\n\n' +
    '# Agent Kernel\n\n' +
    'You are a stateful agent. Durable memory comes from files in this directory. ' +
    'See `IDENTITY.md` for who you are; `CURRENT.md` for recent state; `KNOWLEDGE.md` for the lazy-load index.\n\n' +
    '## Session Protocol\n\n' +
    '### Start\n- The composed `CLAUDE.md` has already loaded IDENTITY, AGENTS, CURRENT, and KNOWLEDGE.\n' +
    '- Load `knowledge/<topic>.md` only when a task touches that domain.\n\n' +
    "### During\n- Verify state before acting — don't trust notes blindly.\n" +
    "- Append work to today's `notes/YYYY-MM-DD.md`. Never rewrite prior days.\n\n" +
    '### End\n- Update `CURRENT.md`: remove resolved items, add new ones.\n' +
    '- Promote substantive new facts from `CLAUDE.local.md` into `knowledge/<topic>.md` + the `KNOWLEDGE.md` index.\n',
};

function scaffoldKernel(groupDir: string, initialized: string[]): void {
  for (const [name, content] of Object.entries(KERNEL_STUBS)) {
    const target = path.join(groupDir, name);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content);
      initialized.push(name);
    }
  }
  for (const sub of ['knowledge', 'notes']) {
    const target = path.join(groupDir, sub);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      initialized.push(`${sub}/`);
    }
  }
}

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';

/**
 * Patch an existing settings.json to add the PreCompact hook if missing.
 * Runs on every group init so pre-existing groups pick up the hook.
 */
function ensurePreCompactHook(settingsFile: string, initialized: string[]): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw);

    // Check if there's already a PreCompact hook with our command.
    const existing = settings.hooks?.PreCompact as unknown[] | undefined;
    if (existing && JSON.stringify(existing).includes(PRE_COMPACT_COMMAND)) return;

    // Add the hook, preserving existing hooks.
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
    settings.hooks.PreCompact.push({
      hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }],
    });

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    initialized.push('settings.json (added PreCompact hook)');
  } catch {
    // Don't break init if settings.json is malformed — it'll use whatever's there.
  }
}
