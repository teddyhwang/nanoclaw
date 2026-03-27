import { Line } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { COLORS } from '../../constants';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface Props {
  data: { date: string; value: number }[];
}

export function VO2MaxChart({ data }: Props) {
  const trend = data.length >= 2 ? data[data.length - 1].value - data[data.length - 2].value : 0;
  const TrendIcon = trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;
  const trendColor = trend > 0 ? COLORS.green : trend < 0 ? COLORS.red : COLORS.muted;

  const chartData = {
    labels: data.map((d) => d.date),
    datasets: [
      {
        label: 'VO2 Max',
        data: data.map((d) => d.value),
        borderColor: COLORS.green,
        backgroundColor: 'rgba(170,217,76,0.08)',
        fill: true,
        tension: 0.3,
        pointRadius: data.length > 30 ? 0 : 3,
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
        callbacks: { label: (ctx) => `VO2 Max: ${(ctx.parsed.y ?? 0).toFixed(1)}` },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxTicksLimit: 8, callback: (_, i) => data[i]?.date?.slice(5) || '' },
      },
      y: {
        grid: { color: 'rgba(62,75,89,0.2)' },
      },
    },
  };

  return (
    <div className="panel chart-panel">
      <div className="panel-head" style={{ color: COLORS.green }}>
        VO2 Max
        <span className="panel-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          all time
          <TrendIcon size={12} style={{ color: trendColor }} />
        </span>
      </div>
      <div className="chart-wrap">
        <Line data={chartData} options={options} />
      </div>
    </div>
  );
}
