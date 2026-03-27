import { Bar } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { COLORS } from '../../constants';

interface Props {
  data: { date: string; steps: number }[];
  rangeLabel: string;
}

const GOAL = 10000;

export function StepsChart({ data, rangeLabel }: Props) {
  const chartData = {
    labels: data.map((d) => d.date),
    datasets: [
      {
        label: 'Steps',
        data: data.map((d) => d.steps),
        backgroundColor: data.map((d) => d.steps >= GOAL ? 'rgba(170,217,76,0.7)' : 'rgba(89,194,255,0.5)'),
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
        callbacks: {
          label: (ctx) => `${(ctx.parsed.y ?? 0).toLocaleString()} steps`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          maxTicksLimit: 10,
          callback: function (_, i) {
            const label = data[i]?.date;
            return label ? label.slice(5) : '';
          },
        },
      },
      y: {
        grid: { color: 'rgba(62,75,89,0.2)' },
        ticks: { callback: (v) => `${Number(v) / 1000}k` },
      },
    },
  };

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        Steps <span className="panel-sub">{rangeLabel} · 10k goal</span>
      </div>
      <div className="chart-wrap">
        <Bar data={chartData} options={options} />
      </div>
    </div>
  );
}
