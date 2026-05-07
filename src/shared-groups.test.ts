import { describe, it, expect, afterEach } from 'vitest';

import { setSharedGroupsResolver, resolveSharedGroups, type SharedGroupsResolver } from './shared-groups.js';
import type { AgentGroup } from './types.js';

const fakeGroup: AgentGroup = {
  id: 'ag-test',
  name: 'Test',
  folder: 'test',
  agent_provider: null,
  created_at: '2026-01-01',
} as AgentGroup;

describe('shared-groups resolver seam', () => {
  afterEach(() => {
    setSharedGroupsResolver(null);
  });

  it('returns [] when no resolver registered', () => {
    expect(resolveSharedGroups(fakeGroup)).toEqual([]);
  });

  it('passes the agent group to the resolver and returns its result', () => {
    let received: AgentGroup | null = null;
    const resolver: SharedGroupsResolver = (g) => {
      received = g;
      return [{ folder: 'shared', name: 'Shared', channel: 'discord' }];
    };
    setSharedGroupsResolver(resolver);
    const out = resolveSharedGroups(fakeGroup);
    expect(received).toBe(fakeGroup);
    expect(out).toEqual([{ folder: 'shared', name: 'Shared', channel: 'discord' }]);
  });

  it('returns [] when resolver throws (host bug should not break spawn)', () => {
    setSharedGroupsResolver(() => {
      throw new Error('host bug');
    });
    expect(resolveSharedGroups(fakeGroup)).toEqual([]);
  });
});
