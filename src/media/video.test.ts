import { describe, expect, it } from 'vitest';

import { formatVideoMarker, pickFrameCount, pickFrameTimestamps, processVideo } from './video.js';

describe('pickFrameCount', () => {
  it('uses duration tiers', () => {
    expect(pickFrameCount(5)).toBe(2);
    expect(pickFrameCount(10)).toBe(2);
    expect(pickFrameCount(11)).toBe(3);
    expect(pickFrameCount(60)).toBe(3);
    expect(pickFrameCount(120)).toBe(5);
    expect(pickFrameCount(180)).toBe(5);
    expect(pickFrameCount(400)).toBe(8);
    expect(pickFrameCount(600)).toBe(8);
    expect(pickFrameCount(601)).toBe(10);
    expect(pickFrameCount(3600)).toBe(10);
  });
});

describe('pickFrameTimestamps', () => {
  it('returns empty for non-positive inputs', () => {
    expect(pickFrameTimestamps(0, 3)).toEqual([]);
    expect(pickFrameTimestamps(60, 0)).toEqual([]);
    expect(pickFrameTimestamps(-1, 3)).toEqual([]);
  });

  it('returns the midpoint for a single frame', () => {
    expect(pickFrameTimestamps(60, 1)).toEqual([30]);
  });

  it('spreads frames evenly with an end offset to avoid black EOF frames', () => {
    // last = 60 - 0.1 = 59.9; count=3 → [0, 29.95, 59.9]
    const ts = pickFrameTimestamps(60, 3);
    expect(ts).toHaveLength(3);
    expect(ts[0]).toBe(0);
    expect(ts[1]).toBeCloseTo(29.95, 5);
    expect(ts[2]).toBeCloseTo(59.9, 5);
  });

  it('never seeks to the absolute end', () => {
    const ts = pickFrameTimestamps(10, 2);
    expect(ts[ts.length - 1]).toBeLessThan(10);
  });
});

describe('formatVideoMarker', () => {
  it('renders both transcript and summary', () => {
    expect(formatVideoMarker('hello', 'a wave')).toBe('[Video: hello | Summary: a wave]');
  });

  it('renders transcript only', () => {
    expect(formatVideoMarker('hello', '')).toBe('[Video: hello]');
    expect(formatVideoMarker('hello', '   ')).toBe('[Video: hello]');
  });

  it('renders summary only', () => {
    expect(formatVideoMarker('', 'a wave')).toBe('[Video: Summary: a wave]');
  });

  it('renders the empty placeholder when neither is present', () => {
    expect(formatVideoMarker('', '')).toBe('[Video: (no speech, no visual summary)]');
    expect(formatVideoMarker('  ', '\n')).toBe('[Video: (no speech, no visual summary)]');
  });
});

describe('processVideo guards', () => {
  it('returns null on an empty buffer', async () => {
    const out = await processVideo(Buffer.alloc(0), { frameDir: '/tmp/never-used' });
    expect(out).toBeNull();
  });

  it('returns null when no Gemini credential is available', async () => {
    const out = await processVideo(Buffer.from('not a real video'), {
      frameDir: '/tmp/never-used',
      getCredential: () => null,
    });
    expect(out).toBeNull();
  });

  it('returns null (does not throw) when the credential reader throws', async () => {
    const out = await processVideo(Buffer.from('not a real video'), {
      frameDir: '/tmp/never-used',
      getCredential: () => {
        throw new Error('reader boom');
      },
    });
    expect(out).toBeNull();
  });
});
