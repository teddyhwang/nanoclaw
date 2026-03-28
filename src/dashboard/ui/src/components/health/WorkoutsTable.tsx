import { useState, useMemo, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { COLORS } from '../../constants';
import { Panel, DataTable } from '@/components/shared';
import type { Column } from '@/components/shared';
import styles from './WorkoutsTable.module.css';

interface Workout {
  date: string;
  type: string;
  duration: number;
  distance: number | null;
  calories: number | null;
  avgHR: number | null;
  maxHR: number | null;
}

interface Props {
  data: Workout[];
  rangeLabel: string;
}

function humanizeType(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

type SortCol = 'date' | 'type' | 'duration' | 'distance' | 'calories' | 'avgHR' | 'maxHR';

function getSortValue(w: Workout, col: SortCol): number | string {
  switch (col) {
    case 'date': return w.date;
    case 'type': return w.type;
    case 'duration': return w.duration;
    case 'distance': return w.distance ?? -1;
    case 'calories': return w.calories ?? -1;
    case 'avgHR': return w.avgHR ?? -1;
    case 'maxHR': return w.maxHR ?? -1;
  }
}

const columns: Column<Workout>[] = [
  {
    key: 'date',
    label: 'Date',
    sortable: true,
    render: (w) => <span style={{ color: COLORS.muted }}>{w.date.slice(5)}</span>,
  },
  {
    key: 'type',
    label: 'Type',
    sortable: true,
    render: (w) => <span style={{ color: COLORS.hi }}>{humanizeType(w.type)}</span>,
  },
  {
    key: 'duration',
    label: 'Duration',
    sortable: true,
    render: (w) => formatDuration(w.duration),
  },
  {
    key: 'distance',
    label: 'Distance',
    sortable: true,
    render: (w) => w.distance != null ? `${w.distance.toFixed(1)} km` : '—',
  },
  {
    key: 'calories',
    label: 'Calories',
    sortable: true,
    render: (w) => <span style={{ color: COLORS.orange }}>{w.calories != null ? w.calories : '—'}</span>,
  },
  {
    key: 'avgHR',
    label: 'Avg HR',
    sortable: true,
    render: (w) => <span style={{ color: COLORS.red }}>{w.avgHR ?? '—'}</span>,
  },
  {
    key: 'maxHR',
    label: 'Max HR',
    sortable: true,
    render: (w) => <span style={{ color: COLORS.red }}>{w.maxHR ?? '—'}</span>,
  },
];

export function WorkoutsTable({ data, rangeLabel }: Props) {
  const [typeFilter, setTypeFilter] = useState<string>(() => localStorage.getItem('health-workout-filter') || 'all');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>(() => (localStorage.getItem('health-workout-sort-col') as SortCol) || 'date');
  const [sortDir, setSortDir] = useState<1 | -1>(() => {
    const saved = localStorage.getItem('health-workout-sort-dir');
    return saved === '1' ? 1 : -1;
  });

  const types = useMemo(() => {
    const set = new Set(data.map(w => w.type));
    return Array.from(set).sort();
  }, [data]);

  const handleSort = useCallback((col: string) => {
    const typedCol = col as SortCol;
    setSortCol(prev => {
      if (prev === typedCol) {
        setSortDir(d => {
          const next = (d === 1 ? -1 : 1) as 1 | -1;
          localStorage.setItem('health-workout-sort-dir', String(next));
          return next;
        });
        return typedCol;
      }
      setSortDir(-1);
      localStorage.setItem('health-workout-sort-col', typedCol);
      localStorage.setItem('health-workout-sort-dir', '-1');
      return typedCol;
    });
  }, []);

  const filtered = useMemo(() => {
    let result = data;
    if (typeFilter !== 'all') {
      result = result.filter(w => w.type === typeFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(w =>
        humanizeType(w.type).toLowerCase().includes(q) ||
        w.date.includes(q)
      );
    }
    result = [...result].sort((a, b) => {
      const av = getSortValue(a, sortCol);
      const bv = getSortValue(b, sortCol);
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
    return result;
  }, [data, typeFilter, search, sortCol, sortDir]);

  const headerRight = (
    <div className={styles.controls}>
      <div className={styles.search}>
        <Search size={12} className={styles.searchIcon} />
        <input
          type="text"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={styles.searchInput}
        />
        {search && (
          <button className={styles.searchClear} onClick={() => setSearch('')}>
            <X size={10} />
          </button>
        )}
      </div>
      <select
        className={styles.typeFilter}
        value={typeFilter}
        onChange={e => { setTypeFilter(e.target.value); localStorage.setItem('health-workout-filter', e.target.value); }}
      >
        <option value="all">All Types</option>
        {types.map(t => (
          <option key={t} value={t}>{humanizeType(t)}</option>
        ))}
      </select>
    </div>
  );

  return (
    <Panel
      title="Recent Workouts"
      subtitle={`${rangeLabel} · ${filtered.length} sessions`}
      headerRight={headerRight}
      className={styles.workoutsPanel}
    >
      <DataTable<Workout>
        columns={columns}
        data={filtered}
        sortCol={sortCol}
        sortDir={sortDir}
        onSort={handleSort}
        emptyMessage="No workouts found"
      />
    </Panel>
  );
}
