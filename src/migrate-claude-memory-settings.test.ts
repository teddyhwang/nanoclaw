import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLAUDE_SETTINGS_MAX_BYTES, prepareClaudeMemorySettings } from './migrate-claude-memory-settings.js';

let claudeDir: string;

beforeEach(() => {
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
});

afterEach(() => {
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

describe('prepareClaudeMemorySettings read limit', () => {
  it('leaves an oversized settings.json alone instead of reading it', () => {
    const file = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, CLAUDE_SETTINGS_MAX_BYTES + 1);

    expect(prepareClaudeMemorySettings(claudeDir)).toBe('unchanged');
    expect(fs.statSync(file).size).toBe(CLAUDE_SETTINGS_MAX_BYTES + 1);
  });

  it('still creates a missing settings.json', () => {
    expect(prepareClaudeMemorySettings(claudeDir)).toBe('created');
  });
});
