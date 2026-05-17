import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyExit, resolveProviderName, syncSkillSymlinks } from './container-runner.js';
import { addSkillRoot } from './engine/skill-roots.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('classifyExit', () => {
  it('host-initiated kill (killContainer) is an expected killed/info', () => {
    // intentional wins regardless of code/signal — sweep idle-timeout,
    // absolute-ceiling, claim-stuck, self-mod rebuild all SIGKILL.
    expect(classifyExit(null, 'SIGKILL', true)).toEqual({ reason: 'killed', level: 'info' });
    expect(classifyExit(137, null, true)).toEqual({ reason: 'killed', level: 'info' });
    expect(classifyExit(0, null, true)).toEqual({ reason: 'killed', level: 'info' });
  });

  it('clean exit code 0 is idle/info', () => {
    expect(classifyExit(0, null, false)).toEqual({ reason: 'idle', level: 'info' });
  });

  it('SIGTERM / 143 is a graceful external stop, not a crash', () => {
    // docker stop -t 1 (the dashboard model/harness-switch path
    // stopV2ContainersForFolder) sends SIGTERM. Must NOT warn.
    expect(classifyExit(null, 'SIGTERM', false)).toEqual({ reason: 'killed', level: 'info' });
    expect(classifyExit(143, null, false)).toEqual({ reason: 'killed', level: 'info' });
  });

  it('uninitiated SIGKILL/137 (OOM) is crashed/warn', () => {
    // The EXIT:137 crash-loop shape from the 2026-05-16 incident.
    expect(classifyExit(137, null, false)).toEqual({ reason: 'crashed', level: 'warn' });
    expect(classifyExit(null, 'SIGKILL', false)).toEqual({ reason: 'crashed', level: 'warn' });
    expect(classifyExit(null, 'SIGSEGV', false)).toEqual({ reason: 'crashed', level: 'warn' });
  });

  it('uninitiated non-zero exit code is crashed/warn', () => {
    // The SQLITE_CANTOPEN / missing-readSessionStats process.exit(1) shape.
    expect(classifyExit(1, null, false)).toEqual({ reason: 'crashed', level: 'warn' });
    expect(classifyExit(125, null, false)).toEqual({ reason: 'crashed', level: 'warn' });
  });
});

describe('syncSkillSymlinks', () => {
  let tmpRoot: string;
  let claudeDir: string;
  let builtInSkillsDir: string;
  let extraSkillsHostDir: string;
  let originalContainerSourceDir: string | undefined;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-skill-symlinks-'));
    claudeDir = path.join(tmpRoot, '.claude-shared');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Built-in skills tree — what `/app/skills/` is mounted from.
    builtInSkillsDir = path.join(tmpRoot, 'container', 'skills');
    fs.mkdirSync(builtInSkillsDir, { recursive: true });
    fs.mkdirSync(path.join(builtInSkillsDir, 'onecli-gateway'));
    fs.mkdirSync(path.join(builtInSkillsDir, 'welcome'));

    // Extra skill root — Optimus's cyber-key/skills/ shape, mounted at
    // /app/optimus-skills in the container.
    extraSkillsHostDir = path.join(tmpRoot, 'packages', 'cyber-key', 'skills');
    fs.mkdirSync(extraSkillsHostDir, { recursive: true });
    fs.mkdirSync(path.join(extraSkillsHostDir, 'google'));
    fs.mkdirSync(path.join(extraSkillsHostDir, 'lunchmoney'));

    originalContainerSourceDir = process.env.NANOCLAW_CONTAINER_SOURCE_DIR;
    process.env.NANOCLAW_CONTAINER_SOURCE_DIR = path.join(tmpRoot, 'container');
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    if (originalContainerSourceDir === undefined) {
      delete process.env.NANOCLAW_CONTAINER_SOURCE_DIR;
    } else {
      process.env.NANOCLAW_CONTAINER_SOURCE_DIR = originalContainerSourceDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function readLink(name: string): string | null {
    try {
      return fs.readlinkSync(path.join(claudeDir, 'skills', name));
    } catch {
      return null;
    }
  }

  it('links built-in skills with skills="all" and no extra roots', () => {
    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);
    expect(readLink('onecli-gateway')).toBe('/app/skills/onecli-gateway');
    expect(readLink('welcome')).toBe('/app/skills/welcome');
    expect(readLink('google')).toBeNull();
  });

  // Regression for S332.2: cyber-key skills were bind-mounted at
  // /app/optimus-skills but never linked into ~/.claude/skills/, so the SDK
  // never discovered them, the agent's skill_listing didn't include
  // `google`/`ixact`/`lunchmoney`/etc., and the agent fell through to
  // onecli-gateway (Bash curl) for tasks the dedicated skills should handle.
  it('links skills from extra roots alongside built-ins with skills="all"', () => {
    cleanups.push(
      addSkillRoot({
        hostPath: extraSkillsHostDir,
        containerPath: '/app/optimus-skills',
      }),
    );
    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);
    expect(readLink('onecli-gateway')).toBe('/app/skills/onecli-gateway');
    expect(readLink('google')).toBe('/app/optimus-skills/google');
    expect(readLink('lunchmoney')).toBe('/app/optimus-skills/lunchmoney');
  });

  it('built-in skill wins on a name collision with an extra root', () => {
    // Pretend an extra root tries to shadow `welcome`. Built-in must win so
    // a host can't silently override a NanoClaw skill by reusing the name.
    fs.mkdirSync(path.join(extraSkillsHostDir, 'welcome'));
    cleanups.push(
      addSkillRoot({
        hostPath: extraSkillsHostDir,
        containerPath: '/app/optimus-skills',
      }),
    );
    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);
    expect(readLink('welcome')).toBe('/app/skills/welcome');
  });

  it('explicit allowlist keeps the built-in-only behavior (extras ignored)', () => {
    // Hand-curated skill lists predate extra-root support; matching the
    // previous semantics avoids silently expanding a deliberately-narrow
    // skill set when a plugin registers a new root.
    cleanups.push(
      addSkillRoot({
        hostPath: extraSkillsHostDir,
        containerPath: '/app/optimus-skills',
      }),
    );
    syncSkillSymlinks(claudeDir, { skills: ['welcome'] } as never);
    expect(readLink('welcome')).toBe('/app/skills/welcome');
    expect(readLink('google')).toBeNull();
    expect(readLink('onecli-gateway')).toBeNull();
  });

  it('reconciles stale symlinks when extra root targets move', () => {
    // First sync writes the extra-root symlink pointing at /app/optimus-skills
    cleanups.push(
      addSkillRoot({
        hostPath: extraSkillsHostDir,
        containerPath: '/app/optimus-skills',
      }),
    );
    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);
    expect(readLink('google')).toBe('/app/optimus-skills/google');

    // Simulate a stale symlink at the old built-in path (the bug we shipped:
    // syncSkillSymlinks once hardcoded /app/skills/<name> for every entry,
    // so groups that survived the migration kept dangling pointers).
    const linkPath = path.join(claudeDir, 'skills', 'google');
    fs.unlinkSync(linkPath);
    fs.symlinkSync('/app/skills/google', linkPath);
    expect(readLink('google')).toBe('/app/skills/google');

    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);
    expect(readLink('google')).toBe('/app/optimus-skills/google');
  });

  it('removes symlinks for skills that are no longer present', () => {
    cleanups.push(
      addSkillRoot({
        hostPath: extraSkillsHostDir,
        containerPath: '/app/optimus-skills',
      }),
    );
    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);
    expect(readLink('lunchmoney')).toBe('/app/optimus-skills/lunchmoney');

    fs.rmSync(path.join(extraSkillsHostDir, 'lunchmoney'), { recursive: true });
    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);
    expect(readLink('lunchmoney')).toBeNull();
    expect(readLink('google')).toBe('/app/optimus-skills/google');
  });

  // Regression: per-group local-skills authored inside the container
  // (`local-skill-author` or `daily-recap`-style v1→v2 migrations) were
  // never symlinked into ~/.claude/skills/, so the Claude SDK couldn't
  // discover them and rules they encoded (e.g. AI Friends' RSS-incident
  // exclusion in the daily recap) silently disappeared after v2 cutover.
  it('links per-group local-skills + generated-skills from .claude-shared/', () => {
    const localSkillsDir = path.join(claudeDir, 'local-skills', 'daily-recap');
    fs.mkdirSync(localSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(localSkillsDir, 'SKILL.md'), '---\nname: daily-recap\n---\n');
    const generatedSkillsDir = path.join(claudeDir, 'generated-skills', 'self-mod');
    fs.mkdirSync(generatedSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(generatedSkillsDir, 'SKILL.md'), '---\nname: self-mod\n---\n');

    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);

    expect(readLink('daily-recap')).toBe('/home/node/.claude/local-skills/daily-recap');
    expect(readLink('self-mod')).toBe('/home/node/.claude/generated-skills/self-mod');
    // Built-in skills still link normally.
    expect(readLink('welcome')).toBe('/app/skills/welcome');
  });

  it('per-group local-skill cannot shadow a built-in skill name', () => {
    // `welcome` is built-in. A group-local skill with the same name must
    // not redirect ~/.claude/skills/welcome away from the canonical
    // /app/skills/welcome target.
    const localSkillsDir = path.join(claudeDir, 'local-skills', 'welcome');
    fs.mkdirSync(localSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(localSkillsDir, 'SKILL.md'), '---\nname: welcome\n---\n');

    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);

    expect(readLink('welcome')).toBe('/app/skills/welcome');
  });

  it('respects per-root skillFilter for selective exposure', () => {
    cleanups.push(
      addSkillRoot({
        hostPath: extraSkillsHostDir,
        containerPath: '/app/optimus-skills',
        skillFilter: (name) => name === 'google',
      }),
    );
    syncSkillSymlinks(claudeDir, { skills: 'all' } as never);
    expect(readLink('google')).toBe('/app/optimus-skills/google');
    expect(readLink('lunchmoney')).toBeNull();
  });
});
