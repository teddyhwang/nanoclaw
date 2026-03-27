import { useRef, useEffect, useCallback } from 'react';
import { Chart, type ChartEvent, type ActiveElement } from 'chart.js';
import type { Transaction } from '../../types';
import type { CategoryMap } from '../../utils/categories';
import { spendAmt, isSpend } from '../../utils/categories';
import { fmt, fmtFull } from '../../utils/format';
import { getDateRange, weekRange } from '../../utils/dates';
import { COLORS } from '../../constants';
import { usePrivacy } from '../../contexts/PrivacyContext';

interface Props {
  transactions: Transaction[];
  categoryMap: CategoryMap;
  debitsNeg: boolean;
  dateRange: string;
  selectedWeekStart: string | null;
  onWeekClick: (weekStart: string | null, weekEnd: string | null) => void;
}

export function WeeklyTrend({
  transactions,
  categoryMap,
  debitsNeg,
  dateRange,
  selectedWeekStart,
  onWeekClick,
}: Props) {
  const { privacyMode } = usePrivacy();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const avgRef = useRef<HTMLSpanElement>(null);

  const buildData = useCallback(() => {
    const { from, to } = getDateRange(dateRange);
    const weeks: Record<string, number> = {};
    for (const tx of transactions) {
      if (!isSpend(tx, categoryMap, debitsNeg)) continue;
      if (tx.date < from || tx.date > to) continue;
      const wr = weekRange(tx.date);
      weeks[wr.start] = (weeks[wr.start] || 0) + spendAmt(tx, debitsNeg);
    }
    const sorted = Object.entries(weeks).sort((a, b) => a[0].localeCompare(b[0]));
    return {
      keys: sorted.map(([k]) => k),
      labels: sorted.map(([d]) =>
        new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }),
      ),
      vals: sorted.map(([, v]) => v),
    };
  }, [transactions, categoryMap, debitsNeg, dateRange]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const { keys, labels, vals } = buildData();
    const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    if (avgRef.current) avgRef.current.textContent = `avg ${fmtFull(avg, privacyMode)}/wk`;

    const barColors = keys.map((k, i) => {
      if (selectedWeekStart === k) return COLORS.accent + 'dd';
      return vals[i] > avg ? COLORS.orange + 'bb' : COLORS.blue + 'bb';
    });

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Weekly', data: vals, backgroundColor: barColors, borderRadius: 3 },
          {
            label: 'Avg',
            data: Array(vals.length).fill(avg),
            type: 'line' as const,
            borderColor: COLORS.yellow,
            borderDash: [5, 3],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick(_evt: ChartEvent, elements: ActiveElement[]) {
          if (!elements.length) return;
          const key = keys[elements[0].index];
          if (selectedWeekStart === key) {
            onWeekClick(null, null);
          } else {
            const end = new Date(key + 'T00:00:00');
            end.setDate(end.getDate() + 6);
            onWeekClick(key, end.toISOString().slice(0, 10));
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 12 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 13 } },
          y: { beginAtZero: true, ticks: { callback: (v) => fmt(v as number, privacyMode), font: { size: 11 } } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtFull(ctx.raw as number, privacyMode)}` } },
        },
      },
    });

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [buildData, selectedWeekStart, onWeekClick, privacyMode]);

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        Weekly Trend <span className="panel-sub" ref={avgRef} />
      </div>
      <div className="chart-wrap"><canvas ref={canvasRef} /></div>
    </div>
  );
}
