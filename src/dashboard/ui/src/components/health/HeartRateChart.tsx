import { Line } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { COLORS } from '../../constants';

interface Props {
  data: { date: string; value: number }[];
  rangeLabel: string;
}

export function HeartRateChart({ data, rangeLabel }: Props) {
  const chartData = {
    labels: data.map((d) => d.date),
    datasets: [
      {
        label: 'Resting HR',
        data: data.map((d) => d.value),
        borderColor: COLORS.red,
        backgroundColor: 'rgba(240,113,120,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
      },
    ],
  };

  const options: ChartOptions<'line'> = {
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
        callbacks: { label: (ctx) => `${ctx.parsed.y} bpm` },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxTicksLimit: 10, callback: (_, i) => data[i]?.date?.slice(5) || '' },
      },
      y: {
        grid: { color: 'rgba(62,75,89,0.2)' },
        ticks: { callback: (v) => `${v}` },
      },
    },
  };

  return (
    <div className="panel chart-panel">
      <div className="panel-head" style={{ color: COLORS.red }}>
        Resting Heart Rate <span className="panel-sub">{rangeLabel}</span>
      </div>
      <div className="chart-wrap">
        <Line data={chartData} options={options} />
      </div>
    </div>
  );
}
