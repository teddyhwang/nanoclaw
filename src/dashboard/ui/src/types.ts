// ── Finance types ────────────────────────────────────────────

export interface Account {
  id: number;
  name: string;
  display_name?: string;
  institution_name?: string;
  type: string;
  balance: string;
  currency: string;
  to_base?: number;
  is_income?: boolean;
  exclude_from_totals?: boolean;
}

export interface Category {
  id: number;
  name: string;
  is_income?: boolean;
  children?: Category[];
}

export interface Transaction {
  id: number;
  date: string;
  payee?: string;
  original_name?: string;
  amount: string;
  currency: string;
  category_id: number;
  is_income?: boolean;
  exclude_from_totals?: boolean;
}

export interface Property {
  name: string;
  value: number;
}

export interface DashboardUser {
  debits_as_negative?: boolean;
  primary_currency: string;
}

export interface CachedAt {
  balances?: string;
  transactions?: string;
}

export interface DashboardData {
  user: DashboardUser;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  properties: Property[];
  cachedAt: CachedAt;
}

// ── Filter state ────────────────────────────────────────────

export interface FilterState {
  day: string | null;
  weekStart: string | null;
  weekEnd: string | null;
  category: string | null;
  merchant: string | null;
  search: string;
  catId: string;
  dateRange: string;
}

export type SortState = {
  col: string;
  dir: 1 | -1;
};

// ── Investment types ────────────────────────────────────────

export interface PersonSplit {
  teddy: number;
  nicole: number;
}

export interface ProviderSplit {
  teddy?: number;
  nicole?: number;
}

export interface ReturnData {
  startingBalance: number;
  currentBalance: number;
  returnAmount: number;
  returnPct: number;
}

export interface WealthsimpleReturn {
  totalStart: number;
  totalCurrent: number;
  returnAmount: number;
  returnPct: number;
}

export interface TotalReturn {
  returnAmount: number;
  returnPct: number;
}

export interface LiveAccount {
  name: string;
  institution: string;
  balance: number;
  currency: string;
  type: string;
}

export interface LiveLoan {
  name: string;
  institution: string;
  balance: number;
}

export interface TaxBracket {
  upTo: number;
  rate: number;
  tax: number;
  cumulative: number;
}

export interface YearData {
  salary: {
    teddy: { gross: number; actualTax: number; actualTaxRate: number };
    nicole: { gross: number; actualTax: number; actualTaxRate: number };
  };
  contributions: {
    rrsp: PersonSplit;
    tfsa: PersonSplit;
    tfsaWithdrawals: PersonSplit;
    respContributions: number;
  };
  returns: {
    td: ReturnData;
    wealthsimple: WealthsimpleReturn;
    total: TotalReturn;
    goal?: number;
    currentVsGoal?: number;
    pctDifference?: number;
  };
  accounts: {
    rrsp: Record<string, ProviderSplit>;
    tfsa: Record<string, ProviderSplit>;
    totalRrsp?: { teddy: number; nicole: number; total: number };
    totalTfsa?: { teddy: number; nicole: number; total: number };
    nonRegistered?: number;
    crypto?: number;
    privateInvesting?: number;
    resp?: number;
    allAccounts?: LiveAccount[];
    allLoans?: LiveLoan[];
  };
  summary: {
    total: number;
    tdSavings?: number;
    wealthsimple?: number;
    shopifyRsu?: number;
  };
  debt: Record<string, number> & { totalDebt: number };
  subtotal: number;
  taxBrackets: TaxBracket[];
}

export interface PredictionYear {
  year: number;
  predictedSavings: number;
  actualSavings: number | null;
  annualReturnPct: number | null;
}

export interface SalaryRow {
  year: number;
  teddyGross: number;
  teddyTax: number;
  nicoleGross: number;
  nicoleTax: number;
}

export interface SavingsVsSalary {
  year: number;
  totalSavings: number;
}

export interface InvestmentData {
  years: Record<string, YearData>;
  predictionModel: { years: PredictionYear[] };
  salaries: SalaryRow[];
  savingsVsSalaries: SavingsVsSalary[];
  properties: Property[];
}
