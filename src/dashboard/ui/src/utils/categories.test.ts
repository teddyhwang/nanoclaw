import { describe, it, expect } from 'vitest';
import {
  buildCategoryMap,
  getCategoryGroup,
  spendAmt,
  isSpend,
  isIncome,
} from './categories';
import type { Category, Transaction } from '../types';

const categories: Category[] = [
  {
    id: 1,
    name: 'Food',
    children: [
      { id: 11, name: 'Groceries' },
      { id: 12, name: 'Restaurants' },
    ],
  },
  { id: 2, name: 'Income', is_income: true },
  { id: 3, name: 'Transfer' },
];

const { categoryMap, categoryGroupMap } = buildCategoryMap(categories);

describe('buildCategoryMap', () => {
  it('maps parent categories', () => {
    expect(categoryMap[1].name).toBe('Food');
  });

  it('maps child categories', () => {
    expect(categoryMap[11].name).toBe('Groceries');
    expect(categoryMap[12].name).toBe('Restaurants');
  });

  it('builds group map for children', () => {
    expect(categoryGroupMap[11]).toBe('Food');
    expect(categoryGroupMap[12]).toBe('Food');
  });
});

describe('getCategoryGroup', () => {
  it('returns parent group for child', () => {
    expect(getCategoryGroup(11, categoryMap, categoryGroupMap)).toBe('Food');
  });

  it('returns own name for parent', () => {
    expect(getCategoryGroup(1, categoryMap, categoryGroupMap)).toBe('Food');
  });

  it('returns Uncategorized for unknown', () => {
    expect(getCategoryGroup(999, categoryMap, categoryGroupMap)).toBe(
      'Uncategorized',
    );
  });
});

describe('spendAmt', () => {
  const tx = { amount: '50.00' } as Transaction;

  it('returns positive when debitsNeg is false', () => {
    expect(spendAmt(tx, false)).toBe(50);
  });

  it('negates when debitsNeg is true', () => {
    expect(spendAmt(tx, true)).toBe(-50);
  });
});

describe('isSpend', () => {
  it('returns true for normal spend', () => {
    const tx = { amount: '50.00', category_id: 11 } as Transaction;
    expect(isSpend(tx, categoryMap, false)).toBe(true);
  });

  it('returns false for income transactions', () => {
    const tx = {
      amount: '50.00',
      category_id: 2,
      is_income: true,
    } as Transaction;
    expect(isSpend(tx, categoryMap, false)).toBe(false);
  });

  it('returns false for excluded categories', () => {
    const tx = { amount: '50.00', category_id: 3 } as Transaction;
    expect(isSpend(tx, categoryMap, false)).toBe(false);
  });

  it('returns false for excluded_from_totals', () => {
    const tx = {
      amount: '50.00',
      category_id: 11,
      exclude_from_totals: true,
    } as Transaction;
    expect(isSpend(tx, categoryMap, false)).toBe(false);
  });
});

describe('isIncome', () => {
  it('returns true for income category', () => {
    const tx = { amount: '-100', category_id: 2 } as Transaction;
    expect(isIncome(tx, categoryMap)).toBe(true);
  });

  it('returns true for is_income flag', () => {
    const tx = {
      amount: '-100',
      category_id: 11,
      is_income: true,
    } as Transaction;
    expect(isIncome(tx, categoryMap)).toBe(true);
  });

  it('returns false for excluded_from_totals', () => {
    const tx = {
      amount: '-100',
      category_id: 2,
      exclude_from_totals: true,
    } as Transaction;
    expect(isIncome(tx, categoryMap)).toBe(false);
  });
});
