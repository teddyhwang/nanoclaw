import { memo, useRef, useEffect, useCallback } from 'react';
import { Chart, type ChartEvent, type ActiveElement } from 'chart.js';
import type { Transaction } from '../../types';
import type { CategoryMap, CategoryGroupMap } from '../../utils/categories';
import { getCategoryGroup, spendAmt, isSpend } from '../../utils/categories';
import { fmtFull } from '../../utils/format';
import { getDateRange } from '../../utils/dates';
import { CHART_COLORS, COLORS } from '../../constants';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { Panel } from '@/components/shared';

interface Props {
  transactions: Transaction[];
  categoryMap: CategoryMap;
  categoryGroupMap: CategoryGroupMap;
  debitsNeg: boolean;
  dateRange: string;
  selectedCategory: string | null;
  onCategoryClick: (category: string | null) => void;
}

function CategoryDonutImpl({
  transactions,
  categoryMap,
  categoryGroupMap,
  debitsNeg,
  dateRange,
  selectedCategory,
  onCategoryClick,
}: Props) {
  const { privacyMode } = usePrivacy();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  const buildData = useCallback(() => {
    const { from: ms, to: me } = getDateRange(dateRange);
    const byCat: Record<string, number> = {};
    for (const tx of transactions) {
      if (tx.date >= ms && tx.date <= me && isSpend(tx, categoryMap, debitsNeg)) {
        const cn = getCategoryGroup(tx.category_id, categoryMap, categoryGroupMap);
        byCat[cn] = (byCat[cn] || 0) + spendAmt(tx, debitsNeg);
      }
    }
    const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 7);
    const other = entries.slice(7).reduce((s, [, v]) => s + v, 0);
    if (other > 0) top.push(['Other', other]);
    return { labels: top.map((e) => e[0]), data: top.map((e) => e[1]) };
  }, [transactions, categoryMap, categoryGroupMap, debitsNeg, dateRange]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const { labels, data } = buildData();

    const bgColors = CHART_COLORS.slice(0, labels.length).map((c, i) =>
      selectedCategory && labels[i] !== selectedCategory ? c + '30' : c,
    );

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: bgColors, borderColor: COLORS.panel, borderWidth: 2 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        onClick(_evt: ChartEvent, elements: ActiveElement[]) {
          if (!elements.length) return;
          const label = labels[elements[0].index];
          if (label === 'Other') return;
          onCategoryClick(selectedCategory === label ? null : label);
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              padding: 8,
              usePointStyle: true,
              pointStyle: 'circle',
              font: { size: 11 },
              color: COLORS.text,
              boxWidth: 8,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.label}: ${fmtFull(ctx.raw as number, privacyMode)}`,
            },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [buildData, selectedCategory, onCategoryClick, privacyMode]);

  return (
    <Panel className="chart-panel" title="Spending by Category">
      <div className="chart-wrap">
        <canvas ref={canvasRef} />
      </div>
    </Panel>
  );
}

export const CategoryDonut = memo(CategoryDonutImpl);
