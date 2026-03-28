import { describe, it, expect } from 'vitest';
import { toISO, weekRange, getDateRange } from './dates';

describe('toISO', () => {
  it('formats date as YYYY-MM-DD', () => {
    expect(toISO(new Date(2024, 0, 15))).toBe('2024-01-15');
  });
});

describe('weekRange', () => {
  it('returns Monday-Sunday for a Wednesday', () => {
    const result = weekRange('2024-01-17'); // Wednesday
    expect(result.start).toBe('2024-01-15'); // Monday
    expect(result.end).toBe('2024-01-21'); // Sunday
  });

  it('returns Monday-Sunday for a Monday', () => {
    const result = weekRange('2024-01-15');
    expect(result.start).toBe('2024-01-15');
    expect(result.end).toBe('2024-01-21');
  });
});

describe('getDateRange', () => {
  it('returns wide range for "all"', () => {
    const result = getDateRange('all');
    expect(result.from).toBe('2000-01-01');
    expect(result.to).toBe('2099-12-31');
  });

  it('returns correct range for ytd', () => {
    const result = getDateRange('ytd');
    const year = new Date().getFullYear();
    expect(result.from).toBe(`${year}-01-01`);
  });
});
