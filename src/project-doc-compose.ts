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

export interface ProjectDocSpec {
  /** File written into the group directory, e.g. `CLAUDE.md`. */
  fileName: string;
  /** Shared base document relative to the project root. Missing is tolerated loudly. */
  baseDocPath: string;
  /** Provider-owned blocks after the shared base, before capabilities. */
  extraSections?: { name: string; body: string }[];
  /** Hard byte cap. Undefined means no document cap. */
  maxBytes?: number;
}

const CLAUDE_PROJECT_DOC_MAX_BYTES = 4 * 1024 * 1024;
const GROUP_AUTHORED_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

export const DEFAULT_PROJECT_DOC: ProjectDocSpec = {
  fileName: 'CLAUDE.md',
  baseDocPath: path.join('container', 'CLAUDE.md'),
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
  const baseDoc = getSharedBaseSource()?.hostPath ?? resolveBaseDocPath(spec.baseDocPath, containerSourceDir);
  if (fs.existsSync(baseDoc) && fs.lstatSync(baseDoc).isFile()) {
    push(BASE_DOC_SECTION, fs.readFileSync(baseDoc, 'utf-8'));
  } else {
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
