import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MAX_AUTO_ATTACH_BYTES,
  MAX_AUTO_ATTACH_FILES,
  attachLocalFileLinks,
  sweepLocalFileLinks,
  toLocalPath,
} from './local-file-links.js';

let tmp: string;
let workspace: string;
let outbox: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-file-links-'));
  workspace = path.join(tmp, 'agent');
  outbox = path.join(tmp, 'outbox');
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(relative: string, contents = 'x'): string {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

function attach(links: Parameters<typeof attachLocalFileLinks>[0], messageId = 'msg-1') {
  return attachLocalFileLinks(links, messageId, { outboxRoot: outbox, workspaceRoot: workspace });
}

describe('toLocalPath', () => {
  it('reduces sandbox-style schemes to a filesystem path', () => {
    expect(toLocalPath('sandbox:/workspace/agent/output/card.pdf')).toBe('/workspace/agent/output/card.pdf');
    expect(toLocalPath('sandbox:///workspace/agent/output/card.pdf')).toBe('/workspace/agent/output/card.pdf');
    expect(toLocalPath('file:///workspace/agent/output/card.pdf')).toBe('/workspace/agent/output/card.pdf');
    expect(toLocalPath('computer:///workspace/agent/out.png')).toBe('/workspace/agent/out.png');
  });

  it('passes through a schemeless path and percent-decodes it', () => {
    expect(toLocalPath('/workspace/agent/my%20card.pdf')).toBe('/workspace/agent/my card.pdf');
    expect(toLocalPath('output/card.pdf')).toBe('output/card.pdf');
  });

  it('rejects network schemes', () => {
    expect(toLocalPath('https://example.com/card.pdf')).toBeNull();
    expect(toLocalPath('mailto:someone@example.com')).toBeNull();
    expect(toLocalPath('data:text/plain;base64,QQ==')).toBeNull();
  });

  it('drops a query/fragment the model appended', () => {
    expect(toLocalPath('sandbox:/workspace/agent/card.pdf#page=2')).toBe('/workspace/agent/card.pdf');
  });
});

describe('sweepLocalFileLinks', () => {
  it('rewrites the exact Nicole-DM failure to plain labels', () => {
    const body = [
      'Done — recreated at standard business-card size with 0.125″ bleed.',
      '',
      '[Print-ready PDF](sandbox:/workspace/agent/output/card-print.pdf)',
      '',
      '[300-DPI PNG](sandbox:/workspace/agent/output/card-300dpi.png)',
    ].join('\n');

    const swept = sweepLocalFileLinks(body);

    expect(swept.links.map((l) => l.target)).toEqual([
      '/workspace/agent/output/card-print.pdf',
      '/workspace/agent/output/card-300dpi.png',
    ]);
    expect(swept.text).not.toContain('sandbox:');
    expect(swept.text).toContain('Print-ready PDF');
    expect(swept.text).toContain('300-DPI PNG');
  });

  it('handles markdown images and absolute-path links', () => {
    const swept = sweepLocalFileLinks('Here it is: ![chart](/workspace/agent/output/chart.png)');
    expect(swept.links).toHaveLength(1);
    expect(swept.links[0].target).toBe('/workspace/agent/output/chart.png');
    expect(swept.text).toBe('Here it is: chart');
  });

  it('strips a bare sandbox URI entirely (no label to keep)', () => {
    const swept = sweepLocalFileLinks('Your file: sandbox:/workspace/agent/output/card.pdf');
    expect(swept.links).toHaveLength(1);
    expect(swept.text).toBe('Your file:');
  });

  it('leaves real links and prose paths alone', () => {
    const body = 'See [the docs](https://example.com/docs) — I saved it to /workspace/agent/output/card.pdf.';
    const swept = sweepLocalFileLinks(body);
    expect(swept.links).toHaveLength(0);
    expect(swept.text).toBe(body);
  });

  it('leaves a relative markdown link alone (doc cross-reference, not a handoff)', () => {
    const body = 'See [the notes](notes/2026-08-19.md).';
    expect(sweepLocalFileLinks(body).links).toHaveLength(0);
  });

  it('collapses the blank lines a removed link leaves behind', () => {
    const swept = sweepLocalFileLinks('Done.\n\nsandbox:/workspace/agent/a.pdf\n\nAnything else?');
    expect(swept.text).toBe('Done.\n\nAnything else?');
  });

  it('is a no-op for text with no links', () => {
    const swept = sweepLocalFileLinks('just a normal reply');
    expect(swept.text).toBe('just a normal reply');
    expect(swept.links).toHaveLength(0);
  });
});

describe('attachLocalFileLinks', () => {
  it('stages a real file into the message outbox', () => {
    writeFile('output/card.pdf', 'pdf-bytes');
    const { links } = sweepLocalFileLinks(`[PDF](sandbox:${path.join(workspace, 'output/card.pdf')})`);

    expect(attach(links)).toEqual(['card.pdf']);
    expect(fs.readFileSync(path.join(outbox, 'msg-1', 'card.pdf'), 'utf-8')).toBe('pdf-bytes');
  });

  it('resolves a relative target against the workspace root', () => {
    writeFile('output/card.pdf');
    const { links } = sweepLocalFileLinks('[PDF](sandbox:output/card.pdf)');
    expect(attach(links)).toEqual(['card.pdf']);
  });

  it('skips a missing file and creates no outbox dir', () => {
    const { links } = sweepLocalFileLinks('[PDF](sandbox:/workspace/agent/nope.pdf)');
    expect(attach(links)).toEqual([]);
    expect(fs.existsSync(path.join(outbox, 'msg-1'))).toBe(false);
  });

  it('skips a directory target', () => {
    fs.mkdirSync(path.join(workspace, 'output'), { recursive: true });
    const { links } = sweepLocalFileLinks(`[dir](sandbox:${path.join(workspace, 'output')})`);
    expect(attach(links)).toEqual([]);
  });

  it('skips a file over the auto-attach cap', () => {
    const big = path.join(workspace, 'huge.bin');
    fs.writeFileSync(big, Buffer.alloc(1024));
    fs.truncateSync(big, MAX_AUTO_ATTACH_BYTES + 1);
    const { links } = sweepLocalFileLinks(`[big](sandbox:${big})`);
    expect(attach(links)).toEqual([]);
  });

  it('attaches the same file only once', () => {
    const p = writeFile('output/card.pdf');
    const { links } = sweepLocalFileLinks(`[a](sandbox:${p}) and [b](sandbox:${p})`);
    expect(links).toHaveLength(2);
    expect(attach(links)).toEqual(['card.pdf']);
  });

  it('de-collides identical basenames from different directories', () => {
    const a = writeFile('a/card.pdf', 'A');
    const b = writeFile('b/card.pdf', 'B');
    const { links } = sweepLocalFileLinks(`[a](sandbox:${a}) [b](sandbox:${b})`);

    expect(attach(links)).toEqual(['card.pdf', 'card-2.pdf']);
    expect(fs.readFileSync(path.join(outbox, 'msg-1', 'card.pdf'), 'utf-8')).toBe('A');
    expect(fs.readFileSync(path.join(outbox, 'msg-1', 'card-2.pdf'), 'utf-8')).toBe('B');
  });

  it('honours reservedNames so a send_file attachment is never overwritten', () => {
    const p = writeFile('other/card.pdf', 'OTHER');
    const { links } = sweepLocalFileLinks(`[a](sandbox:${p})`);
    const files = attachLocalFileLinks(links, 'msg-1', {
      outboxRoot: outbox,
      workspaceRoot: workspace,
      reservedNames: ['card.pdf'],
    });
    expect(files).toEqual(['card-2.pdf']);
  });

  it('honours skipPaths so send_file does not re-attach its own file', () => {
    const p = writeFile('output/card.pdf');
    const { links } = sweepLocalFileLinks(`[a](sandbox:${p})`);
    const files = attachLocalFileLinks(links, 'msg-1', {
      outboxRoot: outbox,
      workspaceRoot: workspace,
      skipPaths: [p],
    });
    expect(files).toEqual([]);
  });

  it('caps how many files one message auto-attaches', () => {
    const targets: string[] = [];
    for (let i = 0; i < MAX_AUTO_ATTACH_FILES + 3; i++) {
      targets.push(writeFile(`output/f${i}.txt`));
    }
    const { links } = sweepLocalFileLinks(targets.map((t, i) => `[f${i}](sandbox:${t})`).join(' '));
    expect(attach(links)).toHaveLength(MAX_AUTO_ATTACH_FILES);
  });

  it('returns nothing for an empty link list without touching the filesystem', () => {
    expect(attach([])).toEqual([]);
    expect(fs.existsSync(outbox)).toBe(false);
  });
});
