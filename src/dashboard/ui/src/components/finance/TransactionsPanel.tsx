import { useMemo, useState, useCallback } from 'react';
import type { Transaction, FilterState, SortState } from '../../types';
import type { CategoryMap, CategoryGroupMap } from '../../utils/categories';
import { spendAmt, isSpend, isIncome, getCategoryGroup } from '../../utils/categories';
import { fmtFull, fmtDate } from '../../utils/format';
import { getDateRange } from '../../utils/dates';
import { TX_PER_PAGE, EXCLUDED_CATS } from '../../constants';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { FilterPills } from './FilterPills';

interface Props {
  transactions: Transaction[];
  categoryMap: CategoryMap;
  categoryGroupMap: CategoryGroupMap;
  debitsNeg: boolean;
  filters: FilterState;
  txSort: SortState;
  hasChartFilter: boolean;
  hasActiveFilters: boolean;
  onSetFilter: (type: string, value: string | null) => void;
  onSetFilters: (updater: (prev: FilterState) => FilterState) => void;
  onSetTxSort: (updater: (prev: SortState) => SortState) => void;
  onClearAll: () => void;
}

export function TransactionsPanel({
  transactions,
  categoryMap,
  categoryGroupMap,
  debitsNeg,
  filters,
  txSort,
  hasChartFilter,
  hasActiveFilters: _hasActiveFilters,
  onSetFilter,
  onSetFilters,
  onSetTxSort,
  onClearAll,
}: Props) {
  const { privacyMode } = usePrivacy();
  const [page, setPage] = useState(0);

  // Category dropdown options
  const categoryOptions = useMemo(() => {
    const seen = new Set<number>();
    const names: [number, string][] = [];
    for (const tx of transactions) {
      const c = categoryMap[tx.category_id];
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        names.push([c.id, c.name]);
      }
    }
    return names.sort((a, b) => a[1].localeCompare(b[1]));
  }, [transactions, categoryMap]);

  // Filter + sort
  const filtered = useMemo(() => {
    const { from, to } = getDateRange(filters.dateRange);
    const chartActive = hasChartFilter;
    let result = transactions.filter((tx) => {
      if (tx.date < from || tx.date > to) return false;
      if (chartActive) {
        const c = categoryMap[tx.category_id];
        if (c && EXCLUDED_CATS.includes(c.name.toLowerCase())) return false;
      }
      if (filters.day && tx.date !== filters.day) return false;
      if (filters.weekStart && (tx.date < filters.weekStart || tx.date > (filters.weekEnd || '')))
        return false;
      if (filters.category) {
        const cn = getCategoryGroup(tx.category_id, categoryMap, categoryGroupMap);
        if (cn !== filters.category) return false;
      }
      if (filters.merchant) {
        const p = tx.payee || tx.original_name || '';
        if (p !== filters.merchant) return false;
      }
      if (
        filters.search &&
        !(tx.payee || '').toLowerCase().includes(filters.search) &&
        !(tx.original_name || '').toLowerCase().includes(filters.search)
      )
        return false;
      if (filters.catId && tx.category_id !== Number(filters.catId)) return false;
      return true;
    });

    const { col, dir } = txSort;
    const isNum = col === 'amount';
    result.sort((a, b) => {
      let ka: string | number, kb: string | number;
      switch (col) {
        case 'date':
          ka = a.date;
          kb = b.date;
          break;
        case 'payee':
          ka = (a.payee || a.original_name || '').toLowerCase();
          kb = (b.payee || b.original_name || '').toLowerCase();
          break;
        case 'category':
          ka = (categoryMap[a.category_id]?.name || '').toLowerCase();
          kb = (categoryMap[b.category_id]?.name || '').toLowerCase();
          break;
        case 'amount':
          ka = spendAmt(a, debitsNeg);
          kb = spendAmt(b, debitsNeg);
          break;
        default:
          ka = '';
          kb = '';
      }
      if (isNum) return ((ka as number) - (kb as number)) * dir;
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir;
    });
    return result;
  }, [transactions, categoryMap, categoryGroupMap, debitsNeg, filters, txSort, hasChartFilter]);

  // Reset page when filters change
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / TX_PER_PAGE) - 1));
  const pageData = filtered.slice(currentPage * TX_PER_PAGE, (currentPage + 1) * TX_PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / TX_PER_PAGE));

  const handleSort = useCallback(
    (col: string) => {
      onSetTxSort((prev) => {
        if (prev.col === col) return { col, dir: (prev.dir * -1) as 1 | -1 };
        return { col, dir: col === 'amount' ? -1 : 1 };
      });
      setPage(0);
    },
    [onSetTxSort],
  );

  const sortArrow = (col: string) => {
    if (txSort.col !== col) return '';
    return txSort.dir === 1 ? '↑' : '↓';
  };

  return (
    <div className="panel tx-panel">
      <div className="tx-head">
        <div className="tx-head-left">
          <span className="panel-head-text">Transactions</span>
          <FilterPills
            filters={filters}
            categoryMap={categoryMap}
            onSetFilter={onSetFilter}
            onClearAll={onClearAll}
            onClearSearch={() =>
              onSetFilters((prev) => ({ ...prev, search: '' }))
            }
            onClearCatId={() =>
              onSetFilters((prev) => ({ ...prev, catId: '' }))
            }
          />
        </div>
        <div className="tx-controls">
          <input
            type="text"
            className="input-sm"
            placeholder="Search…"
            value={filters.search}
            onChange={(e) => {
              onSetFilters((prev) => ({ ...prev, search: e.target.value.toLowerCase() }));
              setPage(0);
            }}
          />
          <select
            className="select-sm"
            value={filters.catId}
            onChange={(e) => {
              onSetFilters((prev) => ({ ...prev, catId: e.target.value }));
              setPage(0);
            }}
          >
            <option value="">All Categories</option>
            {categoryOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="tx-scroll">
        <table className="tx-table">
          <thead>
            <tr>
              {(['date', 'payee', 'category', 'amount'] as const).map((col) => (
                <th
                  key={col}
                  className={`sortable${txSort.col === col ? ' active' : ''}${col === 'amount' ? ' r' : ''}`}
                  onClick={() => handleSort(col)}
                >
                  {col.charAt(0).toUpperCase() + col.slice(1)}{' '}
                  <span className="sort-arrow">{sortArrow(col)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.map((tx) => {
              const cat = categoryMap[tx.category_id];
              const amt = spendAmt(tx, debitsNeg);
              const isCr = amt < 0;
              const inc = isIncome(tx, categoryMap);
              return (
                <tr key={tx.id}>
                  <td className="date">{fmtDate(tx.date)}</td>
                  <td className="payee">{tx.payee || tx.original_name || '—'}</td>
                  <td className="cat">{cat?.name || '—'}</td>
                  <td className={`r ${isCr || inc ? 'credit' : 'debit'}`}>
                    {isCr ? '+' : ''}
                    {fmtFull(Math.abs(amt), privacyMode, tx.currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="tx-foot">
        <button className="btn-sm" disabled={currentPage === 0} onClick={() => setPage((p) => p - 1)}>
          ←
        </button>
        <span className="tx-info">
          {filtered.length
            ? `${currentPage * TX_PER_PAGE + 1}–${Math.min((currentPage + 1) * TX_PER_PAGE, filtered.length)} of ${filtered.length}`
            : 'No transactions'}
        </span>
        <button
          className="btn-sm"
          disabled={currentPage >= totalPages - 1}
          onClick={() => setPage((p) => p + 1)}
        >
          →
        </button>
      </div>
    </div>
  );
}
