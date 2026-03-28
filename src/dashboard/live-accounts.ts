/**
 * Maps Lunch Money accounts to investment categories for live 2026 data.
 *
 * Account display_name → category mapping. When LM balances are fresh,
 * the current year's account data is computed from live balances instead
 * of the static import.
 */
import fs from 'fs';
import path from 'path';
import { getBalances, LMAccount } from './lunchmoney.js';
import { loadInvestmentData, YearData } from './investments.js';

// ── Trend tracking ──────────────────────────────────────────

const DB_DIR = path.resolve(process.cwd(), 'db');
const TRENDS_FILE = path.join(DB_DIR, 'investment-trends.json');

export interface TrendData {
  totalReturn: { previous: number; current: number; direction: 'up' | 'down' | 'flat' };
  totalInvestments: { previous: number; current: number; direction: 'up' | 'down' | 'flat' };
  updatedAt: string;
}

function loadTrends(): { totalReturn: number; totalInvestments: number } | null {
  try {
    if (!fs.existsSync(TRENDS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TRENDS_FILE, 'utf-8'));
    return {
      totalReturn: data.totalReturn?.current ?? null,
      totalInvestments: data.totalInvestments?.current ?? null,
    };
  } catch {
    return null;
  }
}

function saveTrends(totalReturn: number, totalInvestments: number): TrendData {
  const prev = loadTrends();
  const direction = (current: number, previous: number | null): 'up' | 'down' | 'flat' => {
    if (previous === null) return 'flat';
    if (current > previous) return 'up';
    if (current < previous) return 'down';
    return 'flat';
  };

  const trends: TrendData = {
    totalReturn: {
      previous: prev?.totalReturn ?? totalReturn,
      current: totalReturn,
      direction: direction(totalReturn, prev?.totalReturn ?? null),
    },
    totalInvestments: {
      previous: prev?.totalInvestments ?? totalInvestments,
      current: totalInvestments,
      direction: direction(totalInvestments, prev?.totalInvestments ?? null),
    },
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(TRENDS_FILE, JSON.stringify(trends, null, 2));
  return trends;
}

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
    /Wealthsimple.*RRSP.*Nicole/i,
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
  [/TD.*Non-registered/i, { type: 'nonreg', provider: 'TD', person: 'joint' }],
  [
    /Wealthsimple.*Crypto/i,
    { type: 'crypto', provider: 'Wealthsimple', person: 'teddy' },
  ],
  // Legacy TD cash/savings names (kept for backward compatibility)
  [/TD.*CANADIAN CASH/i, { type: 'nonreg', provider: 'TD', person: 'joint' }],
  [/TD.*US CASH/i, { type: 'nonreg', provider: 'TD', person: 'joint' }],
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

export async function getLiveCurrentYear(): Promise<(YearData & { trends?: TrendData }) | null> {
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

  const allAccounts: {
    name: string;
    balance: number;
    currency: string;
    type: string;
    category: string;
    institution: string;
  }[] = [];
  const allLoans: { name: string; balance: number; institution: string }[] = [];

  for (const acct of balances.accounts) {
    if (acct.type !== 'investment' && acct.type !== 'loan') continue;

    const mapping = mapAccount(acct);
    if (!mapping) continue;

    // Shorten display name
    let shortName = acct.display_name;
    if (acct.institution_name && shortName.startsWith(acct.institution_name)) {
      shortName = shortName
        .slice(acct.institution_name.length)
        .replace(/^\s+/, '');
    }

    const bal = acct.to_base ?? parseFloat(acct.balance);

    const inst = acct.institution_name || mapping.provider;
    if (acct.type === 'loan') {
      allLoans.push({
        name: shortName,
        balance: -Math.abs(bal),
        institution: inst,
      });
    } else {
      allAccounts.push({
        name: shortName,
        balance: bal,
        currency: acct.currency,
        type: mapping.type === 'cash' ? 'nonreg' : mapping.type,
        category: mapping.provider,
        institution: inst,
      });
    }

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
        if (mapping.provider === 'TD') tdTotal += bal;
        else wsTotal += bal;
        break;
      case 'crypto':
        crypto += bal;
        wsTotal += bal;
        break;
      case 'cash':
        nonRegistered += bal;
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

  // Track trends for total return and total investments
  const trends = saveTrends(totalReturn, total);

  // Merge: keep static data for salary/contributions/tax, override accounts/returns/debt
  return {
    ...baseYear,
    trends,
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
      allAccounts: allAccounts.sort((a, b) => b.balance - a.balance),
      allLoans,
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
