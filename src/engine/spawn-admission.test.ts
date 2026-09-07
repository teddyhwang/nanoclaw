import { describe, expect, it, vi } from 'vitest';
import { acquireSpawnAdmission, addSpawnAdmissionGuard } from './spawn-admission.js';
import type { Session } from '../types.js';

const session = (id: string) => ({ id }) as Session;

describe('spawn admission', () => {
  it('counts concurrent cold-start reservations and releases failed setup slots', async () => {
    const remove = addSpawnAdmissionGuard(async (_s, occupied) => {
      await Promise.resolve();
      return occupied.length < 2;
    });
    const leases: Array<(() => void) | null> = [];
    try {
      leases.push(
        ...(await Promise.all(['a', 'b', 'c', 'd'].map((id) => acquireSpawnAdmission(session(id), () => [])))),
      );
      expect(leases.filter(Boolean)).toHaveLength(2);
      leases[0]?.();
      leases.push(await acquireSpawnAdmission(session('retry'), () => []));
      expect(leases.at(-1)).not.toBeNull();
    } finally {
      leases.forEach((release) => release?.());
      remove();
    }
  });

  it('counts adopted/running runtimes once and allows interactive bypass', async () => {
    const remove = addSpawnAdmissionGuard((s, occupied) => s.id === 'chat' || occupied.length < 1);
    let release: (() => void) | null = null;
    try {
      expect(await acquireSpawnAdmission(session('dream'), () => ['running', 'running'])).toBeNull();
      release = await acquireSpawnAdmission(session('chat'), () => ['running']);
      expect(release).not.toBeNull();
    } finally {
      release?.();
      remove();
    }
  });

  it('bounds a stuck admission lookup and releases the global queue', async () => {
    vi.useFakeTimers();
    const remove = addSpawnAdmissionGuard(() => new Promise<boolean>(() => {}));
    try {
      const failed = expect(acquireSpawnAdmission(session('stuck'), () => [])).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(5000);
      await failed;
    } finally {
      remove();
      vi.useRealTimers();
    }
    const release = await acquireSpawnAdmission(session('after-timeout'), () => []);
    expect(release).not.toBeNull();
    release?.();
  });

  it('unlocks after a guard throws instead of wedging future wakes', async () => {
    const remove = addSpawnAdmissionGuard(() => {
      throw new Error('lookup failed');
    });
    try {
      await expect(acquireSpawnAdmission(session('fail'), () => [])).rejects.toThrow('lookup failed');
    } finally {
      remove();
    }
    const release = await acquireSpawnAdmission(session('ok'), () => []);
    expect(release).not.toBeNull();
    release?.();
  });
});
