import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  TimeScale,
  BarController,
  LineController,
  DoughnutController,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';
import type { DashboardData } from '../../types';
import { buildCategoryMap } from '../../utils/categories';
import { relTime } from '../../utils/format';
import { COLORS, DATE_RANGE_OPTIONS } from '../../constants';
import { fetchDashboard, saveProperties, fetchAmazonMatches } from '../../api';
import type { AmazonMatch } from '../../api';
import { useFilterState } from '../../hooks/useFilterState';
import { Layout } from '../Layout';
import { Loading } from '../Loading';
import { FinanceSummary } from './FinanceSummary';
import { AccountsPanel } from './AccountsPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { CategoryDonut } from './CategoryDonut';
import { DailyCashFlow } from './DailyCashFlow';
import { WeeklyTrend } from './WeeklyTrend';
import { TopMerchants } from './TopMerchants';
import { TransactionsPanel } from './TransactionsPanel';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  TimeScale,
  BarController,
  LineController,
  DoughnutController,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
);

// Chart defaults
ChartJS.defaults.color = COLORS.muted;
ChartJS.defaults.borderColor = 'rgba(42,58,64,0.4)';
ChartJS.defaults.font.family = "-apple-system,'SF Pro Text','Inter',system-ui,sans-serif";
ChartJS.defaults.font.size = 12;

interface Props {
  initialData: DashboardData;
}

export function FinancePage({ initialData }: Props) {
  const [data, setData] = useState(initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [amazonMatches, setAmazonMatches] = useState<Record<string, AmazonMatch>>({});
  const [txExpanded, setTxExpanded] = useState(false);

  useEffect(() => {
    fetchAmazonMatches().then(setAmazonMatches).catch(() => {});
  }, []);

  const {
    filters,
    setFilters,
    txSort,
    setTxSort,
    setFilter,
    setWeekFilter,
    clearAllFilters,
    hasActiveFilters,
    hasChartFilter,
  } = useFilterState();

  const debitsNeg = data.user.debits_as_negative ?? false;

  const { categoryMap, categoryGroupMap } = useMemo(
    () => buildCategoryMap(data.categories),
    [data.categories],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const newData = await fetchDashboard(true);
      setData(newData);
    } catch (e) {
      console.error(e);
    }
    setRefreshing(false);
  }, []);

  const handleSaveProperty = useCallback(
    async (idx: number, value: number) => {
      const newProps = [...data.properties];
      newProps[idx] = { ...newProps[idx], value };
      setData((prev) => ({ ...prev, properties: newProps }));
      try {
        await saveProperties(newProps);
        const newData = await fetchDashboard();
        setData(newData);
      } catch (e) {
        console.error('Save failed:', e);
      }
    },
    [data.properties],
  );

  const handleDateRangeChange = useCallback(
    (range: string) => {
      setFilters((prev) => ({ ...prev, dateRange: range }));
    },
    [setFilters],
  );

  const handleWeekClick = useCallback(
    (weekStart: string | null, weekEnd: string | null) => {
      if (weekStart && weekEnd) {
        setWeekFilter(weekStart, weekEnd);
      } else {
        setFilter('week', null);
      }
    },
    [setWeekFilter, setFilter],
  );

  const ca = data.cachedAt;
  const cacheInfo = [
    ca.balances && `bal ${relTime(ca.balances)}`,
    ca.transactions && `tx ${relTime(ca.transactions)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const headerRight = (
    <>
      <span className="cache-info">{cacheInfo}</span>
      <select
        className="select-sm"
        value={filters.dateRange}
        onChange={(e) => handleDateRangeChange(e.target.value)}
      >
        {DATE_RANGE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <Layout headerRight={headerRight} refreshing={refreshing} onRefresh={handleRefresh}>
      <FinanceSummary
        accounts={data.accounts}
        properties={data.properties}
        transactions={data.transactions}
        categoryMap={categoryMap}
        debitsNeg={debitsNeg}
        dateRange={filters.dateRange}
      />
      <div className="dash-grid">
        <AccountsPanel accounts={data.accounts} />
        <PropertiesPanel
          properties={data.properties}
          accounts={data.accounts}
          onSaveProperty={handleSaveProperty}
        />
        <CategoryDonut
          transactions={data.transactions}
          categoryMap={categoryMap}
          categoryGroupMap={categoryGroupMap}
          debitsNeg={debitsNeg}
          dateRange={filters.dateRange}
          selectedCategory={filters.category}
          onCategoryClick={(cat) => setFilter('category', cat)}
        />
        <DailyCashFlow
          transactions={data.transactions}
          categoryMap={categoryMap}
          debitsNeg={debitsNeg}
          dateRange={filters.dateRange}
          selectedDay={filters.day}
          onDayClick={(day) => setFilter('day', day)}
        />
        <WeeklyTrend
          transactions={data.transactions}
          categoryMap={categoryMap}
          debitsNeg={debitsNeg}
          dateRange={filters.dateRange}
          selectedWeekStart={filters.weekStart}
          onWeekClick={handleWeekClick}
        />
        <TopMerchants
          transactions={data.transactions}
          categoryMap={categoryMap}
          debitsNeg={debitsNeg}
          dateRange={filters.dateRange}
          selectedMerchant={filters.merchant}
          onMerchantClick={(merchant) => setFilter('merchant', merchant)}
        />
        <TransactionsPanel
          transactions={data.transactions}
          categoryMap={categoryMap}
          categoryGroupMap={categoryGroupMap}
          debitsNeg={debitsNeg}
          filters={filters}
          txSort={txSort}
          hasChartFilter={hasChartFilter}
          hasActiveFilters={hasActiveFilters}
          amazonMatches={amazonMatches}
          expanded={txExpanded}
          onToggleExpand={() => setTxExpanded((v) => !v)}
          onSetFilter={setFilter}
          onSetFilters={setFilters}
          onSetTxSort={setTxSort}
          onClearAll={clearAllFilters}
        />
      </div>
    </Layout>
  );
}
