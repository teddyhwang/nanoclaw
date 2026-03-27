import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js';
import type { InvestmentData } from '../../types';
import { fmt, fmtFull, fmtPct, valClass } from '../../utils/format';
import { COLORS } from '../../constants';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { EditableField } from './EditableField';

interface Props {
  data: InvestmentData;
  onSaveSalaryField: (idx: number, field: string, value: number) => void;
}

export function Salaries({ data, onSaveSalaryField }: Props) {
  const { privacyMode } = usePrivacy();
  const pm = privacyMode;
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstanceRef = useRef<Chart | null>(null);

  const sal = data.salaries;
  const svsMap: Record<number, number> = {};
  for (const s of data.savingsVsSalaries) svsMap[s.year] = s.totalSavings;

  const tot = sal.reduce(
    (acc, s) => ({
      teddyGross: acc.teddyGross + s.teddyGross,
      teddyTax: acc.teddyTax + s.teddyTax,
      nicoleGross: acc.nicoleGross + s.nicoleGross,
      nicoleTax: acc.nicoleTax + s.nicoleTax,
    }),
    { teddyGross: 0, teddyTax: 0, nicoleGross: 0, nicoleTax: 0 },
  );
  const totNet = { teddyNet: tot.teddyGross - tot.teddyTax, nicoleNet: tot.nicoleGross - tot.nicoleTax };
  const totalGross = tot.teddyGross + tot.nicoleGross;
  const totalTax = tot.teddyTax + tot.nicoleTax;
  const totalNet = totalGross - totalTax;

  const latestYear = Object.keys(data.years).sort((a, b) => Number(b) - Number(a))[0];
  const totalSavings = data.years[latestYear]?.summary.total || 0;
  const savingsAfterTaxPct = totalNet ? (totalSavings / totalNet) * 100 : 0;
  const avgTaxRate = totalGross ? (totalTax / totalGross) * 100 : 0;
  const savingsPct = totalGross ? (totalSavings / totalGross) * 100 : 0;

  useEffect(() => {
    if (!chartRef.current) return;
    if (chartInstanceRef.current) chartInstanceRef.current.destroy();

    const totalNetYoY = sal.map((s, i) => {
      if (i === 0) return null;
      const prev = sal[i - 1];
      const prevNet = prev.teddyGross - prev.teddyTax + (prev.nicoleGross - prev.nicoleTax);
      const curNet = s.teddyGross - s.teddyTax + (s.nicoleGross - s.nicoleTax);
      return prevNet ? ((curNet - prevNet) / prevNet) * 100 : null;
    });

    chartInstanceRef.current = new Chart(chartRef.current, {
      type: 'bar',
      data: {
        labels: sal.map((s) => s.year),
        datasets: [
          { label: 'Teddy Net', data: sal.map((s) => s.teddyGross - s.teddyTax), backgroundColor: COLORS.blue + 'bb', borderRadius: 3, stack: 'net' },
          { label: 'Nicole Net', data: sal.map((s) => s.nicoleGross - s.nicoleTax), backgroundColor: COLORS.purple + 'bb', borderRadius: 3, stack: 'net' },
          {
            label: 'YoY Change %', data: totalNetYoY, type: 'line' as const, yAxisID: 'y1',
            borderColor: COLORS.yellow, backgroundColor: 'transparent',
            pointBackgroundColor: totalNetYoY.map((v) => v == null ? COLORS.yellow : v >= 0 ? COLORS.green : COLORS.red),
            pointBorderColor: totalNetYoY.map((v) => v == null ? COLORS.yellow : v >= 0 ? COLORS.green : COLORS.red),
            pointRadius: 3, pointHoverRadius: 4, borderWidth: 2, tension: 0.3, spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } },
          y: { stacked: true, ticks: { callback: (v) => fmt(v as number, pm) } },
          y1: { position: 'right', grid: { display: false }, ticks: { callback: (v) => `${v}%` } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (ctx) =>
                ctx.dataset.yAxisID === 'y1'
                  ? ` ${ctx.dataset.label}: ${ctx.raw == null ? '—' : (ctx.raw as number).toFixed(1) + '%'}`
                  : ` ${ctx.dataset.label}: ${fmt(ctx.raw as number, pm)}`,
            },
          },
        },
      },
    });

    return () => { chartInstanceRef.current?.destroy(); chartInstanceRef.current = null; };
  }, [sal, pm]);

  return (
    <>
      <div className="finance-summary-grid investment-summary-grid salary-summary-card">
        <div className="finance-stat">
          <span className="finance-stat-label">Lifetime Earnings</span>
          <span className="finance-stat-value pos">{fmtFull(totalGross, pm)}</span>
        </div>
        <div className="finance-stat">
          <span className="finance-stat-label">Lifetime Tax</span>
          <span className="finance-stat-value neg">{fmtFull(totalTax, pm)}</span>
        </div>
        <div className="finance-stat">
          <span className="finance-stat-label">Total Savings</span>
          <span className="finance-stat-value pos">{fmtFull(totalSavings, pm)}</span>
        </div>
        <div className="finance-stat">
          <span className="finance-stat-label">Savings %</span>
          <span className="finance-stat-value">{fmtPct(savingsAfterTaxPct, pm)}</span>
        </div>
        <div className="finance-stat">
          <span className={`finance-stat-label`}>Avg Tax Rate</span>
          <span className={`finance-stat-value ${valClass(-avgTaxRate)}`}>{avgTaxRate.toFixed(1)}%</span>
        </div>
        <div className="finance-stat finance-stat-emphasis">
          <span className="finance-stat-label">Lifetime Net</span>
          <span className="finance-stat-value orange">{fmtFull(totalNet, pm)}</span>
        </div>
      </div>

      <div className="overview-grid">
        <div className="ov-card full">
          <h3>Salary History</h3>
          <div className="chart-area"><canvas ref={chartRef} /></div>
        </div>

        <div className="ov-card full">
          <h3>All Salaries</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="salary-table">
              <thead>
                <tr>
                  <th>Year</th><th>Teddy</th><th>Teddy Tax</th><th>Teddy Net</th>
                  <th>Nicole</th><th>Nicole Tax</th><th>Nicole Net</th>
                  <th>Total</th><th>Total Tax</th><th>Total Net</th>
                  <th>Teddy YoY</th><th>Nicole YoY</th><th>Total YoY</th>
                </tr>
              </thead>
              <tbody>
                {sal.map((s, i) => {
                  const prev = i > 0 ? sal[i - 1] : null;
                  const tNet = s.teddyGross - s.teddyTax;
                  const nNet = s.nicoleGross - s.nicoleTax;
                  const tGross = s.teddyGross + s.nicoleGross;
                  const tTax = s.teddyTax + s.nicoleTax;
                  const tNetTotal = tGross - tTax;
                  const tYoY = prev?.teddyGross ? ((s.teddyGross - prev.teddyGross) / prev.teddyGross) * 100 : 0;
                  const nYoY = prev?.nicoleGross ? ((s.nicoleGross - prev.nicoleGross) / prev.nicoleGross) * 100 : 0;
                  const prevTotal = prev ? prev.teddyGross + prev.nicoleGross : 0;
                  const totYoY = prevTotal ? ((tGross - prevTotal) / prevTotal) * 100 : 0;
                  return (
                    <tr key={s.year}>
                      <td>{s.year}</td>
                      <td><EditableField value={s.teddyGross} className="editable sal-edit" onSave={(v) => onSaveSalaryField(i, 'teddyGross', v)} /></td>
                      <td><EditableField value={s.teddyTax} className="editable sal-edit" onSave={(v) => onSaveSalaryField(i, 'teddyTax', v)} /></td>
                      <td>{fmt(tNet, pm)}</td>
                      <td><EditableField value={s.nicoleGross} className="editable sal-edit" onSave={(v) => onSaveSalaryField(i, 'nicoleGross', v)} /></td>
                      <td><EditableField value={s.nicoleTax} className="editable sal-edit" onSave={(v) => onSaveSalaryField(i, 'nicoleTax', v)} /></td>
                      <td>{fmt(nNet, pm)}</td>
                      <td>{fmt(tGross, pm)}</td><td>{fmt(tTax, pm)}</td><td>{fmt(tNetTotal, pm)}</td>
                      <td className={tYoY >= 0 ? 'yoy-pos' : 'yoy-neg'}>{fmtPct(tYoY, pm)}</td>
                      <td className={nYoY >= 0 ? 'yoy-pos' : 'yoy-neg'}>{fmtPct(nYoY, pm)}</td>
                      <td className={totYoY >= 0 ? 'yoy-pos' : 'yoy-neg'}>{fmtPct(totYoY, pm)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600, borderTop: '2px solid var(--border-lit)' }}>
                  <td>TOTAL</td><td>{fmt(tot.teddyGross, pm)}</td><td>{fmt(tot.teddyTax, pm)}</td><td>{fmt(totNet.teddyNet, pm)}</td>
                  <td>{fmt(tot.nicoleGross, pm)}</td><td>{fmt(tot.nicoleTax, pm)}</td><td>{fmt(totNet.nicoleNet, pm)}</td>
                  <td>{fmt(totalGross, pm)}</td><td>{fmt(totalTax, pm)}</td><td>{fmt(totalNet, pm)}</td>
                  <td>{fmt(totalSavings, pm)}</td><td>{savingsPct.toFixed(1)}%</td><td>{savingsAfterTaxPct.toFixed(1)}%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="ov-card full">
          <h3>Savings vs Earnings</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="salary-table">
              <thead><tr><th>Year</th><th>Total Savings</th><th>Earnings (Pre-Tax)</th><th>Earnings (Post-Tax)</th><th>Avg Tax Rate</th></tr></thead>
              <tbody>
                {sal.map((s) => {
                  const gross = s.teddyGross + s.nicoleGross;
                  const tax = s.teddyTax + s.nicoleTax;
                  const net = gross - tax;
                  const rate = gross ? (tax / gross) * 100 : 0;
                  const savings = svsMap[s.year] || 0;
                  return (
                    <tr key={s.year}>
                      <td>{s.year}</td><td>{fmt(savings, pm)}</td><td>{fmt(gross, pm)}</td><td>{fmt(net, pm)}</td><td>{rate.toFixed(2)}%</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600, borderTop: '2px solid var(--border-lit)' }}>
                  <td>TOTAL</td><td>{fmt(totalSavings, pm)}</td><td>{fmt(totalGross, pm)}</td><td>{fmt(totalNet, pm)}</td>
                  <td>{totalGross ? ((totalTax / totalGross) * 100).toFixed(2) : 0}%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
