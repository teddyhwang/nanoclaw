import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js';
import type { InvestmentData } from '../../types';
import { fmt, fmtPct } from '../../utils/format';
import { COLORS } from '../../constants';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { SummaryStats } from './SummaryStats';

interface Props {
  data: InvestmentData;
}

export function Overview({ data }: Props) {
  const { privacyMode } = usePrivacy();
  const pm = privacyMode;
  const growthRef = useRef<HTMLCanvasElement>(null);
  const returnsRef = useRef<HTMLCanvasElement>(null);
  const taxRef = useRef<HTMLCanvasElement>(null);
  const savingsRef = useRef<HTMLCanvasElement>(null);
  const chartsRef = useRef<Chart[]>([]);

  const currentYear = Object.keys(data.years)
    .sort((a, b) => Number(b) - Number(a))[0];
  const cur = data.years[currentYear];
  const isLive = !!cur?.accounts.allAccounts;

  useEffect(() => {
    chartsRef.current.forEach((c) => c.destroy());
    chartsRef.current = [];
    const charts: Chart[] = [];

    // Growth chart
    if (growthRef.current) {
      const pmYears = data.predictionModel.years.filter((y) => y.predictedSavings > 0);
      charts.push(
        new Chart(growthRef.current, {
          type: 'line',
          data: {
            labels: pmYears.map((y) => y.year),
            datasets: [
              {
                label: 'Actual',
                data: pmYears.map((y) => y.actualSavings),
                borderColor: COLORS.green,
                backgroundColor: COLORS.green + '20',
                fill: true,
                pointRadius: 3,
                tension: 0.3,
              },
              {
                label: 'Predicted (10% ROI)',
                data: pmYears.map((y) => y.predictedSavings),
                borderColor: COLORS.muted,
                borderDash: [5, 3],
                pointRadius: 0,
                tension: 0.3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { y: { ticks: { callback: (v) => fmt(v as number, pm) } } },
            plugins: {
              tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.raw as number, pm)}` } },
            },
          },
        }),
      );
    }

    // Returns chart
    if (returnsRef.current) {
      const retRows = data.predictionModel.years.filter(
        (y) => y.annualReturnPct != null && y.actualSavings != null,
      );
      const retData = retRows.map((y) => y.annualReturnPct!);
      charts.push(
        new Chart(returnsRef.current, {
          type: 'bar',
          data: {
            labels: retRows.map((y) => y.year),
            datasets: [
              {
                data: retData,
                backgroundColor: retData.map((v) => (v >= 0 ? COLORS.green + 'bb' : COLORS.red + 'bb')),
                borderRadius: 3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: { ticks: { callback: (v) => v + '%' } },
              x: { grid: { display: false } },
            },
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: (ctx) => ` ${fmtPct(ctx.raw as number, pm)}` } },
            },
          },
        }),
      );
    }

    // Tax chart
    if (taxRef.current) {
      const salYears = data.salaries.filter((s) => s.year >= 2016);
      charts.push(
        new Chart(taxRef.current, {
          type: 'bar',
          data: {
            labels: salYears.map((s) => s.year),
            datasets: [
              {
                label: 'Net Income',
                data: salYears.map((s) => s.teddyGross + s.nicoleGross - s.teddyTax - s.nicoleTax),
                backgroundColor: COLORS.blue + 'bb',
                borderRadius: 3,
              },
              {
                label: 'Tax',
                data: salYears.map((s) => s.teddyTax + s.nicoleTax),
                backgroundColor: COLORS.red + 'bb',
                borderRadius: 3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { stacked: true, grid: { display: false } },
              y: { stacked: true, ticks: { callback: (v) => fmt(v as number, pm) } },
            },
            plugins: {
              tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.raw as number, pm)}` } },
            },
          },
        }),
      );
    }

    // Savings vs Earnings
    if (savingsRef.current) {
      const svsMap: Record<number, number> = {};
      for (const s of data.savingsVsSalaries) svsMap[s.year] = s.totalSavings;
      let cumNet = 0;
      const cumNets = data.salaries.map((s) => {
        cumNet += s.teddyGross - s.teddyTax + (s.nicoleGross - s.nicoleTax);
        return cumNet;
      });
      charts.push(
        new Chart(savingsRef.current, {
          type: 'line',
          data: {
            labels: data.salaries.map((s) => s.year),
            datasets: [
              {
                label: 'Total Savings',
                data: data.salaries.map((s) => svsMap[s.year] || 0),
                borderColor: COLORS.green,
                pointRadius: 3,
                tension: 0.3,
              },
              {
                label: 'Cumulative Net Earnings',
                data: cumNets,
                borderColor: COLORS.blue,
                pointRadius: 3,
                tension: 0.3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { y: { ticks: { callback: (v) => fmt(v as number, pm) } } },
            plugins: {
              tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.raw as number, pm)}` } },
            },
          },
        }),
      );
    }

    chartsRef.current = charts;
    return () => charts.forEach((c) => c.destroy());
  }, [data, pm]);

  if (!cur) return <p>No data available.</p>;

  return (
    <>
      <SummaryStats year={currentYear} data={cur} liveBadge={isLive} />
      <div className="ov-grid-2x2">
        <div className="ov-cell">
          <h3>Savings Growth — Actual vs Predicted</h3>
          <div className="ov-chart-area"><canvas ref={growthRef} /></div>
        </div>
        <div className="ov-cell">
          <h3>Savings vs Earnings</h3>
          <div className="ov-chart-area"><canvas ref={savingsRef} /></div>
        </div>
        <div className="ov-cell">
          <h3>Annual Returns %</h3>
          <div className="ov-chart-area"><canvas ref={returnsRef} /></div>
        </div>
        <div className="ov-cell">
          <h3>Income vs Tax</h3>
          <div className="ov-chart-area"><canvas ref={taxRef} /></div>
        </div>
      </div>
    </>
  );
}
