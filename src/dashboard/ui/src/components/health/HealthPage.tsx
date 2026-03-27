import { useState, useEffect, useCallback } from 'react';
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
import type { HealthData } from '../../types';
import { fetchHealth } from '../../api';
import { Layout } from '../Layout';
import { Loading } from '../Loading';
import { HealthSummary } from './HealthSummary';
import { StepsChart } from './StepsChart';
import { HeartRateChart } from './HeartRateChart';
import { WeightChart } from './WeightChart';
import { WorkoutsTable } from './WorkoutsTable';
import { WorkoutBreakdown } from './WorkoutBreakdown';
import { ActivityRings } from './ActivityRings';
import '../../styles/health.css';

ChartJS.register(
  CategoryScale, LinearScale, BarController, LineController,
  DoughnutController, BarElement, LineElement, PointElement,
  ArcElement, Filler, Tooltip, Legend,
);

export type HealthRange = '7d' | '14d' | '30d' | '90d' | 'ytd' | '2025' | '2024' | '2023' | '2022' | '2021' | '2020';

interface RangeConfig {
  value: HealthRange;
  label: string;
  group: 'relative' | 'year';
  params: { days?: number; since?: string };
  displayLabel: string;
}

const RANGES: RangeConfig[] = [
  { value: '7d',   label: '7D',   group: 'relative', params: { days: 7 },    displayLabel: '7 days' },
  { value: '14d',  label: '14D',  group: 'relative', params: { days: 14 },   displayLabel: '14 days' },
  { value: '30d',  label: '30D',  group: 'relative', params: { days: 30 },   displayLabel: '30 days' },
  { value: '90d',  label: '90D',  group: 'relative', params: { days: 90 },   displayLabel: '90 days' },
  { value: 'ytd',  label: 'YTD',  group: 'relative', params: { since: `${new Date().getFullYear()}-01-01` }, displayLabel: 'year to date' },
  { value: '2025', label: '2025', group: 'year', params: { since: '2025-01-01' }, displayLabel: '2025' },
  { value: '2024', label: '2024', group: 'year', params: { since: '2024-01-01' }, displayLabel: '2024' },
  { value: '2023', label: '2023', group: 'year', params: { since: '2023-01-01' }, displayLabel: '2023' },
  { value: '2022', label: '2022', group: 'year', params: { since: '2022-01-01' }, displayLabel: '2022' },
  { value: '2021', label: '2021', group: 'year', params: { since: '2021-01-01' }, displayLabel: '2021' },
  { value: '2020', label: '2020', group: 'year', params: { since: '2020-01-01' }, displayLabel: '2020' },
];

const RANGE_MAP = Object.fromEntries(RANGES.map(r => [r.value, r])) as Record<HealthRange, RangeConfig>;

export function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [weight90, setWeight90] = useState<{ weight: HealthData['weight']; bodyFat: HealthData['bodyFat'] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<HealthRange>('30d');

  const loadData = useCallback(async (r: HealthRange) => {
    try {
      const cfg = RANGE_MAP[r];
      const d = await fetchHealth(cfg.params);
      // For historical year ranges, filter out data past that year
      if (cfg.group === 'year') {
        const year = parseInt(cfg.value);
        if (year && year < new Date().getFullYear()) {
          const cutoff = `${year + 1}-01-01`;
          const filterDate = <T extends { date: string }>(arr: T[]) => arr.filter(x => x.date < cutoff);
          d.steps = filterDate(d.steps);
          d.restingHeartRate = filterDate(d.restingHeartRate);
          d.heartRateVariability = filterDate(d.heartRateVariability);
          d.weight = filterDate(d.weight);
          d.bodyFat = filterDate(d.bodyFat);
          d.activityRings = filterDate(d.activityRings);
          d.workouts = filterDate(d.workouts);
          d.workoutTypeBreakdown = recomputeBreakdown(d.workouts);
          d.weeklyStepAverage = d.weeklyStepAverage.filter(x => x.week < cutoff);
        }
      }
      setData(d);
      setError(null);

      // If range is short (<=30 days) and weight data is sparse, prefetch 90-day weight
      const days = cfg.params.days;
      if (days && days <= 30 && d.weight.length < 3) {
        try {
          const wider = await fetchHealth({ days: 90 });
          setWeight90({ weight: wider.weight, bodyFat: wider.bodyFat });
        } catch { /* ignore */ }
      } else {
        setWeight90(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load health data');
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { loadData(range); }, [range, loadData]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadData(range);
  }, [range, loadData]);

  const handleRangeChange = useCallback((r: HealthRange) => {
    setRefreshing(true);
    setRange(r);
  }, []);

  const rangeLabel = RANGE_MAP[range].displayLabel;

  if (loading) return <Loading message="Loading health data…" />;
  if (error || !data) return <Loading error={error || 'No health data available'} />;

  return (
    <Layout>
      <nav className="sub-nav">
        {RANGES.map((r, i) => {
          // Insert separator between relative and year groups
          const prev = RANGES[i - 1];
          const showSep = prev && prev.group !== r.group;
          return (
            <span key={r.value} style={{ display: 'contents' }}>
              {showSep && <div className="sub-sep" />}
              <button
                className={`sub-tab${range === r.value ? ' active' : ''}`}
                onClick={() => handleRangeChange(r.value)}
              >
                {r.label}
              </button>
            </span>
          );
        })}
      </nav>
      <div className="health-content">
        <HealthSummary data={data} />
        <div className="health-grid">
          <div className="health-grid-wide">
            <StepsChart data={data.steps} rangeLabel={rangeLabel} />
          </div>
          <HeartRateChart data={data.restingHeartRate} rangeLabel={rangeLabel} />
          <WeightChart
            weight={data.weight}
            bodyFat={data.bodyFat}
            rangeLabel={rangeLabel}
            fallback={weight90 ?? undefined}
          />
          <WorkoutBreakdown data={data.workoutTypeBreakdown} rangeLabel={rangeLabel} />
          <div className="health-grid-wide">
            <ActivityRings data={data.activityRings} rangeLabel={rangeLabel} />
          </div>
          <div className="health-grid-wide">
            <WorkoutsTable data={data.workouts} rangeLabel={rangeLabel} />
          </div>
        </div>
      </div>
    </Layout>
  );
}

function recomputeBreakdown(workouts: HealthData['workouts']): HealthData['workoutTypeBreakdown'] {
  const map = new Map<string, { count: number; totalDuration: number; totalCalories: number }>();
  for (const w of workouts) {
    const e = map.get(w.type);
    if (e) { e.count++; e.totalDuration += w.duration; e.totalCalories += w.calories ?? 0; }
    else { map.set(w.type, { count: 1, totalDuration: w.duration, totalCalories: w.calories ?? 0 }); }
  }
  return Array.from(map.entries())
    .map(([type, s]) => ({ type, ...s }))
    .sort((a, b) => b.count - a.count);
}
