import { Line } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { COLORS } from '../../constants';
import { ChartPanel, tooltipStyle, axisStyle, createLineDataset, formatDateTick } from '@/components/shared';

interface Props {
  data: { date: string; value: number }[];
  rangeLabel: string;
}

export function HeartRateChart({ data, rangeLabel }: Props) {
  const chartData = {
    labels: data.map((d) => d.date),
    datasets: [
      createLineDataset('Resting HR', data.map((d) => d.value), COLORS.red),
    ],
  };

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...tooltipStyle,
        callbacks: { label: (ctx) => `${ctx.parsed.y} bpm` },
      },
    },
    scales: {
      x: {
        ...axisStyle.x,
        ticks: {
          ...axisStyle.x.ticks,
          maxTicksLimit: 10,
          callback: (_, i) => formatDateTick(data[i]?.date ?? ''),
        },
      },
      y: {
        ...axisStyle.y,
        ticks: { ...axisStyle.y.ticks, callback: (v) => `${v}` },
      },
    },
  };

  return (
    <ChartPanel title="Resting Heart Rate" subtitle={rangeLabel} titleColor={COLORS.red}>
      <Line data={chartData} options={options} />
    </ChartPanel>
  );
}
