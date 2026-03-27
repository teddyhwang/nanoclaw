import { Line } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { Info } from 'lucide-react';
import { COLORS } from '../../constants';

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
      {
        label: 'Weight (lbs)',
        data: displayWeight.map((d) => d.value),
        borderColor: COLORS.blue,
        backgroundColor: 'rgba(89,194,255,0.08)',
        fill: true,
        tension: 0.3,
        pointRadius: displayWeight.length < 20 ? 3 : 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        yAxisID: 'y',
      },
      ...(hasBodyFat
        ? [
            {
              label: 'Body Fat %',
              data: displayBodyFat.map((d) => d.value),
              borderColor: COLORS.purple,
              backgroundColor: 'transparent',
              fill: false,
              tension: 0.3,
              pointRadius: displayBodyFat.length < 20 ? 3 : 0,
              pointHoverRadius: 4,
              borderWidth: 1.5,
              borderDash: [4, 4],
              yAxisID: 'y1' as const,
            },
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
      tooltip: {
        backgroundColor: 'rgba(19,23,33,0.95)',
        borderColor: 'rgba(62,75,89,0.5)',
        borderWidth: 1,
        titleColor: COLORS.text,
        bodyColor: COLORS.hi,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxTicksLimit: 8, callback: (_, i) => displayWeight[i]?.date?.slice(5) || '' },
      },
      y: {
        position: 'left',
        grid: { color: 'rgba(62,75,89,0.2)' },
        ticks: { callback: (v) => `${v}` },
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

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        Weight{' '}
        <span className="panel-sub">
          {useFallback ? '90 days' : rangeLabel}
        </span>
        {useFallback && (
          <span className="health-info-badge" title="Not enough weight data in the selected range — showing 90 days instead">
            <Info size={12} />
          </span>
        )}
      </div>
      <div className="chart-wrap">
        <Line data={chartData} options={options} />
      </div>
    </div>
  );
}
