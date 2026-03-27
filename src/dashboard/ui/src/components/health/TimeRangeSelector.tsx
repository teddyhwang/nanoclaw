import type { HealthRange } from './HealthPage';

interface Props {
  value: HealthRange;
  options: { value: HealthRange; label: string }[];
  onChange: (v: HealthRange) => void;
}

export function TimeRangeSelector({ value, options, onChange }: Props) {
  return (
    <div className="health-range-selector">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`health-range-btn${value === opt.value ? ' active' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
