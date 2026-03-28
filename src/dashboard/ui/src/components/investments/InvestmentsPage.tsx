import { useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, NavLink } from 'react-router-dom';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
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
import type { InvestmentData } from '../../types';
import { fetchInvestments, updateInvestmentField, saveInvestmentData } from '../../api';
import { COLORS } from '../../constants';
// relTime moved to SubNav.SyncInfo
import { SubNav, PageContent } from '@/components/shared';
import subNavStyles from '@/components/shared/SubNav.module.css';
import { Layout } from '../Layout';
import { Loading } from '../Loading';
import { Overview } from './Overview';
import { YearDetail } from './YearDetail';
import { Salaries } from './Salaries';

ChartJS.register(CategoryScale, LinearScale, BarController, LineController, DoughnutController, BarElement, LineElement, PointElement, ArcElement, Filler, Tooltip, Legend);
ChartJS.defaults.color = COLORS.muted;
ChartJS.defaults.borderColor = 'rgba(42,58,64,0.4)';
ChartJS.defaults.font.family = "-apple-system,'SF Pro Text','Inter',system-ui,sans-serif";
ChartJS.defaults.font.size = 12;

interface Props {
  initialData: InvestmentData;
}

export function InvestmentsPage({ initialData }: Props) {
  const [data, setData] = useState(initialData);
  const [refreshing, setRefreshing] = useState(false);
  const { year } = useParams<{ year?: string }>();
  const navigate = useNavigate();

  // Determine view from URL params
  const location = window.location.pathname;
  const view = useMemo(() => {
    if (location === '/investments/salaries') return 'salaries';
    if (year) return `year-${year}`;
    return 'overview';
  }, [location, year]);

  const years = useMemo(
    () => Object.keys(data.years).sort((a, b) => Number(b) - Number(a)),
    [data.years],
  );

  const balCachedAt = data.cachedAt?.balances ?? null;

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const newData = await fetchInvestments();
      setData(newData);
    } catch (e) {
      console.error(e);
    }
    setRefreshing(false);
  }, []);

  const handleUpdateField = useCallback(
    async (yr: string, path: string[], value: number) => {
      try {
        await updateInvestmentField(yr, path, value);
        const newData = await fetchInvestments();
        setData(newData);
      } catch (e) {
        console.error('Save failed:', e);
      }
    },
    [],
  );

  const handleSaveSalaryField = useCallback(
    async (idx: number, field: string, value: number) => {
      const newData = { ...data };
      const newSalaries = [...newData.salaries];
      newSalaries[idx] = { ...newSalaries[idx], [field]: value };
      newData.salaries = newSalaries;
      try {
        await saveInvestmentData(newData);
        const refreshed = await fetchInvestments();
        setData(refreshed);
      } catch (e) {
        console.error('Save failed:', e);
      }
    },
    [data],
  );

  return (
    <Layout refreshing={refreshing} onRefresh={handleRefresh}>
      <SubNav>
        <NavLink
          to="/investments"
          end
          className={({ isActive }) => isActive && view === 'overview' ? subNavStyles.tabActive : subNavStyles.tab}
        >
          Overview
        </NavLink>
        <NavLink
          to="/investments/salaries"
          className={({ isActive }) => isActive ? subNavStyles.tabActive : subNavStyles.tab}
        >
          Salaries
        </NavLink>
        <SubNav.Separator />
        {years.map((y) => (
          <NavLink
            key={y}
            to={`/investments/${y}`}
            className={({ isActive }) => isActive ? subNavStyles.tabActive : subNavStyles.tab}
          >
            {y}
          </NavLink>
        ))}
        <SubNav.SyncInfo timestamps={{ bal: balCachedAt }} />
      </SubNav>

      <PageContent style={{ padding: 'var(--g)', display: 'flex', flexDirection: 'column' }}>
        {view === 'overview' && <Overview data={data} />}
        {view === 'salaries' && (
          <Salaries data={data} onSaveSalaryField={handleSaveSalaryField} />
        )}
        {view.startsWith('year-') && (
          <YearDetail
            year={view.replace('year-', '')}
            data={data}
            onUpdateField={handleUpdateField}
          />
        )}
      </PageContent>
    </Layout>
  );
}
