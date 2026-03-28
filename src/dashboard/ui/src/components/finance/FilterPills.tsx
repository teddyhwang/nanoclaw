import type { FilterState } from '../../types';
import type { CategoryMap } from '../../utils/categories';
import { fmtDate } from '../../utils/format';

interface Props {
  filters: FilterState;
  categoryMap: CategoryMap;
  onSetFilter: (type: string, value: string | null) => void;
  onClearAll: () => void;
  onClearSearch: () => void;
  onClearCatId: () => void;
}

export function FilterPills({
  filters,
  categoryMap,
  onSetFilter,
  onClearAll,
  onClearSearch,
  onClearCatId,
}: Props) {
  const pills: { label: string; clear: () => void }[] = [];

  if (filters.day) {
    pills.push({ label: `Day: ${fmtDate(filters.day)}`, clear: () => onSetFilter('day', null) });
  }
  if (filters.weekStart && filters.weekEnd) {
    const ws = fmtDate(filters.weekStart).replace(/,\s*\d{4}$/, '');
    const we = fmtDate(filters.weekEnd).replace(/,\s*\d{4}$/, '');
    pills.push({ label: `Week: ${ws} – ${we}`, clear: () => onSetFilter('week', null) });
  }
  if (filters.category) {
    pills.push({ label: `Cat: ${filters.category}`, clear: () => onSetFilter('category', null) });
  }
  if (filters.merchant) {
    pills.push({ label: filters.merchant, clear: () => onSetFilter('merchant', null) });
  }
  if (filters.search) {
    pills.push({ label: `"${filters.search}"`, clear: onClearSearch });
  }
  if (filters.catId) {
    const cn = Object.values(categoryMap).find((c) => c.id === Number(filters.catId))?.name;
    pills.push({ label: `Cat: ${cn || filters.catId}`, clear: onClearCatId });
  }

  if (!pills.length) return null;

  return (
    <div className="filter-pills">
      {pills.map((p, i) => (
        <span key={i} className="filter-pill">
          {p.label}
          <span className="pill-x" onClick={p.clear}>
            ×
          </span>
        </span>
      ))}
      {pills.length > 1 && (
        <button className="clear-all-btn" onClick={onClearAll}>
          Clear all
        </button>
      )}
    </div>
  );
}
