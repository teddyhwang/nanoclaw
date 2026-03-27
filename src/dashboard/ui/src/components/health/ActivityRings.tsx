import { Bar } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { COLORS } from '../../constants';

interface RingDay {
  date: string;
  moveActual: number;
  moveGoal: number;
  exerciseActual: number;
  exerciseGoal: number;
  standActual: number;
  standGoal: number;
}

interface Props {
  data: RingDay[];
  rangeLabel: string;
}

function MiniRing({ move, exercise, stand, label }: { move: number; exercise: number; stand: number; label: string }) {
  const size = 44;
  const sw = 3.5;
  const rings = [
    { pct: Math.min(move, 1), color: '#f07178' },
    { pct: Math.min(exercise, 1), color: '#aad94c' },
    { pct: Math.min(stand, 1), color: '#59c2ff' },
  ];

  return (
    <div className="mini-ring-day">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {rings.map((ring, i) => {
          const r = (size / 2) - sw * (i + 1) - i * 1.5;
          const c = 2 * Math.PI * r;
          return (
            <g key={i}>
              <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={sw} />
              <circle
                cx={size / 2} cy={size / 2} r={r}
                fill="none" stroke={ring.color} strokeWidth={sw}
                strokeLinecap="round"
                strokeDasharray={c} strokeDashoffset={c * (1 - ring.pct)}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            </g>
          );
        })}
      </svg>
      <span className="mini-ring-label">{label}</span>
    </div>
  );
}

export function ActivityRings({ data, rangeLabel }: Props) {
  const last7 = data.slice(-7);

  // Bar chart: ring closure percentages over 30 days
  const chartData = {
    labels: data.map((d) => d.date),
    datasets: [
      {
        label: 'Move',
        data: data.map((d) => Math.min((d.moveActual / d.moveGoal) * 100, 150)),
        backgroundColor: 'rgba(240,113,120,0.6)',
        borderRadius: 1,
      },
      {
        label: 'Exercise',
        data: data.map((d) => Math.min((d.exerciseActual / d.exerciseGoal) * 100, 150)),
        backgroundColor: 'rgba(170,217,76,0.6)',
        borderRadius: 1,
      },
      {
        label: 'Stand',
        data: data.map((d) => Math.min((d.standActual / d.standGoal) * 100, 150)),
        backgroundColor: 'rgba(89,194,255,0.6)',
        borderRadius: 1,
      },
    ],
  };

  const options: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 10, padding: 8, color: COLORS.muted, font: { size: 10 } } },
      tooltip: {
        backgroundColor: 'rgba(19,23,33,0.95)',
        borderColor: 'rgba(62,75,89,0.5)',
        borderWidth: 1,
        titleColor: COLORS.text,
        bodyColor: COLORS.hi,
        callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y ?? 0)}%` },
      },
    },
    scales: {
      x: { grid: { display: false }, stacked: false, ticks: { maxTicksLimit: 10, callback: (_: unknown, i: number) => data[i]?.date?.slice(5) || '' } },
      y: { grid: { color: 'rgba(62,75,89,0.2)' }, max: 150, ticks: { callback: (v) => `${v}%` } },
    },
  };

  return (
    <div className="panel chart-panel health-rings-panel">
      <div className="panel-head">
        Activity Rings <span className="panel-sub">{rangeLabel}</span>
      </div>
      <div className="health-rings-week">
        {last7.map((d) => (
          <MiniRing
            key={d.date}
            move={d.moveActual / d.moveGoal}
            exercise={d.exerciseActual / d.exerciseGoal}
            stand={d.standActual / d.standGoal}
            label={new Date(d.date + 'T12:00:00').toLocaleDateString('en', { weekday: 'short' })}
          />
        ))}
      </div>
      <div className="chart-wrap">
        <Bar data={chartData} options={options} />
      </div>
    </div>
  );
}
