import { describe, it, expect } from 'vitest';
import { normType, calcTax } from './accounts';

describe('normType', () => {
  it('normalizes depository to cash', () => {
    expect(normType('depository')).toBe('cash');
  });

  it('normalizes credit types', () => {
    expect(normType('credit')).toBe('credit');
    expect(normType('credit card')).toBe('credit');
  });

  it('normalizes investment types', () => {
    expect(normType('investment')).toBe('investment');
    expect(normType('brokerage')).toBe('investment');
  });

  it('normalizes loan types', () => {
    expect(normType('loan')).toBe('loan');
    expect(normType('mortgage')).toBe('loan');
  });

  it('returns other for unknown', () => {
    expect(normType('something')).toBe('other');
    expect(normType(undefined)).toBe('other');
  });
});

describe('calcTax', () => {
  const brackets = [
    { upTo: 50000, rate: 15 },
    { upTo: 100000, rate: 20 },
    { upTo: 200000, rate: 30 },
  ];

  it('calculates tax for income in first bracket', () => {
    expect(calcTax(30000, brackets)).toBe(4500); // 30000 * 0.15
  });

  it('calculates tax across multiple brackets', () => {
    // 50000*0.15 + 20000*0.20 = 7500 + 4000 = 11500
    expect(calcTax(70000, brackets)).toBe(11500);
  });

  it('calculates tax for income above all brackets', () => {
    // 50000*0.15 + 50000*0.20 + 100000*0.30 + 50000*0.30 = 7500+10000+30000+15000 = 62500
    expect(calcTax(250000, brackets)).toBe(62500);
  });

  it('returns 0 for empty brackets', () => {
    expect(calcTax(50000, [])).toBe(0);
  });
});
