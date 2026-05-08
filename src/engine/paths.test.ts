import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';

import { _resetEnginePathsForTests, getEnginePaths, resolveGroupDir, setEnginePaths } from './paths.js';

describe('setEnginePaths', () => {
  beforeEach(() => {
    _resetEnginePathsForTests();
  });

  it('merges new overrides with the current registry instead of clobbering', () => {
    setEnginePaths({ projectRoot: '/tmp/p1' });
    expect(getEnginePaths().dataDir).toBe(path.resolve('/tmp/p1', 'data'));

    // A second call without projectRoot should NOT reset projectRoot/dataDir
    // back to defaults — embedded hosts layer overrides over time
    // (bootstrap sets projectRoot first, then a plugin installs the resolver
    // hook later once the DB is open).
    const resolver = () => '/tmp/custom';
    setEnginePaths({ groupDirResolver: resolver });

    const after = getEnginePaths();
    expect(after.projectRoot).toBe('/tmp/p1');
    expect(after.dataDir).toBe(path.resolve('/tmp/p1', 'data'));
    expect(after.groupDirResolver).toBe(resolver);
  });

  it('re-deriving from projectRoot preserves a previously-installed resolver', () => {
    const resolver = () => '/tmp/custom';
    setEnginePaths({ groupDirResolver: resolver });
    setEnginePaths({ projectRoot: '/tmp/p2' });

    const after = getEnginePaths();
    expect(after.projectRoot).toBe('/tmp/p2');
    expect(after.groupsDir).toBe(path.resolve('/tmp/p2', 'groups'));
    expect(after.groupDirResolver).toBe(resolver);
  });
});

describe('resolveGroupDir', () => {
  beforeEach(() => {
    _resetEnginePathsForTests();
  });

  it('falls back to <groupsDir>/<folder> when no resolver is registered', () => {
    setEnginePaths({ projectRoot: '/tmp/proj' });
    const dir = resolveGroupDir({ id: 'ag-1', folder: 'discord_dm_teddy' });
    expect(dir).toBe(path.resolve('/tmp/proj', 'groups', 'discord_dm_teddy'));
  });

  it('uses the resolver when it returns a path', () => {
    setEnginePaths({
      projectRoot: '/tmp/proj',
      groupDirResolver: (group) =>
        group.id === 'ag-1' ? path.resolve('/tmp/proj', 'groups', 'degenerates', group.folder) : null,
    });

    expect(resolveGroupDir({ id: 'ag-1', folder: 'discord_dm_teddy' })).toBe(
      path.resolve('/tmp/proj', 'groups', 'degenerates', 'discord_dm_teddy'),
    );
  });

  it('falls back to flat layout when the resolver returns null/undefined', () => {
    setEnginePaths({
      projectRoot: '/tmp/proj',
      groupDirResolver: () => null,
    });
    expect(resolveGroupDir({ id: 'ag-X', folder: 'unmapped_group' })).toBe(
      path.resolve('/tmp/proj', 'groups', 'unmapped_group'),
    );
  });
});
