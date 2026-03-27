import { Bar } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { COLORS } from '../../constants';

interface Props {
  data: { date: string; hours: number }[];
}

function sleepColor(hours: number): string {
  if (hours < 6) return COLORS.red;
  if (hours < 7) return COLORS.yellow;
  if (hours <= 9) return COLORS.green;
  return COLORS.blue;
}

export function SleepChart({ data }: Props) {
  const chartData = {
    labels: data.map((d) => d.date),
    datasets: [
      {
        label: 'Sleep',
        data: data.map((d) => d.hours),
        backgroundColor: data.map((d) => {
          const c = sleepColor(d.hours);
          return c + '99'; // add alpha
        }),
        borderRadius: 2,
        borderSkipped: false as const,
      },
    ],
  };

  const options: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(19,23,33,0.95)',
        borderColor: 'rgba(62,75,89,0.5)',
        borderWidth: 1,
        titleColor: COLORS.text,
        bodyColor: COLORS.hi,
        callbacks: { label: (ctx) => `${(ctx.parsed.y ?? 0).toFixed(1)} hours` },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxTicksLimit: 10, callback: (_, i) => data[i]?.date?.slice(5) || '' },
      },
      y: {
        grid: { color: 'rgba(62,75,89,0.2)' },
        min: 0,
        max: 12,
        ticks: { callback: (v) => `${v}h` },
      },
    },
  };

  return (
    <div className="panel chart-panel">
      <div className="panel-head" style={{ color: COLORS.purple }}>
        Sleep <span className="panel-sub">30 days</span>
      </div>
      <div className="chart-wrap">
        <Bar data={chartData} options={options} />
      </div>
    </div>
  );
}
