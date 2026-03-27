import { Doughnut } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { CHART_COLORS, COLORS } from '../../constants';

function humanizeType(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2');
}

interface Props {
  data: { type: string; count: number; totalDuration: number; totalCalories: number }[];
  rangeLabel: string;
}

export function WorkoutBreakdown({ data, rangeLabel }: Props) {
  const chartData = {
    labels: data.map((d) => humanizeType(d.type)),
    datasets: [
      {
        data: data.map((d) => d.count),
        backgroundColor: data.map((_, i) => CHART_COLORS[i % CHART_COLORS.length] + 'cc'),
        borderColor: 'rgba(19,23,33,0.8)',
        borderWidth: 2,
      },
    ],
  };

  const options: ChartOptions<'doughnut'> = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '65%',
    plugins: {
      legend: {
        position: 'right',
        labels: { boxWidth: 10, padding: 6, color: COLORS.text, font: { size: 11 } },
      },
      tooltip: {
        backgroundColor: 'rgba(19,23,33,0.95)',
        borderColor: 'rgba(62,75,89,0.5)',
        borderWidth: 1,
        titleColor: COLORS.text,
        bodyColor: COLORS.hi,
        callbacks: {
          label: (ctx) => {
            const item = data[ctx.dataIndex];
            return `${humanizeType(item.type)}: ${item.count} sessions · ${Math.round(item.totalDuration)}min`;
          },
        },
      },
    },
  };

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        Workout Breakdown <span className="panel-sub">{rangeLabel}</span>
      </div>
      <div className="chart-wrap">
        <Doughnut data={chartData} options={options} />
      </div>
    </div>
  );
}
