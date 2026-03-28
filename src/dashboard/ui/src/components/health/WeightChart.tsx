import { Line } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { Info } from 'lucide-react';
import { COLORS } from '../../constants';
import { ChartPanel, tooltipStyle, axisStyle, createLineDataset } from '@/components/shared';
import wStyles from './WeightChart.module.css';

interface DateValue { date: string; value: number; }

interface Props {
  weight: DateValue[];
  bodyFat: DateValue[];
  rangeLabel: string;
  /** Wider-range fallback data when the primary range has too few points */
  fallback?: { weight: DateValue[]; bodyFat: DateValue[] };
}

const MIN_POINTS = 3;

export function WeightChart({ weight, bodyFat, rangeLabel, fallback }: Props) {
  const useFallback = weight.length < MIN_POINTS && fallback && fallback.weight.length >= MIN_POINTS;
  const displayWeight = useFallback ? fallback!.weight : weight;
  const displayBodyFat = useFallback ? fallback!.bodyFat : bodyFat;
  const hasBodyFat = displayBodyFat.length > 0;

  const chartData = {
    labels: displayWeight.map((d) => d.date),
    datasets: [
      createLineDataset(
        'Weight (lbs)',
        displayWeight.map((d) => d.value),
        COLORS.blue,
        {
          pointRadius: displayWeight.length < 20 ? 3 : 0,
          yAxisID: 'y',
        },
      ),
      ...(hasBodyFat
        ? [
            createLineDataset(
              'Body Fat %',
              displayBodyFat.map((d) => d.value),
              COLORS.purple,
              {
                fill: false,
                backgroundColor: 'transparent',
                pointRadius: displayBodyFat.length < 20 ? 3 : 0,
                borderWidth: 1.5,
                borderDash: [4, 4],
                yAxisID: 'y1' as const,
              },
            ),
          ]
        : []),
    ],
  };

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: hasBodyFat, position: 'top', labels: { boxWidth: 12, padding: 8, color: COLORS.muted, font: { size: 11 } } },
      tooltip: tooltipStyle,
    },
    scales: {
      x: {
        ...axisStyle.x,
        ticks: { ...axisStyle.x.ticks, maxTicksLimit: 8, callback: (_, i) => displayWeight[i]?.date?.slice(5) || '' },
      },
      y: {
        position: 'left',
        ...axisStyle.y,
        ticks: { ...axisStyle.y.ticks, callback: (v) => `${v}` },
      },
      ...(hasBodyFat
        ? {
            y1: {
              position: 'right' as const,
              grid: { display: false },
              ticks: { callback: (v: string | number) => `${v}%`, color: COLORS.purple },
            },
          }
        : {}),
    },
  };

  const headerRight = useFallback ? (
    <span className={wStyles.infoBadge} title="Not enough weight data in the selected range — showing 90 days instead">
      <Info size={12} />
    </span>
  ) : undefined;

  return (
    <ChartPanel
      title="Weight"
      subtitle={useFallback ? '90 days' : rangeLabel}
      headerRight={headerRight}
    >
      <Line data={chartData} options={options} />
    </ChartPanel>
  );
}
