/**
 * Composer hooks — host overrides for the CLAUDE.md composer.
 *
 * The default composer (claude-md-compose.ts + container-runner.ts) imports
 * the bundled `container/CLAUDE.md` as the shared base and walks the
 * built-in `container/skills/` and `container/agent-runner/src/mcp-tools/`
 * trees for instruction fragments. Hosts that want to override either —
 * Optimus ships its own kernel under `groups/_kernel/container/` and wants
 * the agent to load that instead of the upstream-aligned generic kernel —
 * register here, and the default behavior degrades gracefully when no host
 * has registered.
 *
 * Two override surfaces today:
 *
 *   - sharedBaseProvider: returns the host path to mount at
 *     `/app/CLAUDE.md`. When null, the composer falls back to
 *     `<container source>/CLAUDE.md`.
 *
 *   - docsRootProvider: returns the host path to mount RO at `/app/docs/`.
 *     Lets the host ship a lazy-load reference-doc tree so the eager
 *     CLAUDE.md can stay short and link out (`@/app/docs/<topic>.md`).
 *     When null, no `/app/docs/` mount is added.
 */

export interface SharedBaseSource {
  /** Absolute host path to a CLAUDE.md file. Mounted RO at /app/CLAUDE.md. */
  hostPath: string;
}

export interface DocsRoot {
  /** Absolute host path to a directory of reference-doc markdown files. */
  hostPath: string;
}

export type SharedBaseProvider = () => SharedBaseSource | null;
export type DocsRootProvider = () => DocsRoot | null;

let sharedBaseProvider: SharedBaseProvider | null = null;
let docsRootProvider: DocsRootProvider | null = null;

export function setSharedBaseProvider(fn: SharedBaseProvider): () => void {
  if (sharedBaseProvider) {
    // Last-write-wins with a console warn; matches the existing engine
    // pattern for late-registered hooks. Returning the un-set unbinds the
    // current provider rather than the original — by design, so test
    // resets work cleanly.
    // eslint-disable-next-line no-console
    console.warn('[composer-hooks] sharedBaseProvider already set; overwriting (last-write-wins)');
  }
  sharedBaseProvider = fn;
  return () => {
    if (sharedBaseProvider === fn) sharedBaseProvider = null;
  };
}

export function getSharedBaseSource(): SharedBaseSource | null {
  return sharedBaseProvider ? sharedBaseProvider() : null;
}

export function setDocsRootProvider(fn: DocsRootProvider): () => void {
  if (docsRootProvider) {
    // eslint-disable-next-line no-console
    console.warn('[composer-hooks] docsRootProvider already set; overwriting (last-write-wins)');
  }
  docsRootProvider = fn;
  return () => {
    if (docsRootProvider === fn) docsRootProvider = null;
  };
}

export function getDocsRoot(): DocsRoot | null {
  return docsRootProvider ? docsRootProvider() : null;
}

/** Test-only. */
export function _resetComposerHooksForTests(): void {
  sharedBaseProvider = null;
  docsRootProvider = null;
}
