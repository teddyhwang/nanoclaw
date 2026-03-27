import { describe, it, expect } from 'vitest';
import { fmt, fmtFull, fmtPct, fmtDate, valClass, relTime } from './format';

describe('fmt', () => {
  it('formats currency without decimals', () => {
    expect(fmt(1234.56, false)).toBe('$1,235');
  });

  it('formats negative values', () => {
    expect(fmt(-500, false)).toBe('-$500');
  });

  it('masks values in privacy mode', () => {
    expect(fmt(1234, true)).toBe('$••,•••');
  });

  it('shows negative sign in privacy mode', () => {
    expect(fmt(-1234, true)).toBe('-$••,•••');
  });
});

describe('fmtFull', () => {
  it('formats with 2 decimal places', () => {
    expect(fmtFull(1234.5, false)).toBe('$1,234.50');
  });

  it('masks in privacy mode', () => {
    expect(fmtFull(1234.56, true)).toBe('$••,•••.••');
  });
});

describe('fmtPct', () => {
  it('formats positive percentage with plus sign', () => {
    expect(fmtPct(12.5, false)).toBe('+12.50%');
  });

  it('formats negative percentage', () => {
    expect(fmtPct(-3.14, false)).toBe('-3.14%');
  });

  it('masks in privacy mode', () => {
    expect(fmtPct(12.5, true)).toBe('•.••%');
  });
});

describe('fmtDate', () => {
  it('formats date string', () => {
    const result = fmtDate('2024-01-15');
    expect(result).toContain('Jan');
    expect(result).toContain('15');
    expect(result).toContain('2024');
  });
});

describe('valClass', () => {
  it('returns pos for positive', () => {
    expect(valClass(100)).toBe('pos');
  });

  it('returns neg for negative', () => {
    expect(valClass(-100)).toBe('neg');
  });

  it('returns empty for zero', () => {
    expect(valClass(0)).toBe('');
  });
});

describe('relTime', () => {
  it('returns empty for undefined', () => {
    expect(relTime(undefined)).toBe('');
  });

  it('returns "now" for very recent', () => {
    expect(relTime(new Date().toISOString())).toBe('now');
  });
});
