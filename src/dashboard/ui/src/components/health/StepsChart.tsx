import { Bar } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { ChartPanel, tooltipStyle, axisStyle, createBarDataset, formatDateTick } from '@/components/shared';

interface Props {
  data: { date: string; steps: number }[];
  rangeLabel: string;
}

const GOAL = 10000;

export function StepsChart({ data, rangeLabel }: Props) {
  const chartData = {
    labels: data.map((d) => d.date),
    datasets: [
      createBarDataset(
        'Steps',
        data.map((d) => d.steps),
        data.map((d) => d.steps >= GOAL ? 'rgba(170,217,76,0.7)' : 'rgba(89,194,255,0.5)'),
      ),
    ],
  };

  const options: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...tooltipStyle,
        callbacks: {
          label: (ctx) => `${(ctx.parsed.y ?? 0).toLocaleString()} steps`,
        },
      },
    },
    scales: {
      x: {
        ...axisStyle.x,
        ticks: {
          ...axisStyle.x.ticks,
          maxTicksLimit: 10,
          callback: function (_, i) {
            return formatDateTick(data[i]?.date ?? '');
          },
        },
      },
      y: {
        ...axisStyle.y,
        ticks: { ...axisStyle.y.ticks, callback: (v) => `${Number(v) / 1000}k` },
      },
    },
  };

  return (
    <ChartPanel title="Steps" subtitle={`${rangeLabel} · 10k goal`}>
      <Bar data={chartData} options={options} />
    </ChartPanel>
  );
}
