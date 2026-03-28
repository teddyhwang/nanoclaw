import { useState, useCallback } from 'react';
import type { FilterState, SortState } from '../types';
import { FINANCE_UI_STATE_KEY } from '../constants';

function loadSavedState(): { filters: FilterState; txSort: SortState } {
  try {
    const raw = localStorage.getItem(FINANCE_UI_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        filters: {
          day: parsed.filters?.day || null,
          weekStart: parsed.filters?.weekStart || null,
          weekEnd: parsed.filters?.weekEnd || null,
          category: parsed.filters?.category || null,
          merchant: parsed.filters?.merchant || null,
          search: parsed.filters?.search || '',
          catId: parsed.filters?.catId || '',
          dateRange: parsed.filters?.dateRange || '90days',
        },
        txSort: parsed.txSort?.col
          ? parsed.txSort
          : { col: 'date', dir: -1 as const },
      };
    }
  } catch {}
  return {
    filters: {
      day: null,
      weekStart: null,
      weekEnd: null,
      category: null,
      merchant: null,
      search: '',
      catId: '',
      dateRange: '90days',
    },
    txSort: { col: 'date', dir: -1 },
  };
}

function saveState(filters: FilterState, txSort: SortState) {
  localStorage.setItem(
    FINANCE_UI_STATE_KEY,
    JSON.stringify({ filters, txSort }),
  );
}

export function useFilterState() {
  const saved = loadSavedState();
  const [filters, setFiltersRaw] = useState<FilterState>(saved.filters);
  const [txSort, setTxSortRaw] = useState<SortState>(saved.txSort);

  const setFilters = useCallback(
    (updater: FilterState | ((prev: FilterState) => FilterState)) => {
      setFiltersRaw((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        saveState(next, txSort);
        return next;
      });
    },
    [txSort],
  );

  const setTxSort = useCallback(
    (updater: SortState | ((prev: SortState) => SortState)) => {
      setTxSortRaw((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        saveState(filters, next);
        return next;
      });
    },
    [filters],
  );

  const setFilter = useCallback(
    (type: string, value: string | null) => {
      setFilters((prev) => {
        const next = { ...prev };
        switch (type) {
          case 'day':
            next.day = value;
            next.weekStart = null;
            next.weekEnd = null;
            break;
          case 'week':
            next.weekStart = null;
            next.weekEnd = null;
            next.day = null;
            break;
          case 'category':
            next.category = value;
            break;
          case 'merchant':
            next.merchant = value;
            break;
        }
        return next;
      });
    },
    [setFilters],
  );

  const setWeekFilter = useCallback(
    (weekStart: string, weekEnd: string) => {
      setFilters((prev) => ({
        ...prev,
        weekStart,
        weekEnd,
        day: null,
      }));
    },
    [setFilters],
  );

  const clearAllFilters = useCallback(() => {
    setFilters((prev) => ({
      ...prev,
      day: null,
      weekStart: null,
      weekEnd: null,
      category: null,
      merchant: null,
      search: '',
      catId: '',
    }));
  }, [setFilters]);

  const hasActiveFilters =
    !!filters.day ||
    !!filters.weekStart ||
    !!filters.category ||
    !!filters.merchant ||
    !!filters.search ||
    !!filters.catId;

  const hasChartFilter =
    !!filters.day ||
    !!filters.weekStart ||
    !!filters.category ||
    !!filters.merchant;

  return {
    filters,
    setFilters,
    txSort,
    setTxSort,
    setFilter,
    setWeekFilter,
    clearAllFilters,
    hasActiveFilters,
    hasChartFilter,
  };
}
