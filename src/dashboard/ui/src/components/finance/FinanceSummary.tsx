import type { Account, Property, Transaction, FilterState } from '../../types';
import type { CategoryMap, CategoryGroupMap } from '../../utils/categories';
import { normType } from '../../utils/accounts';
import { spendAmt, isSpend, isIncome, getCategoryGroup } from '../../utils/categories';
import { fmt } from '../../utils/format';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { getDateRange } from '../../utils/dates';
import { EXCLUDED_CATS } from '../../constants';
import { useMemo } from 'react';

interface Props {
  accounts: Account[];
  properties: Property[];
  transactions: Transaction[];
  categoryMap: CategoryMap;
  categoryGroupMap: CategoryGroupMap;
  debitsNeg: boolean;
  filters: FilterState;
}

export function FinanceSummary({
  accounts,
  properties,
  transactions,
  categoryMap,
  categoryGroupMap,
  debitsNeg,
  filters,
}: Props) {
  const { privacyMode } = usePrivacy();

  const totals: Record<string, number> = { cash: 0, investment: 0, credit: 0, property: 0, loan: 0, other: 0 };
  let loanTotal = 0;
  for (const a of accounts) {
    const t = normType(a.type);
    const b = a.to_base != null ? a.to_base : parseFloat(a.balance);
    if (t === 'credit') totals.credit -= b;
    else if (t === 'loan') loanTotal += Math.abs(b);
    else totals[t] = (totals[t] || 0) + b;
  }
  const propValuation = properties.reduce((s, p) => s + p.value, 0);
  totals.property = propValuation - loanTotal;
  const netWorth = Object.values(totals).reduce((s, v) => s + v, 0);

  const { income, spent, net } = useMemo(() => {
    const { from: ms, to: me } = getDateRange(filters.dateRange);
    const hasChartFilter =
      !!filters.day || !!filters.weekStart || !!filters.category || !!filters.merchant;

    let inc = 0;
    let sp = 0;
    for (const tx of transactions) {
      if (tx.date < ms || tx.date > me) continue;
      if (hasChartFilter) {
        const c = categoryMap[tx.category_id];
        if (c && EXCLUDED_CATS.includes(c.name.toLowerCase())) continue;
      }
      if (filters.day && tx.date !== filters.day) continue;
      if (filters.weekStart && (tx.date < filters.weekStart || tx.date > (filters.weekEnd || '')))
        continue;
      if (filters.category) {
        const cn = getCategoryGroup(tx.category_id, categoryMap, categoryGroupMap);
        if (cn !== filters.category) continue;
      }
      if (filters.merchant) {
        const p = tx.payee || tx.original_name || '';
        if (p !== filters.merchant) continue;
      }
      if (
        filters.search &&
        !(tx.payee || '').toLowerCase().includes(filters.search) &&
        !(tx.original_name || '').toLowerCase().includes(filters.search)
      ) continue;
      if (filters.catId && tx.category_id !== Number(filters.catId)) continue;

      const amt = spendAmt(tx, debitsNeg);
      if (isIncome(tx, categoryMap)) inc += Math.abs(amt);
      else if (isSpend(tx, categoryMap, debitsNeg)) sp += amt;
    }
    return { income: inc, spent: sp, net: inc - sp };
  }, [transactions, filters, categoryMap, categoryGroupMap, debitsNeg]);

  return (
    <div className="finance-summary">
      <div className="finance-summary-grid">
        <div className="finance-stat finance-stat-emphasis">
          <span className="finance-stat-label">Net Worth</span>
          <span className="finance-stat-value orange">{fmt(netWorth, privacyMode)}</span>
        </div>
        <div className="finance-stat">
          <span className="finance-stat-label">Investments</span>
          <span className="finance-stat-value pos">{fmt(totals.investment || 0, privacyMode)}</span>
        </div>
        <div className="finance-stat">
          <span className="finance-stat-label">Property</span>
          <span className={`finance-stat-value ${totals.property >= 0 ? 'pos' : 'neg'}`}>
            {fmt(totals.property || 0, privacyMode)}
          </span>
        </div>
        <div className="finance-stat">
          <span className="finance-stat-label">Income</span>
          <span className="finance-stat-value pos">{fmt(income, privacyMode)}</span>
        </div>
        <div className="finance-stat">
          <span className="finance-stat-label">Spent</span>
          <span className="finance-stat-value orange">{fmt(spent, privacyMode)}</span>
        </div>
        <div className={`finance-stat finance-stat-${net >= 0 ? 'pos' : 'neg'} finance-stat-emphasis`}>
          <span className="finance-stat-label">Net</span>
          <span className={`finance-stat-value ${net >= 0 ? 'pos' : 'neg'}`}>
            {fmt(net, privacyMode)}
          </span>
        </div>
      </div>
    </div>
  );
}
