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
}

/**
 * Apply path overrides. Missing fields fall back to the defaults derived from
 * `projectRoot` (or the current `process.cwd()` if `projectRoot` is also
 * absent). Idempotent — call once at boot, before initDb.
 */
export function setEnginePaths(overrides: EnginePathOverrides): EnginePaths {
  const base = overrides.projectRoot ? { ...defaultPaths(), projectRoot: overrides.projectRoot } : defaultPaths();
  // Re-derive children from the supplied projectRoot if provided.
  if (overrides.projectRoot) {
    base.dataDir = path.resolve(overrides.projectRoot, 'data');
    base.groupsDir = path.resolve(overrides.projectRoot, 'groups');
    base.storeDir = path.resolve(overrides.projectRoot, 'store');
    base.envFile = path.join(overrides.projectRoot, '.env');
    base.containerSourceDir = path.join(overrides.projectRoot, 'container');
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
