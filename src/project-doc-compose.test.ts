import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-project-doc-compose-test';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  ensureContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from './db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { _resetComposerHooksForTests, setSharedBaseProvider } from './engine/composer-hooks.js';
import { _resetSkillRootsForTests, addContextFragmentProvider, addSkillRoot } from './engine/skill-roots.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import { log } from './log.js';
import { composeGroupProjectDoc, DEFAULT_PROJECT_DOC, type ProjectDocSpec } from './project-doc-compose.js';
import type { AgentGroup } from './types.js';

const CLAUDE_SPEC: ProjectDocSpec = {
  fileName: 'CLAUDE.md',
  baseDocPath: path.join('container', 'CLAUDE.md'),
};

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function groupDirOf(folder: string): string {
  return path.join(TEST_ROOT, folder);
}

async function seed(id: string, folder: string): Promise<AgentGroup> {
  const ag = group(id, folder);
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
  fs.mkdirSync(groupDirOf(folder), { recursive: true });
  return ag;
}

function writePersona(folder: string, text: string): void {
  fs.writeFileSync(path.join(groupDirOf(folder), PERSONA_PREPEND_FILE), text);
}

async function compose(ag: AgentGroup, spec: ProjectDocSpec = CLAUDE_SPEC): Promise<string> {
  await composeGroupProjectDoc(ag, groupDirOf(ag.folder), spec);
  return fs.readFileSync(path.join(groupDirOf(ag.folder), spec.fileName), 'utf-8');
}

let originalContainerSourceDir: string | undefined;
let originalProjectRoot: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  _resetComposerHooksForTests();
  _resetSkillRootsForTests();
  originalContainerSourceDir = process.env.NANOCLAW_CONTAINER_SOURCE_DIR;
  originalProjectRoot = process.env.NANOCLAW_PROJECT_ROOT;
  delete process.env.NANOCLAW_CONTAINER_SOURCE_DIR;
  delete process.env.NANOCLAW_PROJECT_ROOT;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  _resetComposerHooksForTests();
  _resetSkillRootsForTests();
  if (originalContainerSourceDir === undefined) delete process.env.NANOCLAW_CONTAINER_SOURCE_DIR;
  else process.env.NANOCLAW_CONTAINER_SOURCE_DIR = originalContainerSourceDir;
  if (originalProjectRoot === undefined) delete process.env.NANOCLAW_PROJECT_ROOT;
  else process.env.NANOCLAW_PROJECT_ROOT = originalProjectRoot;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('composeGroupProjectDoc delivery', () => {
  // The regression guard for the bug this composer was rewritten to fix: an
  // `@` import whose target resolves outside the project directory is dropped
  // by Claude Code silently, so the document must not contain one at all.
  it('emits no @ import lines', async () => {
    const ag = await seed('ag-flat', 'flat-group');

    const doc = await compose(ag);

    expect(doc.split('\n').filter((line) => line.startsWith('@'))).toEqual([]);
  });

  it('creates no fragment directory or shared-base symlink', async () => {
    const ag = await seed('ag-artifacts', 'artifacts-group');

    await compose(ag);

    const entries = fs.readdirSync(groupDirOf(ag.folder));
    expect(entries).not.toContain('.claude-fragments');
    expect(entries).not.toContain('.claude-shared.md');
  });

  it('inlines the shared base document, module instructions and resident skill prose', async () => {
    const ag = await seed('ag-inline', 'inline-group');

    const doc = await compose(ag);

    // Whole files, not sentinel phrases: a heading proves a section was
    // emitted, only the body proves the file was read, and reading the source
    // here means adding a paragraph to it cannot break this test.
    const read = (...p: string[]): string => fs.readFileSync(path.join(process.cwd(), ...p), 'utf-8').trim();
    expect(doc).toContain(read('container', 'CLAUDE.md'));
    expect(doc).toContain(read('container', 'skills', 'onecli-gateway', 'instructions.md'));
    expect(doc).toContain(read('container', 'agent-runner', 'src', 'mcp-tools', 'agents.instructions.md'));
    expect(doc).toContain(read('container', 'agent-runner', 'src', 'mcp-tools', 'core.instructions.md'));
  });

  it('resolves container sources from the embedded-host environment override', async () => {
    const source = path.join(TEST_ROOT, 'embedded-container');
    fs.mkdirSync(path.join(source, 'agent-runner', 'src', 'mcp-tools'), { recursive: true });
    fs.mkdirSync(path.join(source, 'skills', 'embedded-skill'), { recursive: true });
    fs.writeFileSync(path.join(source, 'CLAUDE.md'), 'EMBEDDED_BASE');
    fs.writeFileSync(path.join(source, 'agent-runner', 'src', 'mcp-tools', 'core.instructions.md'), 'EMBEDDED_MODULE');
    fs.writeFileSync(path.join(source, 'skills', 'embedded-skill', 'instructions.md'), 'EMBEDDED_SKILL');
    process.env.NANOCLAW_CONTAINER_SOURCE_DIR = source;
    const ag = await seed('ag-embedded', 'embedded-group');

    const doc = await compose(ag);

    expect(doc).toContain('EMBEDDED_BASE');
    expect(doc).toContain('EMBEDDED_MODULE');
    expect(doc).toContain('EMBEDDED_SKILL');
  });

  it('uses the host-provided shared base instead of the bundled generic base', async () => {
    const hostBase = path.join(TEST_ROOT, 'optimus-kernel.md');
    fs.writeFileSync(hostBase, 'OPTIMUS_KERNEL_BASE');
    setSharedBaseProvider(() => ({ hostPath: hostBase }));
    const ag = await seed('ag-host-base', 'host-base-group');

    const doc = await compose(ag);

    expect(doc).toContain('OPTIMUS_KERNEL_BASE');
    expect(doc).not.toContain(fs.readFileSync(path.join(process.cwd(), 'container', 'CLAUDE.md'), 'utf-8').trim());
  });

  it('writes to the explicit nested group directory supplied by the host resolver', async () => {
    const ag = await seed('ag-nested', 'database-folder');
    const nested = path.join(TEST_ROOT, 'workspaces', 'workspace-a', 'groups', 'nested-group');

    await composeGroupProjectDoc(ag, nested, CLAUDE_SPEC);

    expect(fs.readFileSync(path.join(nested, 'CLAUDE.md'), 'utf-8')).toContain('# NanoClaw Runtime Contract');
    expect(fs.existsSync(path.join(groupDirOf(ag.folder), 'CLAUDE.md'))).toBe(false);
  });

  it('inlines IDENTITY, CURRENT, and KNOWLEDGE in order but never AGENTS', async () => {
    const ag = await seed('ag-kernel', 'kernel-group');
    const dir = groupDirOf(ag.folder);
    fs.writeFileSync(path.join(dir, 'IDENTITY.md'), 'IDENTITY_BODY');
    fs.writeFileSync(path.join(dir, 'CURRENT.md'), 'CURRENT_BODY');
    fs.writeFileSync(path.join(dir, 'KNOWLEDGE.md'), 'KNOWLEDGE_BODY');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'AGENTS_MUST_NOT_INLINE');

    const doc = await compose(ag);

    expect(doc.indexOf('IDENTITY_BODY')).toBeLessThan(doc.indexOf('CURRENT_BODY'));
    expect(doc.indexOf('CURRENT_BODY')).toBeLessThan(doc.indexOf('KNOWLEDGE_BODY'));
    expect(doc).not.toContain('AGENTS_MUST_NOT_INLINE');
  });

  it('inlines filtered extra-skill instructions and async host context fragments', async () => {
    const root = path.join(TEST_ROOT, 'host-skills');
    for (const skill of ['allowed', 'blocked']) {
      fs.mkdirSync(path.join(root, skill), { recursive: true });
      fs.writeFileSync(path.join(root, skill, 'instructions.md'), `${skill.toUpperCase()}_HOST_SKILL`);
    }
    addSkillRoot({
      hostPath: root,
      containerPath: '/app/host-skills',
      skillFilter: (name, group) => name === 'allowed' && group?.id === 'ag-host-context',
    });
    addContextFragmentProvider(async (group) => [{ name: 'workspace-state', content: `HOST_CONTEXT_FOR_${group.id}` }]);
    const ag = await seed('ag-host-context', 'host-context-group');

    const doc = await compose(ag);

    expect(doc).toContain('# Host Skill: allowed');
    expect(doc).toContain('ALLOWED_HOST_SKILL');
    expect(doc).not.toContain('BLOCKED_HOST_SKILL');
    expect(doc).toContain('# Host Context: workspace-state');
    expect(doc).toContain('HOST_CONTEXT_FOR_ag-host-context');
  });

  it('refuses a symlinked group kernel file', async () => {
    const ag = await seed('ag-kernel-link', 'kernel-link-group');
    const victim = path.join(TEST_ROOT, 'kernel-victim.md');
    fs.writeFileSync(victim, 'SYMLINKED_KERNEL_MUST_NOT_INLINE');
    fs.symlinkSync(victim, path.join(groupDirOf(ag.folder), 'CURRENT.md'));

    const doc = await compose(ag);

    expect(doc).not.toContain('SYMLINKED_KERNEL_MUST_NOT_INLINE');
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('unsafe group kernel source'),
      expect.objectContaining({ reason: 'symlink' }),
    );
  });

  it('inlines MCP server instructions from the container config', async () => {
    const ag = await seed('ag-mcp', 'mcp-group');
    await updateContainerConfigJson(ag.id, 'mcp_servers', {
      tooling: { command: 'x', args: [], instructions: 'use the tooling server for builds' },
    });

    const doc = await compose(ag);

    expect(doc).toContain('# MCP Server: tooling');
    expect(doc).toContain('use the tooling server for builds');
  });

  // `.claude/skills/migrate-memory` classifies a staged legacy project doc as
  // generated boilerplate by this prefix. Nothing else guards the composer side.
  it('starts with the composed-at-spawn marker', async () => {
    const ag = await seed('ag-marker', 'marker-group');

    const doc = await compose(ag);

    expect(doc.startsWith('<!-- Composed at spawn')).toBe(true);
    // A heading here instead of a comment would make the header the document's
    // first section and displace the persona.
    expect(doc.split('\n').find((l) => l.startsWith('# '))).not.toBe('# Composed at spawn');
  });

  it('does not eagerly read arbitrary agent memory files', async () => {
    const ag = await seed('ag-memory', 'memory-group');
    const memoryDir = path.join(groupDirOf(ag.folder), 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'index.md'), 'must not enter the project document');

    const doc = await compose(ag);

    expect(doc).not.toContain('must not enter the project document');
  });
});

describe('composeGroupProjectDoc temp-file safety', () => {
  // The group dir is the agent's read-write working directory, so anything the
  // composer writes there by a guessable name is a path the agent can pre-plant.
  // Red if writeAtomic goes back to a predictable name or drops the 'wx' flag.
  it('does not follow a symlink planted where the temp file used to land', async () => {
    const ag = await seed('ag-squat', 'squat-group');
    const victim = path.join(TEST_ROOT, 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL');
    // Exactly the name the old implementation used, and the pid is stable for
    // the life of the host process.
    const squat = path.join(groupDirOf(ag.folder), `CLAUDE.md.tmp-${process.pid}`);
    fs.symlinkSync(victim, squat);

    const doc = await compose(ag);

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(doc).toContain('# NanoClaw Runtime Contract');
    expect(fs.lstatSync(squat).isSymbolicLink()).toBe(true); // left alone, not ours
  });

  // A directory squatting the temp path used to make the finally-rm throw
  // ERR_FS_EISDIR, which rides wakeContainer's retry and darks the group forever.
  it('composes even when a directory occupies the old temp path', async () => {
    const ag = await seed('ag-squat-dir', 'squat-dir-group');
    fs.mkdirSync(path.join(groupDirOf(ag.folder), `CLAUDE.md.tmp-${process.pid}`), { recursive: true });

    await expect(compose(ag)).resolves.toContain('# NanoClaw Runtime Contract');
  });

  it('leaves no temp file behind', async () => {
    const ag = await seed('ag-tmp', 'tmp-group');

    await compose(ag);

    expect(fs.readdirSync(groupDirOf(ag.folder)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('composeGroupProjectDoc corrupt skill selection', () => {
  // The sibling column (mcp_servers) is re-validated; this one used to be a bare
  // cast, so a stored string turned the filter into a substring match and a
  // stored null threw on every spawn. Red if parseSkillSelection is bypassed.
  it.each([
    ['null', 'null'],
    ['a number', '7'],
    ['an object', '{"welcome":true}'],
    ['malformed JSON', '{not json'],
  ])('falls back to every skill when the selection is %s', async (_label, stored) => {
    const ag = await seed(`ag-bad-${stored.length}`, `bad-skills-${stored.length}`);
    await getDb().run('UPDATE container_configs SET skills = ? WHERE agent_group_id = ?', stored, ag.id);

    const doc = await compose(ag);

    expect(doc).toContain('# NanoClaw Skill: onecli-gateway');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('skill selection'), expect.anything());
  });

  it('does not substring-match a stored string against skill names', async () => {
    const ag = await seed('ag-substr', 'substr-group');
    await getDb().run(
      'UPDATE container_configs SET skills = ? WHERE agent_group_id = ?',
      JSON.stringify('xx-onecli-gateway-xx'),
      ag.id,
    );

    const doc = await compose(ag);

    // Treated as corrupt and widened to 'all', never as a selection that
    // happens to contain the skill's name as a substring.
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('skill selection'), expect.anything());
    expect(doc).toContain('# NanoClaw Skill: onecli-gateway');
  });
});

describe('composeGroupProjectDoc persona', () => {
  it('leads the document, before the runtime contract', async () => {
    const ag = await seed('ag-persona', 'persona-group');
    writePersona(ag.folder, 'You are an SDR agent.\n');

    const doc = await compose(ag);

    expect(doc.indexOf('# Persona')).toBeGreaterThan(-1);
    expect(doc.indexOf('# Persona')).toBeLessThan(doc.indexOf('# NanoClaw Runtime Contract'));
    expect(doc).toContain('You are an SDR agent.');
  });

  // Compose runs on every spawn, so the second write matters as much as the
  // first: red if writeAtomic stops overwriting an existing document.
  it('overwrites the previous document rather than keeping it', async () => {
    const ag = await seed('ag-persona-2', 'persona-group-2');
    writePersona(ag.folder, 'first persona');
    await compose(ag);

    writePersona(ag.folder, 'second persona');
    const doc = await compose(ag);

    expect(doc).toContain('second persona');
    expect(doc).not.toContain('first persona');
  });

  it('is inert when no persona file is present (non-template groups)', async () => {
    const ag = await seed('ag-no-persona', 'no-persona-group');

    const doc = await compose(ag);

    expect(doc).not.toContain('# Persona');
    expect(doc).toContain('# NanoClaw Runtime Contract');
  });
});

describe('composeGroupProjectDoc skill selection', () => {
  // Red if the walk stops filtering: the document would teach a skill whose
  // SKILL.md syncSkillSymlinks did not plant, which is a live contradiction.
  it('omits resident prose for a skill the group did not select', async () => {
    const ag = await seed('ag-skills-off', 'skills-off-group');
    await updateContainerConfigJson(ag.id, 'skills', ['welcome']);

    const doc = await compose(ag);

    expect(doc).not.toContain('# NanoClaw Skill: onecli-gateway');
    expect(doc).toContain('# NanoClaw Module: core');
  });

  it('inlines every shipping skill at the default selection', async () => {
    const ag = await seed('ag-skills-all', 'skills-all-group');

    const doc = await compose(ag);

    expect(doc).toContain('# NanoClaw Skill: onecli-gateway');
  });
});

describe('composeGroupProjectDoc cli_scope', () => {
  it('excludes ncl-dependent prose when cli_scope is disabled', async () => {
    // The Optimus tree intentionally does not ship upstream's ncl-tasks prose;
    // use a synthetic source to keep the generic filter regression-covered.
    const source = path.join(TEST_ROOT, 'cli-filter-container');
    const tools = path.join(source, 'agent-runner', 'src', 'mcp-tools');
    fs.mkdirSync(tools, { recursive: true });
    fs.writeFileSync(path.join(source, 'CLAUDE.md'), 'FILTER_BASE');
    fs.writeFileSync(path.join(tools, 'cli.instructions.md'), 'CLI_PROSE');
    fs.writeFileSync(path.join(tools, 'scheduling.instructions.md'), 'SCHEDULING_PROSE');
    fs.writeFileSync(path.join(tools, 'core.instructions.md'), 'CORE_PROSE');
    process.env.NANOCLAW_CONTAINER_SOURCE_DIR = source;

    const ag = await seed('ag-sched-off', 'sched-group-off');
    await updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });
    const doc = await compose(ag);

    expect(doc).not.toContain('CLI_PROSE');
    expect(doc).not.toContain('SCHEDULING_PROSE');
    expect(doc).toContain('CORE_PROSE');
  });
});

describe('composeGroupProjectDoc spec', () => {
  it('places extra sections after the base document and before the module sections', async () => {
    const ag = await seed('ag-extra', 'extra-group');

    const doc = await compose(ag, {
      ...CLAUDE_SPEC,
      extraSections: [{ name: 'Memory System', body: 'memory pointer body' }],
    });

    expect(doc.indexOf('# NanoClaw Runtime Contract')).toBeLessThan(doc.indexOf('# Memory System'));
    expect(doc.indexOf('# Memory System')).toBeLessThan(doc.indexOf('# NanoClaw Module: agents'));
  });

  // Tolerated so a partial payload install still spawns, but never silent: an
  // absent runtime contract is the same shape as the bug this replaced, and it
  // is what a wrong-cwd host looks like. Red if the warn is dropped.
  it('writes the file named by the spec and warns loudly on a missing base document', async () => {
    const ag = await seed('ag-nobase', 'nobase-group');

    const doc = await compose(ag, { fileName: 'AGENTS.md', baseDocPath: path.join('container', 'nope.md') });

    expect(doc).not.toContain('# NanoClaw Runtime Contract');
    expect(doc).toContain('# NanoClaw Module: core');
    expect(log.warn).toHaveBeenCalledWith(
      'Project document composed without its base document',
      expect.objectContaining({ file: 'AGENTS.md' }),
    );
  });
});

describe('composeGroupProjectDoc size cap', () => {
  const bigMcp = (n: number): Record<string, { command: string; args: string[]; instructions: string }> =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`bloated${i}`, { command: 'x', args: [], instructions: 'B'.repeat(9000) }]),
    );

  it('drops the largest droppable sections, keeps the core, and says so in the document', async () => {
    const ag = await seed('ag-cap', 'cap-group');
    writePersona(ag.folder, 'PERSONA_MARKER');
    await updateContainerConfigJson(ag.id, 'mcp_servers', bigMcp(4));

    const doc = await compose(ag, { ...CLAUDE_SPEC, maxBytes: 24 * 1024 });

    expect(Buffer.byteLength(doc, 'utf-8')).toBeLessThanOrEqual(24 * 1024);
    expect(doc).toContain('# Omitted for size');
    expect(doc).toContain('PERSONA_MARKER');
    expect(doc).toContain('# NanoClaw Runtime Contract');
    expect(log.error).toHaveBeenCalled();
  });

  // Claude Code "loads a CLAUDE.md file of up to 4 MiB in full and skips a
  // larger file", and over that cliff the agent gets NOTHING, silently. Red if
  // the default spec goes back to being uncapped.
  it('caps the default document at the size Claude Code will still load', () => {
    expect(DEFAULT_PROJECT_DOC.maxBytes).toBe(4 * 1024 * 1024);
  });

  // fitToCap must never throw: a per-spawn throw rides wakeContainer's retry and
  // darks the group on a 60s loop forever. Oversized-and-loud beats bricked.
  it('writes an oversized document loudly when the core alone exceeds the cap', async () => {
    const ag = await seed('ag-core-over', 'core-over-group');
    writePersona(ag.folder, `P${'A'.repeat(40_000)}`); // persona is never droppable

    const doc = await compose(ag, { ...CLAUDE_SPEC, maxBytes: 20 * 1024 });

    expect(Buffer.byteLength(doc, 'utf-8')).toBeGreaterThan(20 * 1024);
    expect(doc).toContain('AAAA');
    expect(log.error).toHaveBeenCalled();
  });

  it('applies no cap and logs nothing when maxBytes is unset', async () => {
    const ag = await seed('ag-nocap', 'nocap-group');
    await updateContainerConfigJson(ag.id, 'mcp_servers', bigMcp(4));

    const doc = await compose(ag);

    expect(Buffer.byteLength(doc, 'utf-8')).toBeGreaterThan(32 * 1024);
    expect(doc).not.toContain('# Omitted for size');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns while there is still headroom, before anything is dropped', async () => {
    const ag = await seed('ag-warn', 'warn-group');
    // Calibrate off whatever the repo's own instruction prose weighs today, so
    // adding a paragraph to a skill cannot break this from another file.
    const bytes = Buffer.byteLength(await compose(ag), 'utf-8');
    vi.clearAllMocks();

    const doc = await compose(ag, { ...CLAUDE_SPEC, maxBytes: Math.ceil(bytes * 1.05) });

    expect(doc).not.toContain('# Omitted for size');
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
