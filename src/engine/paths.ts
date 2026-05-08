/**
 * Path injection.
 *
 * Lets an embedding host override the directories NanoClaw uses, so the engine
 * can run under an Optimus-controlled layout instead of assuming
 * `process.cwd()` is the repo root.
 *
 * Defaults preserve current standalone behavior — the engine still resolves
 * `data/`, `groups/`, `store/` against `process.cwd()` when no override is
 * provided. A host (or test) calls `setEnginePaths({ ... })` exactly once
 * before `initDb()` to swap them.
 *
 * The existing exports in `config.ts` (`DATA_DIR`, `GROUPS_DIR`, etc.) become
 * thin getters that read from this module — no rewrite of the import sites.
 */
import os from 'os';
import path from 'path';

/**
 * A minimal shape we accept for resolving an agent-group's on-disk dir.
 * Defined here (not imported from db/) so this leaf has no internal deps.
 */
export interface GroupRef {
  id: string;
  folder: string;
}

/**
 * Optional resolver hook: given a group, return its on-disk dir
 * (absolute path). Standalone NanoClaw leaves this unset and every
 * group resolves to `<groupsDir>/<folder>`. Embedded hosts (e.g.
 * Optimus, which nests groups under workspace slugs) install a hook to
 * return `<groupsDir>/<workspace_slug>/<folder>` instead.
 *
 * Synchronous on purpose — path resolution happens on hot paths
 * (container spawn, claude-md compose, message routing) where async
 * boundaries would cascade. Hosts pre-load any DB lookups into an
 * in-memory map and answer from cache.
 *
 * Returning `null`/`undefined` falls back to the default resolution.
 */
export type GroupDirResolver = (group: GroupRef) => string | null | undefined;

export interface EnginePaths {
  /** Project / install root. Defaults to `process.cwd()`. */
  projectRoot: string;
  /** `data/` under projectRoot — sessions, central DB, runtime state. */
  dataDir: string;
  /** `groups/` under projectRoot — agent group filesystems. */
  groupsDir: string;
  /** `store/` under projectRoot — file uploads, archives. */
  storeDir: string;
  /** Mount allowlist file. Defaults to `~/.config/nanoclaw/mount-allowlist.json`. */
  mountAllowlistPath: string;
  /** Sender allowlist file. Defaults to `~/.config/nanoclaw/sender-allowlist.json`. */
  senderAllowlistPath: string;
  /** `.env` file path. Defaults to `<projectRoot>/.env`. */
  envFile: string;
  /** Container source mounts: `<projectRoot>/container`. */
  containerSourceDir: string;
  /**
   * Optional override for resolving a group's on-disk directory.
   * See {@link GroupDirResolver}.
   */
  groupDirResolver?: GroupDirResolver;
}

function defaultPaths(): EnginePaths {
  const projectRoot = process.cwd();
  const home = process.env.HOME || os.homedir();
  return {
    projectRoot,
    dataDir: path.resolve(projectRoot, 'data'),
    groupsDir: path.resolve(projectRoot, 'groups'),
    storeDir: path.resolve(projectRoot, 'store'),
    mountAllowlistPath: path.join(home, '.config', 'nanoclaw', 'mount-allowlist.json'),
    senderAllowlistPath: path.join(home, '.config', 'nanoclaw', 'sender-allowlist.json'),
    envFile: path.join(projectRoot, '.env'),
    containerSourceDir: path.join(projectRoot, 'container'),
  };
}

let _paths: EnginePaths | null = null;

export function getEnginePaths(): EnginePaths {
  if (!_paths) _paths = defaultPaths();
  return _paths;
}

export interface EnginePathOverrides {
  projectRoot?: string;
  dataDir?: string;
  groupsDir?: string;
  storeDir?: string;
  mountAllowlistPath?: string;
  senderAllowlistPath?: string;
  envFile?: string;
  containerSourceDir?: string;
  groupDirResolver?: GroupDirResolver;
}

/**
 * Resolve a group's on-disk directory. Consults the registered
 * {@link GroupDirResolver} first; falls back to `<groupsDir>/<folder>`.
 * Always returns an absolute path.
 *
 * This is the single seam every engine callsite that builds a group
 * path should use. Direct `path.resolve(GROUPS_DIR, folder)` skips the
 * hook and breaks workspace-aware embedded hosts.
 */
export function resolveGroupDir(group: GroupRef): string {
  const paths = getEnginePaths();
  const fromHook = paths.groupDirResolver?.(group);
  if (fromHook) return path.resolve(fromHook);
  return path.resolve(paths.groupsDir, group.folder);
}

/**
 * Apply path overrides. Merges with the current registry state so callers
 * can layer overrides at boot:
 *   - bootstrap.ts sets projectRoot + dataDir
 *   - host plugin (later, once cybertron DB is open) installs groupDirResolver
 * Missing fields fall back to current registry values (or the standalone
 * `process.cwd()`-derived defaults if the registry is unset).
 *
 * If `projectRoot` is supplied, the path children (dataDir, groupsDir,
 * storeDir, envFile, containerSourceDir) are re-derived from it before
 * applying explicit overrides — ensures `setEnginePaths({ projectRoot: X })`
 * by itself produces a self-consistent layout.
 */
export function setEnginePaths(overrides: EnginePathOverrides): EnginePaths {
  const current = _paths ?? defaultPaths();
  let base: EnginePaths;
  if (overrides.projectRoot) {
    // Re-derive path children from the supplied projectRoot. Hook fields
    // (groupDirResolver) survive the rederive — they aren't path-derived.
    base = {
      ...current,
      projectRoot: overrides.projectRoot,
      dataDir: path.resolve(overrides.projectRoot, 'data'),
      groupsDir: path.resolve(overrides.projectRoot, 'groups'),
      storeDir: path.resolve(overrides.projectRoot, 'store'),
      envFile: path.join(overrides.projectRoot, '.env'),
      containerSourceDir: path.join(overrides.projectRoot, 'container'),
    };
  } else {
    base = current;
  }
  _paths = { ...base, ...stripUndefined(overrides) };
  return _paths;
}

/** Test-only. */
export function _resetEnginePathsForTests(): void {
  _paths = null;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
