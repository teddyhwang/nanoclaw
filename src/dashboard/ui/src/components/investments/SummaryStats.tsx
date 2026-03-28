import type { YearData } from '../../types';
import { fmtFull, fmtPct, valClass } from '../../utils/format';
import { usePrivacy } from '../../contexts/PrivacyContext';

function TrendArrow({ direction }: { direction?: 'up' | 'down' | 'flat' }) {
  if (!direction || direction === 'flat') return null;
  const arrow = direction === 'up' ? '▲' : '▼';
  const color = direction === 'up' ? 'var(--green)' : 'var(--red)';
  return <span style={{ color, marginLeft: 6, fontSize: '0.75em' }}>{arrow}</span>;
}

interface Props {
  year: string;
  data: YearData;
  liveBadge?: boolean;
}

export function SummaryStats({ data: d, liveBadge }: Props) {
  const { privacyMode } = usePrivacy();
  const pm = privacyMode;

  const teddyGross = d.salary.teddy.gross;
  const nicoleGross = d.salary.nicole.gross;
  const teddyTax = d.salary.teddy.actualTax;
  const nicoleTax = d.salary.nicole.actualTax;
  const totalNet = teddyGross + nicoleGross - teddyTax - nicoleTax;
  const teddyNetContrib =
    d.contributions.rrsp.teddy + d.contributions.tfsa.teddy - d.contributions.tfsaWithdrawals.teddy;
  const nicoleNetContrib =
    d.contributions.rrsp.nicole + d.contributions.tfsa.nicole - d.contributions.tfsaWithdrawals.nicole;
  const totalContrib = teddyNetContrib + nicoleNetContrib + d.contributions.respContributions;

  const badge = liveBadge ? <span className="live-badge">LIVE</span> : null;

  return (
    <div className="finance-summary-grid investment-summary-grid">
      <div
        className={`finance-stat finance-stat-emphasis finance-stat-${valClass(d.returns.total.returnAmount) || 'neutral'}`}
      >
        <span className="finance-stat-label">
          Total Return {badge}
        </span>
        <div className="finance-stat-value-row">
          <span className={`finance-stat-value ${valClass(d.returns.total.returnAmount)}`}>
            {fmtFull(d.returns.total.returnAmount, pm)}
            <TrendArrow direction={d.trends?.totalReturn.direction} />
          </span>
          <span className={`finance-stat-sub ${valClass(d.returns.total.returnAmount)}`}>
            {fmtPct(d.returns.total.returnPct, pm)}
          </span>
        </div>
      </div>
      <div className="finance-stat finance-stat-emphasis">
        <span className="finance-stat-label">Net Position</span>
        <span className={`finance-stat-value ${valClass(d.subtotal)}`}>
          {fmtFull(d.subtotal, pm)}
        </span>
      </div>
      <div className="finance-stat">
        <span className="finance-stat-label">Total Investments</span>
        <span className="finance-stat-value pos">
          {fmtFull(d.summary.total, pm)}
          <TrendArrow direction={d.trends?.totalInvestments.direction} />
        </span>
      </div>
      <div className="finance-stat">
        <span className="finance-stat-label">Total Debt</span>
        <span className="finance-stat-value neg">{fmtFull(d.debt.totalDebt, pm)}</span>
      </div>
      <div className="finance-stat">
        <span className="finance-stat-label">Net Income</span>
        <span className="finance-stat-value orange">{fmtFull(totalNet, pm)}</span>
      </div>
      <div className="finance-stat">
        <span className="finance-stat-label">Net Contributions</span>
        <span className={`finance-stat-value ${valClass(totalContrib)}`}>
          {fmtFull(totalContrib, pm)}
        </span>
      </div>
    </div>
  );
}
