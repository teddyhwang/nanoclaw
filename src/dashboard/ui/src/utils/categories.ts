import type { Category, Transaction } from '../types';
import { EXCLUDED_CATS } from '../constants';

export type CategoryMap = Record<number, Category>;
export type CategoryGroupMap = Record<number, string>;

export function buildCategoryMap(categories: Category[]): {
  categoryMap: CategoryMap;
  categoryGroupMap: CategoryGroupMap;
} {
  const categoryMap: CategoryMap = {};
  const categoryGroupMap: CategoryGroupMap = {};
  for (const c of categories) {
    categoryMap[c.id] = c;
    if (c.children) {
      for (const ch of c.children) {
        categoryMap[ch.id] = ch;
        categoryGroupMap[ch.id] = c.name;
      }
    }
  }
  return { categoryMap, categoryGroupMap };
}

export function getCategoryGroup(
  catId: number,
  categoryMap: CategoryMap,
  categoryGroupMap: CategoryGroupMap,
): string {
  return categoryGroupMap[catId] || categoryMap[catId]?.name || 'Uncategorized';
}

export function spendAmt(tx: Transaction, debitsNeg: boolean): number {
  const v = parseFloat(tx.amount);
  return debitsNeg ? -v : v;
}

export function isSpend(
  tx: Transaction,
  categoryMap: CategoryMap,
  debitsNeg: boolean,
): boolean {
  if (tx.is_income || tx.exclude_from_totals) return false;
  const c = categoryMap[tx.category_id];
  if (c?.is_income) return false;
  if (c && EXCLUDED_CATS.includes(c.name.toLowerCase())) return false;
  return spendAmt(tx, debitsNeg) > 0;
}

export function isIncome(tx: Transaction, categoryMap: CategoryMap): boolean {
  if (tx.exclude_from_totals) return false;
  if (tx.is_income) return true;
  const c = categoryMap[tx.category_id];
  if (c?.is_income) return true;
  const names = [
    'income',
    'wages',
    'dividends',
    'interest earned',
    'rental income',
    'tax refund',
  ];
  if (c && names.includes(c.name.toLowerCase())) return true;
  return false;
}
