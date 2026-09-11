/**
 * Flat project-document composition for agent groups.
 *
 * Every source is read on the host and inlined into one provider document.
 * Never emit `@` imports: headless Claude can silently discard imports whose
 * targets resolve outside the project directory.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseSkillSelection, sanitizeStoredMcpServers } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getSharedBaseSource } from './engine/composer-hooks.js';
import { getContextFragments, getExtraSkillRoots } from './engine/skill-roots.js';
import { readGroupPersona } from './group-persona.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

interface ProjectDocSection {
  name: string;
  body: string;
  /** Evicted before core sections when the provider document reaches its cap. */
  droppable: boolean;
}

/**
 * Typed provider variables rendered into the canonical instruction template.
 * The template prose is core-owned (`container/CLAUDE.md` is the canon);
 * providers supply only the facts below — paths, filenames, and flags — never
 * their own instruction text, so every provider's agent reads the same ideas.
 */
export interface ProviderInstructionFacts {
  /**
   * Provider-native override files agents must not use for memory storage
   * (e.g. files the provider's own runtime auto-loads). Rendered as one
   * canonical sentence inside the Memory section.
   */
  nativeOverrideFiles?: readonly string[];
  /**
   * Provider-native skill discovery, rendered as the canonical runtime-skills
   * section. Absent when the provider's runtime discovers the shared skills
   * without document guidance.
   */
  nativeSkills?: {
    /** Where the selected runtime skills appear inside the container. */
    discoveryPath: string;
    /** The read-only shared skill source the entries point back to. */
    sharedSource: string;
    /** Where agent-authored skills go, e.g. `~/.codex/skills`. */
    selfAuthoredHome: string;
    /** The only roots where skills persist and are discovered. */
    persistentRoots: readonly string[];
    /** Whether rule-bearing skills arrive inlined as sections of this document. */
    ruleBearingInlined?: boolean;
  };
}

/** Everything that differs between providers. The composition itself does not. */
export interface ProjectDocSpec {
  /** File written into the group directory, e.g. `CLAUDE.md`. */
  fileName: string;
  /** Provider variables for the canonical instruction template. */
  instructions?: ProviderInstructionFacts;
  /** @deprecated Pre-contract payload input; new contracts use the core-owned canon. */
  baseDocPath?: string;
  /** @deprecated Pre-contract payload input; new contracts use typed instruction facts. */
  extraSections?: { name: string; body: string }[];
  /** Hard byte cap. Undefined means no document cap. */
  maxBytes?: number;
}

/** The canonical instruction template, relative to the project root. */
export const BASE_INSTRUCTIONS_PATH = path.join('container', 'CLAUDE.md');

/** Placeholder inside the canon's Memory section for the provider override-files note. */
export const MEMORY_NOTE_PLACEHOLDER = '{{provider-memory-note}}';

/**
 * Render the canonical base instructions with the provider's memory note
 * substituted (or the placeholder stripped without a trace). The no-facts
 * render is byte-identical to the template minus the placeholder paragraph.
 */
export function renderBaseInstructions(template: string, facts?: ProviderInstructionFacts): string {
  const files = facts?.nativeOverrideFiles ?? [];
  const note =
    files.length > 0 ? `Do not use ${files.map((file) => `\`${file}\``).join(' or ')} for memory.` : undefined;
  return template.replace(`\n\n${MEMORY_NOTE_PLACEHOLDER}`, note ? `\n\n${note}` : '');
}

/**
 * Render the canonical runtime-skills section from the provider's declared
 * discovery facts. One prose for every provider; only the paths differ.
 */
export function renderNativeSkillsSection(
  facts?: ProviderInstructionFacts,
): { name: string; body: string } | undefined {
  const skills = facts?.nativeSkills;
  if (!skills) return undefined;
  const roots = skills.persistentRoots.map((root) => `\`${root}\``).join(' and ');
  return {
    name: 'Native Runtime Skills',
    body: [
      `Selected NanoClaw runtime skills are available as provider-native skills at \`${skills.discoveryPath}\`.`,
      `Each skill directory contains a \`SKILL.md\` with its trigger description plus any supporting files, and points to the read-only shared skill source under \`${skills.sharedSource}\`.`,
      'Use skill discovery to load these skills only when their descriptions match the task.' +
        (skills.ruleBearingInlined
          ? ' A skill whose rules must hold before the task is recognised ships an `instructions.md` instead, and those arrive inlined as `NanoClaw Skill:` sections of this document.'
          : ''),
      `Skills YOU author or install yourself go in \`${skills.selfAuthoredHome}/<name>/SKILL.md\` — persistent across sessions and discovered automatically. Never write skills elsewhere: paths outside ${roots} are ephemeral or not discovered.`,
    ].join('\n\n'),
  };
}

/**
 * Claude Code "loads a CLAUDE.md file of up to 4 MiB in full and skips a larger
 * file" (code.claude.com/docs/en/memory, read 2026-08-25). Over the cliff the
 * agent receives NO instructions at all, silently, which is the exact failure
 * this composer was rewritten to end. The only unbounded inputs are the
 * agent-writable persona and template-supplied MCP instructions, so the cap is
 * unreachable in normal use; it is here so the pathological case is loud.
 */
const CLAUDE_PROJECT_DOC_MAX_BYTES = 4 * 1024 * 1024;
const GROUP_AUTHORED_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

export const DEFAULT_PROJECT_DOC: ProjectDocSpec = {
  fileName: 'CLAUDE.md',
  maxBytes: CLAUDE_PROJECT_DOC_MAX_BYTES,
};

// LOAD-BEARING: migrate-memory identifies generated boilerplate by this exact
// prefix, so it must remain the literal first characters of every output.
const COMPOSED_HEADER =
  '<!-- Composed at spawn - do not edit. Standing instructions: instructions.prepend.md. Memory: memory/. -->';
const BASE_DOC_SECTION = 'NanoClaw Runtime Contract';
const KERNEL_FILES = ['IDENTITY.md', 'CURRENT.md', 'KNOWLEDGE.md'] as const;
const NCL_DEPENDENT_MODULES = new Set(['cli', 'scheduling']);

/** Resolve container sources the same way container-runner does for embedded hosts. */
function resolveContainerSourceDir(): string {
  if (process.env.NANOCLAW_CONTAINER_SOURCE_DIR) return path.resolve(process.env.NANOCLAW_CONTAINER_SOURCE_DIR);
  const projectRoot = process.env.NANOCLAW_PROJECT_ROOT
    ? path.resolve(process.env.NANOCLAW_PROJECT_ROOT)
    : process.cwd();
  return path.join(projectRoot, 'container');
}

function resolveBaseDocPath(baseDocPath: string, containerSourceDir: string): string {
  if (path.isAbsolute(baseDocPath)) return baseDocPath;
  const parts = baseDocPath.split(/[\\/]+/);
  if (parts[0] === 'container') return path.join(containerSourceDir, ...parts.slice(1));
  const projectRoot = process.env.NANOCLAW_PROJECT_ROOT
    ? path.resolve(process.env.NANOCLAW_PROJECT_ROOT)
    : process.cwd();
  return path.resolve(projectRoot, baseDocPath);
}

/**
 * Read an optional group-writable kernel file without following a symlink.
 * Explicit per-source accounting bounds host memory even for an agent-planted
 * multi-gigabyte file; the document-level cap remains a separate final guard.
 */
function readGroupKernelFile(filePath: string, group: AgentGroup, sourceCap: number): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    log.warn('Skipped unsafe group kernel source while composing project document', {
      group: group.name,
      file: filePath,
      reason: stat.isSymbolicLink() ? 'symlink' : 'not a regular file',
    });
    return null;
  }
  if (stat.size > sourceCap) {
    log.error('Skipped oversized group kernel source while composing project document', {
      group: group.name,
      file: filePath,
      bytes: stat.size,
      maxBytes: sourceCap,
    });
    return null;
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > sourceCap) throw new Error('kernel source changed during safe open');
    const content = fs.readFileSync(fd, 'utf-8');
    const bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes > sourceCap) throw new Error(`kernel source exceeds ${sourceCap} bytes`);
    return content;
    // All failures are contained: a hostile kernel source must not dark a group.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    log.warn('Could not safely read group kernel source while composing project document', {
      group: group.name,
      file: filePath,
      err,
    });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Regenerate one flat provider document from every enabled instruction source. */
export async function composeGroupProjectDoc(group: AgentGroup, groupDir: string, spec: ProjectDocSpec): Promise<void> {
  fs.mkdirSync(groupDir, { recursive: true });

  const configRow = await getContainerConfig(group.id);
  const mcpServers = sanitizeStoredMcpServers(configRow ? JSON.parse(configRow.mcp_servers) : {}, group.name);
  const selectedSkills = parseSkillSelection(configRow?.skills, group.name);
  const containerSourceDir = resolveContainerSourceDir();

  const sections: ProjectDocSection[] = [];
  const push = (name: string, body: string, droppable = false): void => {
    const trimmed = body.trim();
    if (trimmed) sections.push({ name, body: trimmed, droppable });
  };

  // Persona is intentionally first and never droppable.
  const persona = readGroupPersona(groupDir);
  if (persona) push('Persona', persona);

  // Optimus may supply its own kernel base. The bundled generic base is used
  // only when no host override is registered.
  const baseDoc =
    getSharedBaseSource()?.hostPath ??
    resolveBaseDocPath(spec.baseDocPath ?? BASE_INSTRUCTIONS_PATH, containerSourceDir);
  if (fs.existsSync(baseDoc) && fs.lstatSync(baseDoc).isFile()) {
    const template = fs.readFileSync(baseDoc, 'utf-8');
    push(
      BASE_DOC_SECTION,
      spec.baseDocPath !== undefined ? template : renderBaseInstructions(template, spec.instructions),
    );
  } else {
    // Tolerated (a partial checkout has no template yet) but never silent:
    // losing the runtime contract with no signal is the exact shape of the bug
    // this composer replaced, and it is also what a wrong-cwd host looks like.
    log.warn('Project document composed without its base document', {
      file: spec.fileName,
      group: group.name,
      baseDoc,
    });
  }

  // Intentional Optimus exception to upstream's persona-only group input:
  // live kernel state is part of the runtime contract. AGENTS.md is excluded.
  const kernelSourceCap = Math.min(spec.maxBytes ?? GROUP_AUTHORED_SOURCE_MAX_BYTES, GROUP_AUTHORED_SOURCE_MAX_BYTES);
  for (const fileName of KERNEL_FILES) {
    const body = readGroupKernelFile(path.join(groupDir, fileName), group, kernelSourceCap);
    if (body !== null) push(fileName, body);
  }

  for (const extra of spec.extraSections ?? []) push(extra.name, extra.body);

  const nativeSkills = renderNativeSkillsSection(spec.instructions);
  if (nativeSkills) push(nativeSkills.name, nativeSkills.body);

  // Built-in module instruction prose.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(containerSourceDir, 'agent-runner', 'src', 'mcp-tools');
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir).sort()) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (cliDisabled && NCL_DEPENDENT_MODULES.has(moduleName)) continue;
      push(`NanoClaw Module: ${moduleName}`, fs.readFileSync(path.join(mcpToolsHostDir, entry), 'utf-8'), true);
    }
  }

  // Built-in resident skill prose, filtered exactly like skill discovery.
  const emittedSkills = new Set<string>();
  const skillsHostDir = path.join(containerSourceDir, 'skills');
  if (fs.existsSync(skillsHostDir)) {
    for (const skillName of fs.readdirSync(skillsHostDir).sort()) {
      if (selectedSkills !== 'all' && !selectedSkills.includes(skillName)) continue;
      const source = path.join(skillsHostDir, skillName, 'instructions.md');
      if (!fs.existsSync(source)) continue;
      push(`NanoClaw Skill: ${skillName}`, fs.readFileSync(source, 'utf-8'), true);
      emittedSkills.add(skillName);
    }
  }

  // Plugin-registered skill roots are discoverable only at skills="all"; an
  // explicit allowlist deliberately retains built-in-only semantics.
  if (selectedSkills === 'all') {
    for (const root of getExtraSkillRoots()) {
      if (!fs.existsSync(root.hostPath)) continue;
      for (const entry of fs
        .readdirSync(root.hostPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const skillName = entry.name;
        if (!entry.isDirectory() || emittedSkills.has(skillName)) continue;
        if (root.skillFilter && !root.skillFilter(skillName, group)) continue;
        const source = path.join(root.hostPath, skillName, 'instructions.md');
        if (!fs.existsSync(source)) continue;
        push(`Host Skill: ${skillName}`, fs.readFileSync(source, 'utf-8'), true);
        emittedSkills.add(skillName);
      }
    }
  }

  for (const fragment of await getContextFragments(group)) {
    push(`Host Context: ${fragment.name}`, fragment.content, true);
  }

  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) push(`MCP Server: ${name}`, mcp.instructions, true);
  }

  const content =
    spec.maxBytes === undefined ? render(sections) : fitToCap(sections, spec.maxBytes, spec.fileName, group.name);
  writeAtomic(path.join(groupDir, spec.fileName), content);
}

function block(section: ProjectDocSection): string {
  return `# ${section.name}\n\n${section.body}`;
}

function render(sections: ProjectDocSection[]): string {
  return [COMPOSED_HEADER, ...sections.map(block)].join('\n\n') + '\n';
}

/** Drop the largest optional sections until the provider document fits. */
function fitToCap(sections: ProjectDocSection[], maxBytes: number, fileName: string, groupName: string): string {
  const dropped: string[] = [];
  const renderWithNotice = (): string => {
    const parts = [...sections];
    if (dropped.length > 0) {
      parts.push({
        name: 'Omitted for size',
        body:
          'These instruction sections were omitted to fit the project-document size cap: ' +
          `${dropped.join(', ')}. Their tools still work; consult each tool's own description.`,
        droppable: false,
      });
    }
    return render(parts);
  };

  let content = renderWithNotice();
  while (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    const [largest] = sections
      .filter((section) => section.droppable)
      .sort((a, b) => Buffer.byteLength(block(b), 'utf-8') - Buffer.byteLength(block(a), 'utf-8'));
    if (!largest) break;
    sections.splice(sections.indexOf(largest), 1);
    dropped.push(largest.name);
    content = renderWithNotice();
  }

  const bytes = Buffer.byteLength(content, 'utf-8');
  const sectionBytes = (): { section: string; bytes: number }[] =>
    sections.map((section) => ({ section: section.name, bytes: Buffer.byteLength(block(section), 'utf-8') }));
  if (dropped.length > 0) {
    log.error('Project document exceeded its size cap — dropped the largest instruction sections', {
      file: fileName,
      group: groupName,
      bytes,
      maxBytes,
      dropped,
      sections: sectionBytes(),
    });
    return content;
  }

  const warnBytes = Math.floor(maxBytes - maxBytes / 8);
  if (bytes >= warnBytes) {
    log.warn('Project document is near its size cap', {
      file: fileName,
      group: groupName,
      bytes,
      warnBytes,
      maxBytes,
      sections: sectionBytes(),
    });
  }
  return content;
}

/** Random exclusive temp creation prevents group-writable symlink squatting. */
function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
      // Cleanup must never mask the original exclusive-write result.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      // Rename consumed it, or exclusive creation failed before it existed.
    }
  }
}
