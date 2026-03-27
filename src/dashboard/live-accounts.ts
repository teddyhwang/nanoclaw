/**
 * Maps Lunch Money accounts to investment categories for live 2026 data.
 *
 * Account display_name → category mapping. When LM balances are fresh,
 * the current year's account data is computed from live balances instead
 * of the static import.
 */
import { getBalances, LMAccount } from './lunchmoney.js';
import { loadInvestmentData, YearData } from './investments.js';

// ── Account mapping ─────────────────────────────────────────
// Each LM account maps to: type (rrsp/tfsa/other/debt), provider, person

interface AccountMapping {
  type: 'rrsp' | 'tfsa' | 'resp' | 'nonreg' | 'crypto' | 'cash' | 'debt';
  provider: string;
  person: 'teddy' | 'nicole' | 'joint';
}

// Mapping by substring match on display_name
const ACCOUNT_MAP: [RegExp, AccountMapping][] = [
  // RRSP - TD
  [/TD.*SDRSP.*Teddy/i, { type: 'rrsp', provider: 'TD', person: 'teddy' }],
  [/TD.*SDRSP.*Nicole/i, { type: 'rrsp', provider: 'TD', person: 'nicole' }],
  // RRSP - Wealthsimple
  [
    /Wealthsimple.*Group RRSP.*Teddy/i,
    { type: 'rrsp', provider: 'Wealthsimple', person: 'teddy' },
  ],
  [
    /Wealthsimple.*RRSP Private Credit/i,
    { type: 'rrsp', provider: 'Wealthsimple', person: 'teddy' },
  ],
  [
    /Wealthsimple.*RRSP Private Equity/i,
    { type: 'rrsp', provider: 'Wealthsimple', person: 'teddy' },
  ],
  [
    /Wealthsimple.*RRSP.*Teddy/i,
    { type: 'rrsp', provider: 'Wealthsimple', person: 'teddy' },
  ],
  [
    /Wealthsimple.*RRSP$/,
    { type: 'rrsp', provider: 'Wealthsimple', person: 'nicole' },
  ],
  // TFSA
  [/TD.*TFSA.*Teddy/i, { type: 'tfsa', provider: 'TD', person: 'teddy' }],
  [/TD.*TFSA.*Nicole/i, { type: 'tfsa', provider: 'TD', person: 'nicole' }],
  [
    /Wealthsimple.*TFSA.*Teddy/i,
    { type: 'tfsa', provider: 'Wealthsimple', person: 'teddy' },
  ],
  [
    /Wealthsimple.*TFSA.*Nicole/i,
    { type: 'tfsa', provider: 'Wealthsimple', person: 'nicole' },
  ],
  // RESP
  [/RESP/i, { type: 'resp', provider: 'TD', person: 'joint' }],
  // Non-registered / Crypto
  [
    /Wealthsimple.*Non-registered/i,
    { type: 'nonreg', provider: 'Wealthsimple', person: 'teddy' },
  ],
  [
    /Wealthsimple.*Crypto/i,
    { type: 'crypto', provider: 'Wealthsimple', person: 'teddy' },
  ],
  // Cash / Savings (TD investment accounts that are cash-like)
  [/TD.*CANADIAN CASH/i, { type: 'cash', provider: 'TD', person: 'joint' }],
  [/TD.*US CASH/i, { type: 'cash', provider: 'TD', person: 'joint' }],
  // Debt / Loans
  [
    /Beecroft/i,
    { type: 'debt', provider: 'Beecroft Mortgage', person: 'joint' },
  ],
  [
    /Valhalla/i,
    { type: 'debt', provider: 'Valhalla Road Mortgage', person: 'joint' },
  ],
  [
    /Yonge/i,
    { type: 'debt', provider: 'Gibson Square Mortgage', person: 'joint' },
  ],
];

function mapAccount(account: LMAccount): AccountMapping | null {
  for (const [pattern, mapping] of ACCOUNT_MAP) {
    if (pattern.test(account.display_name)) return mapping;
  }
  return null;
}

// ── Build live year data ────────────────────────────────────

export async function getLiveCurrentYear(): Promise<YearData | null> {
  const investData = loadInvestmentData();
  if (!investData) return null;

  const currentYear = String(new Date().getFullYear());
  const baseYear = investData.years[currentYear];
  if (!baseYear) return null;

  // Get fresh balances
  const balances = await getBalances(false);

  // Categorize accounts
  const rrsp: Record<string, { teddy: number; nicole: number }> = {};
  const tfsa: Record<string, { teddy: number; nicole: number }> = {};
  let resp = 0;
  let nonRegistered = 0;
  let crypto = 0;
  const debt: Record<string, number> = {};
  let tdTotal = 0;
  let wsTotal = 0;

  for (const acct of balances.accounts) {
    if (acct.type !== 'investment' && acct.type !== 'loan') continue;

    const mapping = mapAccount(acct);
    if (!mapping) continue;

    // Use to_base for currency-normalized value (USD→CAD)
    const bal = acct.to_base ?? parseFloat(acct.balance);

    switch (mapping.type) {
      case 'rrsp': {
        if (!rrsp[mapping.provider])
          rrsp[mapping.provider] = { teddy: 0, nicole: 0 };
        if (mapping.person === 'teddy') rrsp[mapping.provider].teddy += bal;
        else rrsp[mapping.provider].nicole += bal;
        if (mapping.provider === 'TD') tdTotal += bal;
        else wsTotal += bal;
        break;
      }
      case 'tfsa': {
        if (!tfsa[mapping.provider])
          tfsa[mapping.provider] = { teddy: 0, nicole: 0 };
        if (mapping.person === 'teddy') tfsa[mapping.provider].teddy += bal;
        else tfsa[mapping.provider].nicole += bal;
        if (mapping.provider === 'TD') tdTotal += bal;
        else wsTotal += bal;
        break;
      }
      case 'resp':
        resp += bal;
        tdTotal += bal;
        break;
      case 'nonreg':
        nonRegistered += bal;
        wsTotal += bal;
        break;
      case 'crypto':
        crypto += bal;
        wsTotal += bal;
        break;
      case 'cash':
        tdTotal += bal;
        break;
      case 'debt':
        debt[mapping.provider] = -Math.abs(bal);
        break;
    }
  }

  // Compute totals
  const totalRrspTeddy = Object.values(rrsp).reduce((s, v) => s + v.teddy, 0);
  const totalRrspNicole = Object.values(rrsp).reduce((s, v) => s + v.nicole, 0);
  const totalTfsaTeddy = Object.values(tfsa).reduce((s, v) => s + v.teddy, 0);
  const totalTfsaNicole = Object.values(tfsa).reduce((s, v) => s + v.nicole, 0);
  const totalDebt = Object.values(debt).reduce((s, v) => s + v, 0);
  const total = tdTotal + wsTotal;
  const subtotal = total + totalDebt;

  // Compute returns from starting balances (kept from static data)
  const tdReturn = tdTotal - baseYear.returns.td.startingBalance;
  const tdReturnPct = baseYear.returns.td.startingBalance
    ? (tdReturn / baseYear.returns.td.startingBalance) * 100
    : 0;

  const wsTotalStart = baseYear.returns.wealthsimple.totalStart;
  const wsReturn = wsTotal - wsTotalStart;
  const wsReturnPct = wsTotalStart ? (wsReturn / wsTotalStart) * 100 : 0;

  const totalReturn = tdReturn + wsReturn;
  const totalStartBal = baseYear.returns.td.startingBalance + wsTotalStart;
  const totalReturnPct = totalStartBal
    ? (totalReturn / totalStartBal) * 100
    : 0;

  const goal = totalStartBal * (10 / 100); // 10% goal
  const totalGoal = totalStartBal + goal;
  const currentVsGoal = total - totalGoal;
  const pctDifference = totalGoal ? ((total - totalGoal) / totalGoal) * 100 : 0;

  // Merge: keep static data for salary/contributions/tax, override accounts/returns/debt
  return {
    ...baseYear,
    accounts: {
      rrsp,
      totalRrsp: {
        teddy: totalRrspTeddy,
        nicole: totalRrspNicole,
        total: totalRrspTeddy + totalRrspNicole,
      },
      tfsa,
      totalTfsa: {
        teddy: totalTfsaTeddy,
        nicole: totalTfsaNicole,
        total: totalTfsaTeddy + totalTfsaNicole,
      },
      privateInvesting: nonRegistered,
      nonRegistered,
      crypto,
      resp,
    },
    summary: {
      tdSavings: tdTotal,
      wealthsimple: wsTotal,
      shopifyRsu: 0,
      total,
    },
    returns: {
      td: {
        startingBalance: baseYear.returns.td.startingBalance,
        currentBalance: tdTotal,
        returnAmount: tdReturn,
        returnPct: tdReturnPct,
      },
      wealthsimple: {
        ...baseYear.returns.wealthsimple,
        totalCurrent: wsTotal,
        returnAmount: wsReturn,
        returnPct: wsReturnPct,
      },
      total: { returnAmount: totalReturn, returnPct: totalReturnPct },
      goal,
      totalGoal,
      currentVsGoal,
      pctDifference,
    },
    debt: { ...debt, totalDebt },
    subtotal,
  };
}
