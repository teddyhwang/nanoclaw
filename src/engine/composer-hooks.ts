/**
 * Host overrides for flat project-document composition.
 *
 * The default composer inlines the bundled `container/CLAUDE.md`, built-in
 * module prose, and selected skill instructions. Optimus supplies its own
 * kernel base here so the flat document contains that contract instead of the
 * upstream-aligned generic one.
 *
 * The docs-root hook remains separate: container-runner mounts it read-only at
 * `/app/docs/` for lazy reference loading. Flat composition removes project-doc
 * import mounts, not this intentional reference tree.
 */

export interface SharedBaseSource {
  /** Absolute host path to a trusted base document, inlined at compose time. */
  hostPath: string;
}

export interface DocsRoot {
  /** Absolute host path to a directory of reference-doc markdown files. */
  hostPath: string;
}

export interface SharedDreamSource {
  /** Absolute host path to a DREAM.md file. Nested RO-mounted at
   *  /workspace/agent/DREAM.md for every group, so the consolidation
   *  protocol stays single-source. */
  hostPath: string;
}

export type SharedBaseProvider = () => SharedBaseSource | null;
export type DocsRootProvider = () => DocsRoot | null;
export type SharedDreamProvider = () => SharedDreamSource | null;

let sharedBaseProvider: SharedBaseProvider | null = null;
let docsRootProvider: DocsRootProvider | null = null;
let sharedDreamProvider: SharedDreamProvider | null = null;

export function setSharedBaseProvider(fn: SharedBaseProvider): () => void {
  if (sharedBaseProvider) {
    // Last-write-wins with a console warn; matches the existing engine
    // pattern for late-registered hooks. Returning the un-set unbinds the
    // current provider rather than the original — by design, so test
    // resets work cleanly.
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

export function setSharedDreamProvider(fn: SharedDreamProvider): () => void {
  if (sharedDreamProvider) {
    console.warn('[composer-hooks] sharedDreamProvider already set; overwriting (last-write-wins)');
  }
  sharedDreamProvider = fn;
  return () => {
    if (sharedDreamProvider === fn) sharedDreamProvider = null;
  };
}

export function getSharedDreamSource(): SharedDreamSource | null {
  return sharedDreamProvider ? sharedDreamProvider() : null;
}

/** Test-only. */
export function _resetComposerHooksForTests(): void {
  sharedBaseProvider = null;
  docsRootProvider = null;
  sharedDreamProvider = null;
}
