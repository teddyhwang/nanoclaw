import { memo, useRef, useEffect, useCallback } from 'react';
import { Chart, type ChartEvent, type ActiveElement } from 'chart.js';
import type { Transaction } from '../../types';
import type { CategoryMap } from '../../utils/categories';
import { spendAmt, isSpend } from '../../utils/categories';
import { fmt, fmtFull } from '../../utils/format';
import { getDateRange } from '../../utils/dates';
import { CHART_COLORS, COLORS } from '../../constants';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { Panel } from '@/components/shared';

const RECURRING_CATS = ['condo mortgage', 'mortgage', 'condo fees', 'rent'];

interface Props {
  transactions: Transaction[];
  categoryMap: CategoryMap;
  debitsNeg: boolean;
  dateRange: string;
  selectedMerchant: string | null;
  onMerchantClick: (merchant: string | null) => void;
}

function TopMerchantsImpl({
  transactions,
  categoryMap,
  debitsNeg,
  dateRange,
  selectedMerchant,
  onMerchantClick,
}: Props) {
  const { privacyMode } = usePrivacy();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  const buildData = useCallback(() => {
    const { from: ms, to: me } = getDateRange(dateRange);
    const byM: Record<string, number> = {};
    for (const tx of transactions) {
      if (tx.date >= ms && tx.date <= me && isSpend(tx, categoryMap, debitsNeg)) {
        const c = categoryMap[tx.category_id];
        if (c && RECURRING_CATS.includes(c.name.toLowerCase())) continue;
        const n = tx.payee || tx.original_name || 'Unknown';
        byM[n] = (byM[n] || 0) + spendAmt(tx, debitsNeg);
      }
    }
    const sorted = Object.entries(byM)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    return { labels: sorted.map((e) => e[0]), data: sorted.map((e) => e[1]) };
  }, [transactions, categoryMap, debitsNeg, dateRange]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const { labels, data } = buildData();

    const barColors = CHART_COLORS.slice(0, labels.length).map((c, i) =>
      selectedMerchant && labels[i] !== selectedMerchant ? c + '30' : c + 'bb',
    );

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ data, backgroundColor: barColors, borderRadius: 3 }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick(_evt: ChartEvent, elements: ActiveElement[]) {
          if (!elements.length) return;
          const label = labels[elements[0].index];
          onMerchantClick(selectedMerchant === label ? null : label);
        },
        scales: {
          x: { beginAtZero: true, ticks: { callback: (v) => fmt(v as number, privacyMode), font: { size: 11 } } },
          y: {
            ticks: {
              font: { size: 11 },
              color: COLORS.text,
              callback(v) {
                const l = this.getLabelForValue(v as number);
                return l.length > 20 ? l.slice(0, 18) + '…' : l;
              },
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ` ${fmtFull(ctx.raw as number, privacyMode)}` } },
        },
      },
    });

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [buildData, selectedMerchant, onMerchantClick, privacyMode]);

  return (
    <Panel className="chart-panel" title="Top Merchants">
      <div className="chart-wrap"><canvas ref={canvasRef} /></div>
    </Panel>
  );
}

export const TopMerchants = memo(TopMerchantsImpl);
