import { useState, useEffect, useCallback, useMemo } from 'react';
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
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { HealthData } from '../../types';
import { fetchHealth } from '../../api';
import { Layout } from '../Layout';
import { Loading } from '../Loading';
import { SubNav, PageContent } from '@/components/shared';
import { HealthSummary } from './HealthSummary';
import { StepsChart } from './StepsChart';
import { HeartRateChart } from './HeartRateChart';
import { WeightChart } from './WeightChart';
import { WorkoutsTable } from './WorkoutsTable';
import { WorkoutBreakdown } from './WorkoutBreakdown';
import { ActivityRings } from './ActivityRings';
import styles from './HealthPage.module.css';

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
  days?: number;        // for relative ranges
  since?: string;       // for year ranges
  displayLabel: string;
  slidable: boolean;    // can use prev/next
}

const currentYear = new Date().getFullYear();

const RANGES: RangeConfig[] = [
  { value: '7d',   label: '7D',   group: 'relative', days: 7,   displayLabel: '7 days',        slidable: true },
  { value: '14d',  label: '14D',  group: 'relative', days: 14,  displayLabel: '14 days',       slidable: true },
  { value: '30d',  label: '30D',  group: 'relative', days: 30,  displayLabel: '30 days',       slidable: true },
  { value: '90d',  label: '90D',  group: 'relative', days: 90,  displayLabel: '90 days',       slidable: true },
  { value: 'ytd',  label: 'YTD',  group: 'relative', since: `${currentYear}-01-01`, displayLabel: 'year to date', slidable: false },
  { value: '2025', label: '2025', group: 'year', since: '2025-01-01', displayLabel: '2025', slidable: false },
  { value: '2024', label: '2024', group: 'year', since: '2024-01-01', displayLabel: '2024', slidable: false },
  { value: '2023', label: '2023', group: 'year', since: '2023-01-01', displayLabel: '2023', slidable: false },
  { value: '2022', label: '2022', group: 'year', since: '2022-01-01', displayLabel: '2022', slidable: false },
  { value: '2021', label: '2021', group: 'year', since: '2021-01-01', displayLabel: '2021', slidable: false },
  { value: '2020', label: '2020', group: 'year', since: '2020-01-01', displayLabel: '2020', slidable: false },
];

const RANGE_MAP = Object.fromEntries(RANGES.map(r => [r.value, r])) as Record<HealthRange, RangeConfig>;

// ── Date math helpers ───────────────────────────────────────

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateRange(since: string, until: string): string {
  return `${formatDateShort(since)} – ${formatDateShort(addDays(until, -1))}`;
}

/** Compute the since/until for a slidable range with a given offset (0 = most recent) */
function computeWindow(days: number, offset: number): { since: string; until: string | undefined } {
  const t = today();
  if (offset === 0) {
    return { since: addDays(t, -days + 1), until: undefined }; // up to today, no upper bound
  }
  const until = addDays(t, -days * offset + 1);
  const since = addDays(until, -days);
  return { since, until };
}

// ── Component ───────────────────────────────────────────────

export function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [weight90, setWeight90] = useState<{ weight: HealthData['weight']; bodyFat: HealthData['bodyFat'] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<HealthRange>(() => {
    const saved = localStorage.getItem('health-range');
    return saved && saved in RANGE_MAP ? saved as HealthRange : '30d';
  });
  const [offset, setOffset] = useState(0); // 0 = most recent window

  const cfg = RANGE_MAP[range];

  // Compute the actual date window
  const window = useMemo(() => {
    if (!cfg.slidable || !cfg.days) return null;
    return computeWindow(cfg.days, offset);
  }, [cfg, offset]);

  // Build the API params
  const apiParams = useMemo((): { since?: string; until?: string; days?: number } => {
    if (window) {
      return { since: window.since, until: window.until };
    }
    if (cfg.since) return { since: cfg.since };
    return { days: cfg.days };
  }, [window, cfg]);

  const loadData = useCallback(async (params: typeof apiParams, currentCfg: RangeConfig) => {
    try {
      const d = await fetchHealth(params);
      // For historical year ranges, filter out data past that year
      if (currentCfg.group === 'year' && currentCfg.since) {
        const year = parseInt(currentCfg.value);
        if (year && year < currentYear) {
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

      // Prefetch wider weight data if needed
      const days = currentCfg.days;
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

  useEffect(() => {
    setRefreshing(true);
    loadData(apiParams, cfg);
  }, [apiParams, cfg, loadData]);

  const handleRangeChange = useCallback((r: HealthRange) => {
    setRange(r);
    setOffset(0);
    localStorage.setItem('health-range', r);
  }, []);

  // Can't go back if the window already starts at or before the earliest data
  const canGoBack = cfg.slidable && (() => {
    if (!window || !data) return true;
    return window.since > data.minDate;
  })();
  const canGoForward = cfg.slidable && offset > 0;

  const handlePrev = useCallback(() => setOffset(o => o + 1), []);
  const handleNext = useCallback(() => setOffset(o => Math.max(0, o - 1)), []);

  // Display label
  const rangeLabel = useMemo(() => {
    if (window && offset > 0) {
      return formatDateRange(window.since, window.until!);
    }
    return cfg.displayLabel;
  }, [window, offset, cfg]);

  // Date range indicator for sub-nav
  const dateRangeIndicator = useMemo(() => {
    if (!window) return null;
    if (offset === 0) return null;
    return formatDateRange(window.since, window.until!);
  }, [window, offset]);

  if (loading && !data) return <Loading message="Loading health data…" />;
  if (error && !data) return <Loading error={error} />;
  if (!data) return <Loading error="No health data available" />;

  return (
    <Layout>
      <SubNav>
        {cfg.slidable && (
          <SubNav.Tab
            className={styles.navArrow}
            onClick={handlePrev}
            disabled={!canGoBack}
          >
            <ChevronLeft size={14} />
          </SubNav.Tab>
        )}
        {RANGES.map((r, i) => {
          const prev = RANGES[i - 1];
          const showSep = prev && prev.group !== r.group;
          return (
            <span key={r.value} style={{ display: 'contents' }}>
              {showSep && <SubNav.Separator />}
              <SubNav.Tab
                active={range === r.value}
                onClick={() => handleRangeChange(r.value)}
              >
                {r.label}
              </SubNav.Tab>
            </span>
          );
        })}
        {cfg.slidable && (
          <SubNav.Tab
            className={styles.navArrow}
            onClick={handleNext}
            disabled={!canGoForward}
          >
            <ChevronRight size={14} />
          </SubNav.Tab>
        )}
        {dateRangeIndicator && (
          <>
            <SubNav.Separator />
            <SubNav.Info className={styles.dateIndicator}>{dateRangeIndicator}</SubNav.Info>
          </>
        )}
        {refreshing && <span className={styles.loadingDot} />}
      </SubNav>
      <PageContent>
        <HealthSummary data={data} />
        <div className={styles.grid}>
          <div className={styles.gridWide}>
            <StepsChart data={data.steps} rangeLabel={rangeLabel} />
          </div>
          <div className={styles.midRow}>
            <WeightChart
              weight={data.weight}
              bodyFat={data.bodyFat}
              rangeLabel={rangeLabel}
              fallback={weight90 ?? undefined}
            />
            <WorkoutBreakdown data={data.workoutTypeBreakdown} rangeLabel={rangeLabel} />
            <HeartRateChart data={data.restingHeartRate} rangeLabel={rangeLabel} />
          </div>
          <div className={styles.gridWide}>
            <ActivityRings data={data.activityRings} rangeLabel={rangeLabel} />
          </div>
          <div className={styles.gridWide}>
            <WorkoutsTable data={data.workouts} rangeLabel={rangeLabel} />
          </div>
        </div>
      </PageContent>
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
