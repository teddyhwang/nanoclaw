/**
 * Investment data model and persistence.
 *
 * Stores yearly investment tracking data in db/investments.json.
 * Data is imported from the Google Sheets spreadsheet and can be
 * edited via the dashboard UI.
 */
import fs from 'fs';
import path from 'path';

const DB_DIR = path.resolve(process.cwd(), 'db');
const DATA_FILE = path.join(DB_DIR, 'investments.json');

// ── Data model ──────────────────────────────────────────────

export interface Person {
  teddy: number;
  nicole: number;
}

export interface SalaryInfo {
  gross: number;
  rrspDeduction: number;
  actualTaxRate: number;
  actualTax: number;
}

export interface YearData {
  year: number;
  salary: {
    teddy: SalaryInfo;
    nicole: SalaryInfo;
  };
  contributions: {
    rrsp: Person;
    tfsa: Person;
    tfsaWithdrawals: Person;
    respContributions: number;
  };
  accounts: {
    rrsp: { [provider: string]: Person };
    totalRrsp: Person & { total: number };
    tfsa: { [provider: string]: Person };
    totalTfsa: Person & { total: number };
    privateInvesting: number;
    nonRegistered?: number;
    crypto?: number;
    resp: number;
    allAccounts?: {
      name: string;
      balance: number;
      currency: string;
      type: string;
      category: string;
      institution: string;
    }[];
    allLoans?: { name: string; balance: number; institution: string }[];
  };
  summary: {
    tdSavings: number;
    wealthsimple: number;
    shopifyRsu: number;
    total: number;
  };
  returns: {
    td: {
      startingBalance: number;
      currentBalance: number;
      returnAmount: number;
      returnPct: number;
    };
    wealthsimple: {
      teddyStart: number;
      nicoleStart: number;
      teddyCurrent: number;
      nicoleCurrent: number;
      totalStart: number;
      totalCurrent: number;
      returnAmount: number;
      returnPct: number;
    };
    total: { returnAmount: number; returnPct: number };
    goal: number;
    totalGoal: number;
    currentVsGoal: number;
    pctDifference: number;
  };
  debt: { [name: string]: number; totalDebt: number };
  subtotal: number;
  taxBrackets: {
    upTo: number;
    rate: number;
    tax: number;
    cumulative: number;
  }[];
}

export interface SalaryRow {
  year: number;
  teddyGross: number;
  teddyTax: number;
  nicoleGross: number;
  nicoleTax: number;
}

export interface SalaryTotals {
  teddyGross: number;
  teddyTax: number;
  teddyNet: number;
  nicoleGross: number;
  nicoleTax: number;
  nicoleNet: number;
  totalGross: number;
  totalTax: number;
  totalNet: number;
  totalSavings: number;
  savingsPct: number;
  savingsAfterTaxPct: number;
}

export interface SavingsVsSalaryRow {
  year: number;
  totalSavings: number;
  totalEarningsBeforeTax: number;
  totalEarningsAfterTax: number;
  avgTaxRate: number;
}

export interface PredictionRow {
  year: number;
  predictedSavings: number;
  actualSavings: number | null;
  savingsContribution: number | null;
  annualReturn: number | null;
  annualReturnPct: number | null;
  deltaFromGoal: number | null;
  teddyAge: number;
  nicoleAge: number;
}

export interface InvestmentData {
  years: { [year: string]: YearData };
  salaries: SalaryRow[];
  savingsVsSalaries: SavingsVsSalaryRow[];
  predictionModel: {
    roiGoal: number;
    annualSavings: number;
    years: PredictionRow[];
  };
  properties: { name: string; value: number }[];
  lastUpdated: string;
}

// ── Persistence ─────────────────────────────────────────────

export function loadInvestmentData(): InvestmentData | null {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveInvestmentData(data: InvestmentData): void {
  fs.mkdirSync(DB_DIR, { recursive: true });
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Partial updates (for form edits) ────────────────────────

export function updateYearField(
  year: string,
  path: string[],
  value: number,
): InvestmentData | null {
  const data = loadInvestmentData();
  if (!data || !data.years[year]) return null;

  // Navigate to the nested field and update
  let obj: Record<string, unknown> = data.years[year] as unknown as Record<
    string,
    unknown
  >;
  for (let i = 0; i < path.length - 1; i++) {
    obj = obj[path[i]] as Record<string, unknown>;
    if (!obj) return null;
  }
  obj[path[path.length - 1]] = value;

  saveInvestmentData(data);
  return data;
}
