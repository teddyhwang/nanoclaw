import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyExit, hardeningArgs, resolveProviderName, syncSkillSymlinks } from './container-runner.js';
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

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('plugins read-only mount (structural)', () => {
  // Stamped plugin content must be immutable inside the container (Agent
  // Plugins contract: writes go to plugin-data/). Driving buildMounts needs a
  // provider registry + composed group surfaces, so guard the wiring
  // structurally: the plugins dir must be mounted at CONTAINER_PLUGINS_DIR
  // with readonly: true.
  it('mounts groups/<folder>/plugins read-only', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const idx = src.indexOf("path.join(groupDir, 'plugins')");
    expect(idx).toBeGreaterThan(-1);
    const mountExpr = src.slice(idx, idx + 200);
    expect(mountExpr).toContain('CONTAINER_PLUGINS_DIR');
    expect(mountExpr).toContain('readonly: true');
  });
});

describe('per-container resource limits (structural)', () => {
  // CONTAINER_CPU_LIMIT / CONTAINER_MEMORY_LIMIT pass through to `docker run` as
  // --cpus / --memory, but only when set. The default is empty string → no flag →
  // today's unbounded behavior (don't OOM existing OSS workloads). Swap is not
  // managed here (a swapless host makes --memory a hard cap). buildContainerArgs
  // needs a live gateway to drive, so guard the wiring structurally: the flags
  // must be pushed, and each must be guarded by its env knob so empty emits nothing.
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy CONTAINER_CPU_LIMIT', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_CPU_LIMIT\)[\s\S]*?args\.push\('--cpus', CONTAINER_CPU_LIMIT\)/);
  });

  it('guards --memory behind a truthy CONTAINER_MEMORY_LIMIT (and sets no swap flag)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_MEMORY_LIMIT\) args\.push\('--memory', CONTAINER_MEMORY_LIMIT\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('defaults both knobs to empty string in config (no flag = unbounded)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain(
      "CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || ''",
    );
    expect(cfg).toContain(
      "CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || ''",
    );
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container crashes', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container crashed.*stderrTail/s);
  });
});

describe('syncSkillSymlinks blocked-entry warning (structural)', () => {
  // Real directories in .claude-shared/skills/ block the managed symlinks:
  // the prune loop only removes symlinks and the create loop skips any
  // existing entry. Template overlays depend on surviving that (see
  // src/group-skills.ts); stale pre-refactor skill copies (#3001) get served
  // forever with no trace. Driving syncSkillSymlinks needs a real group
  // filesystem, and importing more of the module pulls the provider side
  // effects, so guard the wiring structurally: the create loop must warn
  // when a non-symlink entry occupies a desired skill path.
  it('warns instead of silently skipping when a real entry blocks a desired skill', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const createLoop = src.indexOf('// Create symlinks for desired skills');
    expect(createLoop).toBeGreaterThan(-1);
    const tail = src.slice(createLoop);
    expect(tail).toMatch(/if \(!entry\.isSymbolicLink\(\)\)/);
    expect(tail).toMatch(/log\.warn\(\s*'Shared skill not symlinked/);
  });
});

describe('hardeningArgs', () => {
  it('always emits the three unconditional flags', () => {
    const args = hardeningArgs('2048');
    expect(args).toContain('--cap-drop=ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
    expect(args).toContain('--init');
  });

  it('emits the pids limit when positive', () => {
    expect(hardeningArgs('2048').join(' ')).toContain('--pids-limit 2048');
  });

  // cgroups v2 rejects `--pids-limit 0` with EINVAL, killing the spawn.
  it('omits the pids limit for 0, negatives, blank and garbage', () => {
    for (const v of ['0', '-1', '', '   ', 'lots']) {
      expect(hardeningArgs(v).join(' ')).not.toContain('--pids-limit');
    }
  });

  it('floors fractional values', () => {
    expect(hardeningArgs('2048.7').join(' ')).toContain('--pids-limit 2048');
  });
});
