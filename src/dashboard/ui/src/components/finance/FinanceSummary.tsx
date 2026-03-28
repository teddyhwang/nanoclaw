import type { Account, Property, Transaction } from '../../types';
import type { CategoryMap } from '../../utils/categories';
import { normType } from '../../utils/accounts';
import { spendAmt, isSpend, isIncome } from '../../utils/categories';
import { fmt } from '../../utils/format';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { getDateRange } from '../../utils/dates';

interface Props {
  accounts: Account[];
  properties: Property[];
  transactions: Transaction[];
  categoryMap: CategoryMap;
  debitsNeg: boolean;
  dateRange: string;
}

export function FinanceSummary({
  accounts,
  properties,
  transactions,
  categoryMap,
  debitsNeg,
  dateRange,
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

  const { from: ms, to: me } = getDateRange(dateRange);
  let income = 0;
  let spent = 0;
  for (const tx of transactions) {
    if (tx.date < ms || tx.date > me) continue;
    const amt = spendAmt(tx, debitsNeg);
    if (isIncome(tx, categoryMap)) income += Math.abs(amt);
    else if (isSpend(tx, categoryMap, debitsNeg)) spent += amt;
  }
  const net = income - spent;

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
