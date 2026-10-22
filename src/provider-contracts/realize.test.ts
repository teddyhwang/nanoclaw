import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import './index.js';
import { prepareSpawnFile, protectedProviderDocumentSourcePaths, providerDocumentSourcePath } from './realize.js';
import { PROVIDER_HOST_CONTRACT_SEAM_VERSION, getProviderHostContract, type ProviderHostContract } from './registry.js';

const ROOT = '/srv/nanoclaw';
const CANON = path.resolve(ROOT, 'container', 'CLAUDE.md');

function fakeContract(): ProviderHostContract {
  return {
    seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
    projectDocument: {
      fileName: 'AGENTS.md',
      containerPath: '/workspace/agent/AGENTS.md',
      mountClass: 'group-state',
    },
    stateVolumes: [],
    skillBackings: [],
    skillViews: [],
    files: [],
  };
}

describe('append-open-close prepared files', () => {
  const volume = {
    id: 'state',
    directory: 'state',
    containerPath: '/home/node/.state',
    scope: 'session' as const,
    mode: 'rw' as const,
    mountClass: 'group-state' as const,
  };
  const file = {
    id: 'history',
    volumeId: 'state',
    relativePath: 'logs/history.jsonl',
    prepare: { operation: 'append-open-close' as const, when: 'every-spawn' as const },
  };

  it('creates the file inside the volume', () => {
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-realize-'));
    try {
      prepareSpawnFile(file, new Map([['state', volume]]), 'ag', session);
      expect(fs.statSync(path.join(session, 'state', 'logs', 'history.jsonl')).isFile()).toBe(true);
    } finally {
      fs.rmSync(session, { recursive: true, force: true });
    }
  });

  it('does not create the file through a container-planted parent symlink', () => {
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-realize-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-realize-outside-'));
    try {
      fs.mkdirSync(path.join(session, 'state'));
      fs.symlinkSync(outside, path.join(session, 'state', 'logs'));
      expect(() => prepareSpawnFile(file, new Map([['state', volume]]), 'ag', session)).toThrow(/not a real directory/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(session, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('protectedProviderDocumentSourcePaths', () => {
  it('protects the canonical template for the installed Claude contract', () => {
    expect(protectedProviderDocumentSourcePaths(ROOT)).toEqual([CANON]);
  });

  it('protects the canon regardless of which contracts are registered', () => {
    // Protection is core-owned since every contract renders from the one
    // canonical template; no declaration switches it on or off.
    expect(getProviderHostContract('claude')).toBeDefined();
    expect(providerDocumentSourcePath(ROOT, fakeContract())).toBe(CANON);
    expect(protectedProviderDocumentSourcePaths(ROOT)).toEqual([CANON]);
  });
});
