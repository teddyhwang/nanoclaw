import { useState, useMemo, useCallback } from 'react';
import { Dumbbell, ChevronUp, ChevronDown, Search, X } from 'lucide-react';
import { COLORS } from '../../constants';

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
type SortDir = 1 | -1;

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

export function WorkoutsTable({ data, rangeLabel }: Props) {
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('date');
  const [sortDir, setSortDir] = useState<SortDir>(-1);

  const types = useMemo(() => {
    const set = new Set(data.map(w => w.type));
    return Array.from(set).sort();
  }, [data]);

  const handleSort = useCallback((col: SortCol) => {
    setSortCol(prev => {
      if (prev === col) {
        setSortDir(d => (d === 1 ? -1 : 1) as SortDir);
        return col;
      }
      setSortDir(col === 'date' ? -1 : -1);
      return col;
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

  const SortIcon = ({ col }: { col: SortCol }) => {
    if (sortCol !== col) return null;
    return sortDir === 1 ? <ChevronUp size={10} /> : <ChevronDown size={10} />;
  };

  const thStyle = (col: SortCol): React.CSSProperties => ({
    cursor: 'pointer',
    userSelect: 'none',
    color: sortCol === col ? COLORS.accent : undefined,
  });

  return (
    <div className="panel health-workouts-panel">
      <div className="panel-head workouts-head">
        <div className="workouts-title">
          <Dumbbell size={14} />
          Recent Workouts <span className="panel-sub">{rangeLabel} · {filtered.length} sessions</span>
        </div>
        <div className="workouts-controls">
          <div className="workouts-search">
            <Search size={12} className="workouts-search-icon" />
            <input
              type="text"
              placeholder="Search…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="workouts-search-input"
            />
            {search && (
              <button className="workouts-search-clear" onClick={() => setSearch('')}>
                <X size={10} />
              </button>
            )}
          </div>
          <select
            className="workouts-type-filter"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
          >
            <option value="all">All Types</option>
            {types.map(t => (
              <option key={t} value={t}>{humanizeType(t)}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="health-workouts-scroll">
        <table className="health-workouts-table">
          <thead>
            <tr>
              <th style={thStyle('date')} onClick={() => handleSort('date')}>Date <SortIcon col="date" /></th>
              <th style={thStyle('type')} onClick={() => handleSort('type')}>Type <SortIcon col="type" /></th>
              <th style={thStyle('duration')} onClick={() => handleSort('duration')}>Duration <SortIcon col="duration" /></th>
              <th style={thStyle('distance')} onClick={() => handleSort('distance')}>Distance <SortIcon col="distance" /></th>
              <th style={thStyle('calories')} onClick={() => handleSort('calories')}>Calories <SortIcon col="calories" /></th>
              <th style={thStyle('avgHR')} onClick={() => handleSort('avgHR')}>Avg HR <SortIcon col="avgHR" /></th>
              <th style={thStyle('maxHR')} onClick={() => handleSort('maxHR')}>Max HR <SortIcon col="maxHR" /></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: COLORS.muted, padding: 20 }}>No workouts found</td></tr>
            ) : (
              filtered.map((w, i) => (
                <tr key={i}>
                  <td style={{ color: COLORS.muted }}>{w.date.slice(5)}</td>
                  <td style={{ color: COLORS.hi }}>{humanizeType(w.type)}</td>
                  <td>{formatDuration(w.duration)}</td>
                  <td>{w.distance != null ? `${w.distance.toFixed(1)} km` : '—'}</td>
                  <td style={{ color: COLORS.orange }}>{w.calories != null ? w.calories : '—'}</td>
                  <td style={{ color: COLORS.red }}>{w.avgHR ?? '—'}</td>
                  <td style={{ color: COLORS.red }}>{w.maxHR ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
