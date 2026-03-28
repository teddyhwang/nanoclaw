import type { InvestmentData, YearData } from '../../types';
import { fmt, fmtFull, fmtPct, valClass } from '../../utils/format';
import { calcTax } from '../../utils/accounts';
import { usePrivacy } from '../../contexts/PrivacyContext';
import { SummaryStats } from './SummaryStats';
import { EditableField } from './EditableField';

interface Props {
  year: string;
  data: InvestmentData;
  onUpdateField: (year: string, path: string[], value: number) => void;
}

export function YearDetail({ year, data, onUpdateField }: Props) {
  const { privacyMode } = usePrivacy();
  const pm = privacyMode;
  const d = data.years[year];
  if (!d) return <p>No data for this year.</p>;

  const isCurrentYear = parseInt(year) === new Date().getFullYear();
  const liveBadge = isCurrentYear ? (
    <span style={{
      fontSize: '9px', background: 'rgba(159,202,86,0.2)', color: 'var(--green)',
      padding: '2px 6px', borderRadius: '3px', letterSpacing: '0.5px', verticalAlign: 'middle',
    }}>LIVE</span>
  ) : null;

  const brackets = d.taxBrackets || [];
  const teddyGross = d.salary.teddy.gross;
  const nicoleGross = d.salary.nicole.gross;
  const teddyTax = d.salary.teddy.actualTax;
  const nicoleTax = d.salary.nicole.actualTax;
  const teddyTaxRate = d.salary.teddy.actualTaxRate;
  const nicoleTaxRate = d.salary.nicole.actualTaxRate;
  const teddyRrsp = d.contributions.rrsp.teddy;
  const nicoleRrsp = d.contributions.rrsp.nicole;
  const teddyRefund = calcTax(teddyGross, brackets) - calcTax(teddyGross - teddyRrsp, brackets);
  const nicoleRefund = calcTax(nicoleGross, brackets) - calcTax(nicoleGross - nicoleRrsp, brackets);
  const totalGross = teddyGross + nicoleGross;
  const totalTax = teddyTax + nicoleTax;
  const totalNet = totalGross - totalTax;
  const totalRefund = teddyRefund + nicoleRefund;
  const teddyNetContrib = d.contributions.rrsp.teddy + d.contributions.tfsa.teddy - d.contributions.tfsaWithdrawals.teddy;
  const nicoleNetContrib = d.contributions.rrsp.nicole + d.contributions.tfsa.nicole - d.contributions.tfsaWithdrawals.nicole;
  const totalContrib = teddyNetContrib + nicoleNetContrib + d.contributions.respContributions;

  const debtEntries = Object.entries(d.debt).filter(([k]) => k !== 'totalDebt' && d.debt[k] !== 0);

  const save = (path: string[], value: number) => onUpdateField(year, path, value);

  return (
    <>
      <SummaryStats year={year} data={d} liveBadge={isCurrentYear} />
      <div className="year-grid">
        {/* Left: Returns + Portfolio */}
        <div className="yr-card">
          <h3>Returns {liveBadge}</h3>
          <div className="person-grid">
            <span /><span className="pg-header">Start</span><span className="pg-header">Current</span><span className="pg-header">Return</span>
            {d.returns.td.startingBalance ? (
              <>
                <span className="pg-label">TD</span>
                <EditableField value={d.returns.td.startingBalance} onSave={(v) => save(['returns', 'td', 'startingBalance'], v)} />
                <span className={`pg-val ${valClass(d.returns.td.returnAmount)}`}>{fmt(d.returns.td.currentBalance, pm)}</span>
                <span className={`pg-val ${valClass(d.returns.td.returnAmount)}`}>{fmtPct(d.returns.td.returnPct, pm)}</span>
              </>
            ) : null}
            {d.returns.wealthsimple.totalStart ? (
              <>
                <span className="pg-label">Wealthsimple</span>
                <EditableField value={d.returns.wealthsimple.totalStart} onSave={(v) => save(['returns', 'wealthsimple', 'totalStart'], v)} />
                <span className={`pg-val ${valClass(d.returns.wealthsimple.returnAmount)}`}>{fmt(d.returns.wealthsimple.totalCurrent, pm)}</span>
                <span className={`pg-val ${valClass(d.returns.wealthsimple.returnAmount)}`}>{fmtPct(d.returns.wealthsimple.returnPct, pm)}</span>
              </>
            ) : null}
            <span className="pg-label pg-total">Total</span>
            <span className="pg-val pg-total">{fmtFull((d.returns.td.startingBalance || 0) + (d.returns.wealthsimple.totalStart || 0), pm)}</span>
            <span className={`pg-val pg-total ${valClass(d.returns.total.returnAmount)}`}>{fmtFull(d.summary.total, pm)}</span>
            <span className={`pg-val pg-total ${valClass(d.returns.total.returnAmount)}`}>
              {fmtFull(d.returns.total.returnAmount, pm)} ({fmtPct(d.returns.total.returnPct, pm)})
            </span>
          </div>

          {d.returns.goal ? (
            <>
              <div className="data-row" style={{ marginTop: 8 }}>
                <span className="dl">10% Goal</span>
                <span className="dv">{fmtFull(d.returns.goal, pm)}</span>
              </div>
              <div className="data-row">
                <span className="dl">vs Goal</span>
                <span className={`dv ${valClass(d.returns.currentVsGoal || 0)}`}>
                  {fmtFull(d.returns.currentVsGoal || 0, pm)} ({fmtPct(d.returns.pctDifference || 0, pm)})
                </span>
              </div>
            </>
          ) : null}

          {/* Debt */}
          {d.accounts.allLoans?.length ? (
            <>
              <h3 className="section-gap">Debt {liveBadge}</h3>
              {d.accounts.allLoans.map((l, i) => (
                <div key={i} className="data-row">
                  <span className="dl">{l.name} <span className="inst-tag">{l.institution}</span></span>
                  <span className="dv neg">{fmtFull(l.balance, pm)}</span>
                </div>
              ))}
              <div className="data-row total">
                <span className="dl">Total Debt</span>
                <span className="dv neg">{fmtFull(d.debt.totalDebt, pm)}</span>
              </div>
            </>
          ) : debtEntries.length ? (
            <>
              <h3 className="section-gap">Debt</h3>
              {debtEntries.map(([k, v]) => (
                <div key={k} className="data-row">
                  <span className="dl">{k}</span>
                  <span className="dv neg">{fmtFull(v, pm)}</span>
                </div>
              ))}
              <div className="data-row total">
                <span className="dl">Total Debt</span>
                <span className="dv neg">{fmtFull(d.debt.totalDebt, pm)}</span>
              </div>
            </>
          ) : null}

          {/* Portfolio */}
          <h3 className="section-gap">Portfolio {liveBadge}</h3>
          <PortfolioSection data={d} privacyMode={pm} />
          <div className="data-row total">
            <span className="dl">Total Investments</span>
            <span className="dv blue">{fmtFull(d.summary.total, pm)}</span>
          </div>
        </div>

        {/* Right: Income & Contributions */}
        <div className="yr-card">
          <h3>Income — {year}</h3>
          <div className="person-grid">
            <span /><span className="pg-header">Teddy</span><span className="pg-header">Nicole</span><span className="pg-header">Total</span>
            <span className="pg-label">Gross Salary</span>
            <EditableField value={teddyGross} onSave={(v) => save(['salary', 'teddy', 'gross'], v)} />
            <EditableField value={nicoleGross} onSave={(v) => save(['salary', 'nicole', 'gross'], v)} />
            <span className="pg-val">{fmtFull(totalGross, pm)}</span>
            <span className="pg-label">Tax ({teddyTaxRate}% / {nicoleTaxRate}%)</span>
            <span className="pg-val neg">{fmtFull(teddyTax, pm)}</span>
            <span className="pg-val neg">{fmtFull(nicoleTax, pm)}</span>
            <span className="pg-val neg">{fmtFull(totalTax, pm)}</span>
            <span className="pg-label pg-total">Net Income</span>
            <span className="pg-val pg-total orange">{fmtFull(teddyGross - teddyTax, pm)}</span>
            <span className="pg-val pg-total orange">{fmtFull(nicoleGross - nicoleTax, pm)}</span>
            <span className="pg-val pg-total orange">{fmtFull(totalNet, pm)}</span>
          </div>

          {d.taxBrackets.length > 0 && (
            <>
              <h3 className="section-gap">Tax Brackets</h3>
              <table className="salary-table" style={{ fontSize: '11px' }}>
                <thead><tr><th>Up To</th><th>Rate</th><th>Tax</th><th>Cumulative</th></tr></thead>
                <tbody>
                  {d.taxBrackets.filter((b) => b.tax > 0).map((b, i) => (
                    <tr key={i}>
                      <td>{fmtFull(b.upTo, pm)}</td>
                      <td>{b.rate.toFixed(2)}%</td>
                      <td>{fmtFull(b.tax, pm)}</td>
                      <td>{fmtFull(b.cumulative, pm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3 className="section-gap">Contributions</h3>
          <div className="person-grid">
            <span /><span className="pg-header">Teddy</span><span className="pg-header">Nicole</span><span className="pg-header">Total</span>
            <span className="pg-label">RRSP</span>
            <EditableField value={d.contributions.rrsp.teddy} onSave={(v) => save(['contributions', 'rrsp', 'teddy'], v)} />
            <EditableField value={d.contributions.rrsp.nicole} onSave={(v) => save(['contributions', 'rrsp', 'nicole'], v)} />
            <span className="pg-val">{fmtFull(d.contributions.rrsp.teddy + d.contributions.rrsp.nicole, pm)}</span>
            <span className="pg-label">Tax Refund (RRSP)</span>
            <span className="pg-val pos">{fmtFull(teddyRefund, pm)}</span>
            <span className="pg-val pos">{fmtFull(nicoleRefund, pm)}</span>
            <span className="pg-val pos">{fmtFull(totalRefund, pm)}</span>
            <span className="pg-label">TFSA</span>
            <EditableField value={d.contributions.tfsa.teddy} onSave={(v) => save(['contributions', 'tfsa', 'teddy'], v)} />
            <EditableField value={d.contributions.tfsa.nicole} onSave={(v) => save(['contributions', 'tfsa', 'nicole'], v)} />
            <span className="pg-val">{fmtFull(d.contributions.tfsa.teddy + d.contributions.tfsa.nicole, pm)}</span>
            <span className="pg-label">TFSA Withdrawals</span>
            <EditableField value={d.contributions.tfsaWithdrawals.teddy} onSave={(v) => save(['contributions', 'tfsaWithdrawals', 'teddy'], v)} />
            <EditableField value={d.contributions.tfsaWithdrawals.nicole} onSave={(v) => save(['contributions', 'tfsaWithdrawals', 'nicole'], v)} />
            <span className="pg-val">{fmtFull(d.contributions.tfsaWithdrawals.teddy + d.contributions.tfsaWithdrawals.nicole, pm)}</span>
            <span className="pg-label">RESP</span>
            <EditableField value={d.contributions.respContributions} onSave={(v) => save(['contributions', 'respContributions'], v)} />
            <span className="pg-val">—</span>
            <span className="pg-val">{fmtFull(d.contributions.respContributions, pm)}</span>
            <span className="pg-label pg-total">Net Contributions</span>
            <span className="pg-val pg-total">{fmtFull(teddyNetContrib, pm)}</span>
            <span className="pg-val pg-total">{fmtFull(nicoleNetContrib, pm)}</span>
            <span className="pg-val pg-total orange">{fmtFull(totalContrib, pm)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

function PortfolioSection({ data: d, privacyMode: pm }: { data: YearData; privacyMode: boolean }) {
  if (d.accounts.allAccounts) {
    return <LivePortfolio data={d} privacyMode={pm} />;
  }
  return (
    <>
      <div className="data-row"><span className="dl">TD Savings</span><span className="dv blue">{fmtFull(d.summary.tdSavings || 0, pm)}</span></div>
      <div className="data-row"><span className="dl">Wealthsimple</span><span className="dv blue">{fmtFull(d.summary.wealthsimple || 0, pm)}</span></div>
      {d.summary.shopifyRsu ? (
        <div className="data-row"><span className="dl">Shopify RSU</span><span className="dv blue">{fmtFull(d.summary.shopifyRsu, pm)}</span></div>
      ) : null}
    </>
  );
}

function LivePortfolio({ data: d, privacyMode: pm }: { data: YearData; privacyMode: boolean }) {
  const groups: Record<string, typeof d.accounts.allAccounts> = { rrsp: [], tfsa: [], resp: [], nonreg: [], crypto: [] };
  const labels: Record<string, string> = { rrsp: 'RRSP', tfsa: 'TFSA', resp: 'RESP', nonreg: 'Non-registered', crypto: 'Crypto' };

  for (const a of d.accounts.allAccounts!) {
    const type = a.type === 'cash' ? 'nonreg' : a.type;
    if (groups[type]) groups[type]!.push(a);
    else groups.nonreg!.push(a);
  }

  const personGrid = (label: string, providers: Record<string, { teddy?: number; nicole?: number }> | undefined, totals: { teddy: number; nicole: number; total: number } | undefined) => {
    const entries = Object.entries(providers || {}).filter(([, v]) => (v?.teddy || 0) || (v?.nicole || 0));
    if (!entries.length) return null;
    return (
      <div key={label}>
        <div className="acct-section-label">{label}</div>
        <div className="person-grid portfolio-grid">
          <span /><span className="pg-header">Teddy</span><span className="pg-header">Nicole</span><span className="pg-header">Total</span>
          {entries.map(([provider, vals]) => (
            <div key={provider} style={{ display: 'contents' }}>
              <span className="pg-label">{provider}</span>
              <span className="pg-val">{fmtFull(vals.teddy || 0, pm)}</span>
              <span className="pg-val">{fmtFull(vals.nicole || 0, pm)}</span>
              <span className="pg-val">{fmtFull((vals.teddy || 0) + (vals.nicole || 0), pm)}</span>
            </div>
          ))}
          <span className="pg-label pg-total">{label} Total</span>
          <span className="pg-val pg-total">{fmtFull(totals?.teddy || 0, pm)}</span>
          <span className="pg-val pg-total">{fmtFull(totals?.nicole || 0, pm)}</span>
          <span className="pg-val pg-total orange">{fmtFull(totals?.total || 0, pm)}</span>
        </div>
      </div>
    );
  };

  return (
    <>
      {personGrid('RRSP', d.accounts.rrsp, d.accounts.totalRrsp)}
      {personGrid('TFSA', d.accounts.tfsa, d.accounts.totalTfsa)}
      {Object.entries(groups).map(([type, accts]) => {
        if (!accts!.length || type === 'rrsp' || type === 'tfsa') return null;
        const subtotal = accts!.reduce((s, a) => s + a.balance, 0);
        return (
          <div key={type}>
            <div className="acct-section-label">{labels[type] || type}</div>
            {accts!.map((a, i) => {
              const curLabel = a.currency !== 'cad' ? ` ${a.currency.toUpperCase()}` : '';
              return (
                <div key={i} className="data-row">
                  <span className="dl">{a.name} <span className="inst-tag">{a.institution}</span></span>
                  <span className="dv">{fmtFull(a.balance, pm)}{curLabel && <small style={{ color: 'var(--muted)' }}>{curLabel}</small>}</span>
                </div>
              );
            })}
            <div className="data-row total">
              <span className="dl">{labels[type]} Total</span>
              <span className="dv orange">{fmtFull(subtotal, pm)}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
