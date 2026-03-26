import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
      rmSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import fs from 'fs';

import {
  runContainerAgent,
  ContainerOutput,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips rewriting task snapshots when content is unchanged', () => {
    const mockedFs = fs as unknown as {
      mkdirSync: ReturnType<typeof vi.fn>;
      writeFileSync: ReturnType<typeof vi.fn>;
      readFileSync: ReturnType<typeof vi.fn>;
    };

    mockedFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const tasks = [
      {
        id: 'task-1',
        groupFolder: 'test-group',
        prompt: 'Do it',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00.000Z',
        status: 'active',
        next_run: '2026-01-01T00:00:00.000Z',
      },
    ];

    writeTasksSnapshot('test-group', false, tasks);
    writeTasksSnapshot('test-group', false, tasks);

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('skips rewriting group snapshots when visible groups are unchanged', () => {
    const mockedFs = fs as unknown as {
      mkdirSync: ReturnType<typeof vi.fn>;
      writeFileSync: ReturnType<typeof vi.fn>;
      readFileSync: ReturnType<typeof vi.fn>;
    };

    mockedFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const groups = [
      {
        jid: 'dc:1',
        name: 'Main',
        lastActivity: '2026-01-01T00:00:00.000Z',
        isRegistered: true,
      },
    ];

    writeGroupsSnapshot('main', true, groups, new Set(['dc:1']));
    writeGroupsSnapshot('main', true, groups, new Set(['dc:1']));

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('container-runner skill sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
  });

  it('skips copying skills when the source stamp is unchanged', async () => {
    const mockedFs = fs as unknown as {
      existsSync: ReturnType<typeof vi.fn>;
      readdirSync: ReturnType<typeof vi.fn>;
      statSync: ReturnType<typeof vi.fn>;
      readFileSync: ReturnType<typeof vi.fn>;
      cpSync: ReturnType<typeof vi.fn>;
      rmSync: ReturnType<typeof vi.fn>;
    };

    mockedFs.existsSync.mockImplementation((target: string) => {
      if (target.endsWith('/container/skills')) return true;
      if (target.endsWith('/.claude/skills')) return true;
      return false;
    });
    mockedFs.readdirSync.mockImplementation((target: string) => {
      if (target.endsWith('/container/skills')) return ['skill-a'];
      if (target.endsWith('/container/skills/skill-a')) return ['SKILL.md'];
      return [];
    });
    mockedFs.statSync.mockImplementation((target: string) => ({
      isDirectory: () =>
        target.endsWith('/container/skills') ||
        target.endsWith('/container/skills/skill-a'),
      size: 12,
      mtimeMs: 123,
    }));
    mockedFs.readFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/.skills-sync-stamp')) {
        return 'dir:skill-a\nfile:skill-a/SKILL.md:12:123';
      }
      return '';
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(mockedFs.cpSync).not.toHaveBeenCalledWith(
      expect.stringContaining('/container/skills/skill-a'),
      expect.any(String),
      expect.any(Object),
    );
    expect(mockedFs.rmSync).not.toHaveBeenCalled();
  });

  it('re-copies skills when the source stamp changes', async () => {
    const mockedFs = fs as unknown as {
      existsSync: ReturnType<typeof vi.fn>;
      readdirSync: ReturnType<typeof vi.fn>;
      statSync: ReturnType<typeof vi.fn>;
      readFileSync: ReturnType<typeof vi.fn>;
      cpSync: ReturnType<typeof vi.fn>;
      rmSync: ReturnType<typeof vi.fn>;
      writeFileSync: ReturnType<typeof vi.fn>;
    };

    mockedFs.existsSync.mockImplementation((target: string) => {
      if (target.endsWith('/container/skills')) return true;
      if (target.endsWith('/container/skills/skill-a')) return true;
      if (target.endsWith('/.claude/skills')) return true;
      return false;
    });
    mockedFs.readdirSync.mockImplementation((target: string) => {
      if (target.endsWith('/container/skills')) return ['skill-a'];
      if (target.endsWith('/container/skills/skill-a')) return ['SKILL.md'];
      return [];
    });
    mockedFs.statSync.mockImplementation((target: string) => ({
      isDirectory: () =>
        target.endsWith('/container/skills') ||
        target.endsWith('/container/skills/skill-a'),
      size: 99,
      mtimeMs: 456,
    }));
    mockedFs.readFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/.skills-sync-stamp')) return 'old-stamp';
      return '';
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(mockedFs.rmSync).toHaveBeenCalled();
    expect(mockedFs.cpSync).toHaveBeenCalledWith(
      expect.stringContaining('/container/skills/skill-a'),
      expect.stringContaining('/.claude/skills/skill-a'),
      { recursive: true },
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('/.skills-sync-stamp'),
      'dir:skill-a\nfile:skill-a/SKILL.md:99:456',
    );
  });
});

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});
