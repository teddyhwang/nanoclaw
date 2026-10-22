/**
 * Hardened plugin-directory walk + copy.
 *
 * Plugin content is DATA on the host: it gets validated and copied, never
 * executed. This module is the containment boundary for the copy half — every
 * file that leaves a plugin directory for a group workspace goes through
 * here, never through raw fs.cpSync (which follows symlinks).
 *
 * Fail closed: any violation (symlink, special file, path escape, cap
 * overrun) throws and rejects the whole plugin. This is deliberately stricter
 * than the Agent Plugins spec, which permits symlinks resolving within the
 * plugin root; a client MAY reject them, and we do.
 */
import fs from 'fs';
import path from 'path';

import type { AnchoredDir } from '../anchored-dir.js';

// Abuse bounds, not sizing guidance — the real templates are a few dozen
// files each.
export const MAX_PLUGIN_FILES = 2000;
export const MAX_PLUGIN_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_PLUGIN_DEPTH = 16;

export interface PluginFile {
  /** Path relative to the plugin root, '/'-separated. */
  rel: string;
  abs: string;
  size: number;
  mode: number;
}

/**
 * Walk a plugin directory, validating every entry. Returns the regular files
 * found. Throws on the first symlink, special file, path escape, or cap
 * violation — the caller must treat that as "reject the whole plugin".
 */
export function walkPluginDir(root: string): PluginFile[] {
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Plugin rejected: the plugin root must be a regular directory');
  }
  const files: PluginFile[] = [];
  // Directories count toward the entry cap too — a breadth bomb of empty
  // dirs must trip the same abuse bound as a file bomb.
  let entries = 0;
  let totalBytes = 0;

  const visit = (relDir: string, depth: number): void => {
    const absDir = relDir ? path.join(resolvedRoot, relDir) : resolvedRoot;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const name = entry.name;
      // readdir never returns separators or dot-entries, but the whole point
      // of this module is to not trust the input tree.
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        throw new Error(`Plugin rejected: entry name "${name}" in ${relDir || '.'} is not allowed`);
      }
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(absDir, name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Plugin rejected: "${rel}" is a symlink (symlinks are not allowed in plugins)`);
      }
      if (depth + 1 > MAX_PLUGIN_DEPTH) {
        throw new Error(`Plugin rejected: "${rel}" exceeds the maximum nesting depth of ${MAX_PLUGIN_DEPTH}`);
      }
      entries += 1;
      if (entries > MAX_PLUGIN_FILES) {
        throw new Error(`Plugin rejected: more than ${MAX_PLUGIN_FILES} entries`);
      }
      if (entry.isDirectory()) {
        visit(rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Plugin rejected: "${rel}" is not a regular file or directory`);
      }
      const stat = fs.lstatSync(abs);
      files.push({ rel, abs, size: stat.size, mode: stat.mode });
      totalBytes += stat.size;
      if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
        throw new Error(`Plugin rejected: total size exceeds ${MAX_PLUGIN_TOTAL_BYTES} bytes`);
      }
    }
  };

  visit('', 0);
  return files;
}

/**
 * Copy a validated plugin tree. `dest` is replaced wholesale so re-stamping
 * is idempotent. Re-walks `src` at copy time so the validation and the copy
 * see the same tree.
 */
export function copyPluginDir(src: string, dest: string): void {
  const files = walkPluginDir(src);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const file of files) {
    const target = path.join(dest, ...file.rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // COPYFILE_EXCL: dest was freshly created above, so any existing target is
    // a concurrently planted symlink — fail loudly rather than write through.
    fs.copyFileSync(file.abs, target, fs.constants.COPYFILE_EXCL);
    // Preserve the executable bit — skills legitimately ship scripts.
    fs.chmodSync(target, file.mode & 0o777);
  }
}

/**
 * copyPluginDir for a destination inside a container-writable tree: `name` is
 * replaced wholesale inside `parent`, which the caller pinned by descriptor.
 * Every remove, mkdir and create goes through descriptors and never follows a
 * symlink, so a container swapping a name mid-copy cannot redirect the host.
 */
export function copyPluginDirInto(src: string, parent: AnchoredDir, name: string): void {
  const files = walkPluginDir(src);
  parent.removeTree(name);
  const root = parent.openDir(name, true);
  if (!root) throw new Error(`could not create plugin directory '${name}'`);
  try {
    for (const file of files) {
      const segments = file.rel.split('/');
      const leaf = segments.pop()!;
      const opened: AnchoredDir[] = [];
      try {
        let dir = root;
        for (const segment of segments) {
          const next = dir.openDir(segment, true);
          if (!next) throw new Error(`could not create plugin directory '${segment}'`);
          opened.push(next);
          dir = next;
        }
        // O_EXCL | O_NOFOLLOW: the tree was just created, so anything already
        // holding the name was planted — fail loudly rather than write through.
        const fd = dir.openNewFd(leaf);
        try {
          fs.writeFileSync(fd, fs.readFileSync(file.abs));
          // Preserve the executable bit — skills legitimately ship scripts.
          fs.fchmodSync(fd, file.mode & 0o777);
        } finally {
          fs.closeSync(fd);
        }
      } finally {
        for (const dir of opened) dir.close();
      }
    }
  } finally {
    root.close();
  }
}
