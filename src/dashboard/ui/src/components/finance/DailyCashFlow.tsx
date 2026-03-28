import { useRef, useEffect, useCallback } from 'react';
import { Chart, type ChartEvent, type ActiveElement } from 'chart.js';
import type { Transaction } from '../../types';
import type { CategoryMap } from '../../utils/categories';
import { spendAmt, isSpend, isIncome } from '../../utils/categories';
import { fmt, fmtFull } from '../../utils/format';
import { getDateRange } from '../../utils/dates';
import { COLORS } from '../../constants';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { Panel } from '@/components/shared';

interface Props {
  transactions: Transaction[];
  categoryMap: CategoryMap;
  debitsNeg: boolean;
  dateRange: string;
  selectedDay: string | null;
  onDayClick: (day: string | null) => void;
}

export function DailyCashFlow({
  transactions,
  categoryMap,
  debitsNeg,
  dateRange,
  selectedDay,
  onDayClick,
}: Props) {
  const { privacyMode } = usePrivacy();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  const buildData = useCallback(() => {
    const { from, to } = getDateRange(dateRange);
    const byDaySpend: Record<string, number> = {};
    const byDayIncome: Record<string, number> = {};
    for (const tx of transactions) {
      if (tx.date < from || tx.date > to) continue;
      const amt = spendAmt(tx, debitsNeg);
      if (isSpend(tx, categoryMap, debitsNeg))
        byDaySpend[tx.date] = (byDaySpend[tx.date] || 0) + amt;
      else if (isIncome(tx, categoryMap))
        byDayIncome[tx.date] = (byDayIncome[tx.date] || 0) + Math.abs(amt);
    }
    const dates = [...new Set([...Object.keys(byDaySpend), ...Object.keys(byDayIncome)])].sort();
    const spendVals = dates.map((d) => byDaySpend[d] || 0);
    const incomeVals = dates.map((d) => byDayIncome[d] || 0);
    const netVals = dates.map((_, i) => incomeVals[i] - spendVals[i]);
    const cum: number[] = [];
    let s = 0;
    for (const v of netVals) { s += v; cum.push(s); }
    return { dates, spendVals, incomeVals, cum };
  }, [transactions, categoryMap, debitsNeg, dateRange]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const { dates, spendVals, incomeVals, cum } = buildData();

    const labels = dates.map((d) => {
      const dt = new Date(d + 'T00:00:00');
      return dt.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    });

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Spent',
            data: spendVals,
            backgroundColor: dates.map((d) => (d === selectedDay ? COLORS.accent : COLORS.blue + '70')),
            borderColor: dates.map((d) => (d === selectedDay ? COLORS.accent : 'transparent')),
            borderWidth: 2,
            borderRadius: 2,
            order: 2,
            grouped: false,
            barPercentage: 0.9,
            categoryPercentage: 0.9,
          },
          {
            label: 'Income',
            data: incomeVals,
            backgroundColor: dates.map((d) => (d === selectedDay ? COLORS.green : COLORS.green + '70')),
            borderColor: dates.map((d) => (d === selectedDay ? COLORS.green : 'transparent')),
            borderWidth: 2,
            borderRadius: 2,
            order: 3,
            grouped: false,
            barPercentage: 0.55,
            categoryPercentage: 0.9,
          },
          {
            label: 'Net Cumulative',
            data: cum,
            type: 'line' as const,
            borderColor: COLORS.cyan,
            backgroundColor: 'transparent',
            pointRadius: 0,
            borderWidth: 1.5,
            tension: 0.3,
            yAxisID: 'y1',
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        onClick(_evt: ChartEvent, elements: ActiveElement[]) {
          if (!elements.length) return;
          const clicked = dates[elements[0].index];
          onDayClick(selectedDay === clicked ? null : clicked);
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 12 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 15 } },
          y: { beginAtZero: true, ticks: { callback: (v) => fmt(v as number, privacyMode), font: { size: 11 } } },
          y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { callback: (v) => fmt(v as number, privacyMode), font: { size: 11 } } },
        },
        plugins: {
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtFull(ctx.raw as number, privacyMode)}` } },
        },
      },
    });

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [buildData, selectedDay, onDayClick, privacyMode]);

  return (
    <Panel className="chart-panel" title="Daily Cash Flow">
      <div className="chart-wrap"><canvas ref={canvasRef} /></div>
    </Panel>
  );
}
