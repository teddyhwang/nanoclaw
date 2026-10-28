import fs from 'fs';
import path from 'path';

import { AnchoredDir } from './anchored-dir.js';
import { log } from './log.js';

/** Per-group standing instructions prepended to every provider's project document. */
export const PERSONA_PREPEND_FILE = 'instructions.prepend.md';
/**
 * Largest standing-instructions file read. The group folder is mounted
 * read-write into the container, so the file's size is container-chosen; a
 * larger file is refused (persona omitted) rather than read into memory.
 */
export const PERSONA_MAX_BYTES = 256 * 1024;

/**
 * Create a group's standing instructions without following or replacing an
 * existing path. Returns false when the content is empty or the path exists.
 */
export function stageGroupPersona(groupDir: string, instructions: string): boolean {
  const content = instructions.trimEnd();
  if (!content.trim()) return false;

  fs.mkdirSync(groupDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), `${content}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Read a group's standing instructions without following symlinks, without
 * blocking on a planted FIFO, and at most PERSONA_MAX_BYTES of them.
 */
export function readGroupPersona(groupDir: string): string | null {
  const file = path.join(groupDir, PERSONA_PREPEND_FILE);
  let dir: AnchoredDir | null = null;
  try {
    dir = AnchoredDir.open(groupDir, []);
    if (!dir) return null;
    const content = dir.readFile(PERSONA_PREPEND_FILE, { maxBytes: PERSONA_MAX_BYTES }).toString('utf-8').trim();
    return content || null;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn('Could not read group standing instructions; omitting persona', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    dir?.close();
  }
}
