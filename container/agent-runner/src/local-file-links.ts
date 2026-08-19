/**
 * Salvage local-file links out of outbound chat text.
 *
 * Models trained against a hosted-sandbox UI reach for a markdown link when
 * they have produced a file, because in that UI the link renders as a
 * download button: ChatGPT-lineage models emit `sandbox:/mnt/data/report.pdf`,
 * others emit `file:///...` or `computer:///...`. None of those schemes mean
 * anything to a NanoClaw destination. On Telegram / WhatsApp / Discord they
 * arrive as dead text and the user sees a link they cannot open.
 *
 * Observed 2026-08-19 in Nicole's Telegram DM: the agent (codex / gpt-5.6)
 * built a business-card PDF and a 300-DPI PNG under `/workspace/agent/output/`
 * and replied with `[Print-ready PDF](sandbox:/workspace/agent/output/...)`.
 * Nicole replied "Cannot access these photos" and both files had to be
 * hand-resent through `send_file`.
 *
 * The only way a file reaches a user is `send_file` — an outbox copy plus a
 * `files` array on the outbound row. A prompt rule saying so is worth having
 * (see `mcp-tools/core.instructions.md`) but is not a guarantee: this is a
 * strong pretrained habit, and the failure is silent and user-visible. So the
 * runner sweeps every agent-authored outbound body here. A link that points at
 * a real file on disk becomes a genuine attachment; the dead markup is
 * rewritten down to its plain label either way, so the user never sees a
 * `sandbox:` URI even when the file is gone.
 *
 * Deliberately narrow: only markdown links/images and standalone
 * `sandbox:` / `file://` / `computer://` URIs count as a delivery gesture. A
 * bare path mentioned in prose ("I saved it to /workspace/agent/output/") is
 * left alone — the agent is describing its own filesystem, not handing the
 * user a file.
 */
import fs from 'fs';
import path from 'path';

/** Where `send_file` stages attachments for the host to pick up. */
export const DEFAULT_OUTBOX_ROOT = '/workspace/outbox';

/** Agent workspace root — relative link targets resolve against it. */
export const DEFAULT_WORKSPACE_ROOT = '/workspace/agent';

/**
 * Container paths are fixed mounts in production. The env overrides exist so
 * the wiring can be exercised off-container (tests run on the host, where
 * `/workspace` does not exist); they are read per call, not at import.
 */
function resolveOutboxRoot(explicit?: string): string {
  return explicit ?? process.env.NANOCLAW_OUTBOX_ROOT ?? DEFAULT_OUTBOX_ROOT;
}

function resolveWorkspaceRoot(explicit?: string): string {
  return explicit ?? process.env.NANOCLAW_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT;
}

/**
 * The outbox directory a given outbound message stages its attachments in.
 * Every writer of `content.files` must agree on this path — the host reads
 * `outbox/<messageId>/<filename>` back at delivery time.
 */
export function outboxDirFor(messageId: string, explicitRoot?: string): string {
  return path.join(resolveOutboxRoot(explicitRoot), messageId);
}

/**
 * Per-file ceiling for an *automatic* attach. `send_file` itself is
 * unbounded because the agent asked for it explicitly; this path fires on an
 * inferred intent, so a runaway link (a multi-hundred-MB intermediate render
 * sitting next to the real deliverable) should degrade to a stripped label
 * rather than push a huge payload through every channel adapter.
 */
export const MAX_AUTO_ATTACH_BYTES = 25 * 1024 * 1024;

/** Ceiling on files auto-attached to a single message. */
export const MAX_AUTO_ATTACH_FILES = 5;

/** Schemes that mean "here is your file" in some other product's UI. */
const LOCAL_FILE_SCHEME_RE = /^(?:sandbox:|file:\/\/|computer:\/\/)/i;

export interface DetectedFileLink {
  /** Exact source substring to remove, e.g. `[Print-ready PDF](sandbox:/a.pdf)`. */
  raw: string;
  /** Label to leave behind in the prose, or `null` for a bare URI. */
  label: string | null;
  /** Decoded, scheme-stripped path the link points at. */
  target: string;
}

export interface SweptText {
  /** Body with every detected link rewritten to its plain label. */
  text: string;
  /** Links found, in source order. */
  links: DetectedFileLink[];
}

/**
 * Turn a link target into a filesystem path, or `null` if it is a real URL.
 *
 * `sandbox:/workspace/x.pdf`, `sandbox:///workspace/x.pdf`, `file:///workspace/x.pdf`
 * and a plain `/workspace/x.pdf` all reduce to `/workspace/x.pdf`. Anything
 * with a network-ish scheme (`https:`, `mailto:`, `tel:`) is left alone.
 */
export function toLocalPath(target: string): string | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) return null;

  let rest: string;
  if (LOCAL_FILE_SCHEME_RE.test(trimmed)) {
    rest = trimmed.replace(LOCAL_FILE_SCHEME_RE, '');
    // `file://host/path` and `sandbox:///path` both collapse to `/path`.
    rest = rest.replace(/^\/{2,}/, '/');
    if (rest.length === 0) return null;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    // Some other scheme (http, https, data, mailto) — not ours.
    return null;
  } else {
    rest = trimmed;
  }

  // Drop a fragment/query the model may have appended; paths do not use them.
  rest = rest.split('#')[0].split('?')[0];
  if (rest.length === 0) return null;

  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // Malformed percent-escapes — use the raw form rather than dropping the link.
  }
  if (decoded.includes('\0')) return null;
  return decoded;
}

/**
 * Is this target a *local file* delivery gesture rather than a normal link?
 *
 * A sandbox-style scheme always counts. A schemeless target only counts when
 * it is an absolute path — a relative markdown link is far more likely to be
 * a doc cross-reference than a file handoff.
 */
function isLocalFileTarget(target: string): boolean {
  const trimmed = target.trim();
  if (LOCAL_FILE_SCHEME_RE.test(trimmed)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  return trimmed.startsWith('/');
}

/**
 * Find local-file links in `text` and return the body with each one reduced to
 * its label. Pure — no filesystem access, no attachment.
 */
export function sweepLocalFileLinks(text: string): SweptText {
  if (!text) return { text, links: [] };

  const links: DetectedFileLink[] = [];
  let swept = text;

  // Markdown links and images: `[label](target)` / `![label](target)`.
  // The target group stops at whitespace or `)` so a trailing title string
  // (`[a](/x.pdf "title")`) does not end up in the path.
  swept = swept.replace(/(!?)\[([^\]]*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g, (raw, _bang, label, target) => {
    if (!isLocalFileTarget(target)) return raw;
    const resolved = toLocalPath(target);
    if (!resolved) return raw;
    const cleanLabel = String(label).trim();
    links.push({ raw, label: cleanLabel || null, target: resolved });
    return cleanLabel;
  });

  // Bare sandbox-style URIs the model dropped in without markdown. Absolute
  // paths are intentionally NOT matched here — an unadorned `/workspace/...`
  // in prose is the agent narrating, not handing over a file.
  swept = swept.replace(/(?:sandbox:|file:\/\/|computer:\/\/)[^\s<>()[\]"'`]+/gi, (raw) => {
    const resolved = toLocalPath(raw);
    if (!resolved) return raw;
    links.push({ raw, label: null, target: resolved });
    return '';
  });

  if (links.length === 0) return { text, links: [] };
  return { text: tidy(swept), links };
}

/**
 * Collapse the whitespace damage left by removing links: trailing spaces on a
 * line, lines that became empty, and runs of blank lines.
 */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface AttachOptions {
  outboxRoot?: string;
  workspaceRoot?: string;
  /** Paths already delivered by the caller (e.g. `send_file`'s own file). */
  skipPaths?: string[];
  /** Filenames already staged in this message's outbox — never overwrite them. */
  reservedNames?: string[];
  log?: (message: string) => void;
}

/**
 * Copy each detected link's file into `<outboxRoot>/<messageId>/` and return
 * the filenames to record in the outbound row's `files` array.
 *
 * Best-effort by design: a link pointing at a missing, oversized, or
 * unreadable file is skipped and only its markup disappears. The message
 * still goes out — a half-delivered reply beats a thrown error on the
 * delivery path.
 */
export function attachLocalFileLinks(
  links: DetectedFileLink[],
  messageId: string,
  options: AttachOptions = {},
): string[] {
  if (links.length === 0) return [];

  const outboxRoot = resolveOutboxRoot(options.outboxRoot);
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const log = options.log ?? (() => {});

  const skip = new Set<string>();
  for (const candidate of options.skipPaths ?? []) {
    try {
      skip.add(fs.realpathSync(candidate));
    } catch {
      skip.add(path.resolve(candidate));
    }
  }

  const outboxDir = outboxDirFor(messageId, outboxRoot);
  const seenSources = new Set<string>();
  const usedNames = new Set<string>(options.reservedNames ?? []);
  const filenames: string[] = [];

  for (const link of links) {
    if (filenames.length >= MAX_AUTO_ATTACH_FILES) {
      log(`local-file-link: attach cap (${MAX_AUTO_ATTACH_FILES}) reached, stripping remaining links`);
      break;
    }

    const resolvedPath = path.isAbsolute(link.target) ? link.target : path.resolve(workspaceRoot, link.target);

    let realPath: string;
    let stat: fs.Stats;
    try {
      realPath = fs.realpathSync(resolvedPath);
      stat = fs.statSync(realPath);
    } catch {
      log(`local-file-link: no file at ${resolvedPath} — link stripped, nothing attached`);
      continue;
    }
    if (!stat.isFile()) {
      log(`local-file-link: ${resolvedPath} is not a regular file — link stripped`);
      continue;
    }
    if (stat.size > MAX_AUTO_ATTACH_BYTES) {
      log(`local-file-link: ${resolvedPath} is ${stat.size} bytes, over the auto-attach cap — link stripped`);
      continue;
    }
    if (skip.has(realPath)) continue;
    if (seenSources.has(realPath)) continue;
    seenSources.add(realPath);

    const filename = uniqueAttachmentName(path.basename(realPath), usedNames);
    if (!filename) {
      log(`local-file-link: cannot derive a safe attachment name for ${realPath} — link stripped`);
      continue;
    }

    try {
      fs.mkdirSync(outboxDir, { recursive: true });
      fs.copyFileSync(realPath, path.join(outboxDir, filename));
    } catch (err) {
      log(`local-file-link: failed to stage ${realPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    usedNames.add(filename);
    filenames.push(filename);
    log(`local-file-link: auto-attached ${filename} (link rewritten from ${link.raw.slice(0, 80)})`);
  }

  return filenames;
}

/**
 * Derive an attachment name the host will accept (`isSafeAttachmentName`:
 * a plain basename, never `.`/`..`, no separators) and that has not already
 * been used for this message.
 */
function uniqueAttachmentName(basename: string, used: Set<string>): string | null {
  let base = basename.replace(/[\\/\0]/g, '_').trim();
  if (base === '' || base === '.' || base === '..') return null;

  if (!used.has(base)) return base;

  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}
