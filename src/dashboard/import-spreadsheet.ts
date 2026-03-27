/**
 * Import investment data from Google Sheets spreadsheet.
 * Run: npx tsx src/dashboard/import-spreadsheet.ts
 */
import { execSync } from 'child_process';
import {
  saveInvestmentData,
  InvestmentData,
  YearData,
  SavingsVsSalaryRow,
  PredictionRow,
  SalaryRow,
} from './investments.js';

const SPREADSHEET_ID = '1D7K_45TGvqBhl3gL94P3lGbAhimxaKZGHsS1Y9SK8xA';

function gws(range: string): string[][] {
  const cmd = `gws sheets spreadsheets values get --params '${JSON.stringify({ spreadsheetId: SPREADSHEET_ID, range })}'`;
  const result = execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
  const data = JSON.parse(result);
  return data.values || [];
}

function parseNum(s: string | undefined): number {
  if (!s) return 0;
  return (
    parseFloat(
      s.replace(/[$,%]/g, '').replace(/\(/g, '-').replace(/\)/g, ''),
    ) || 0
  );
}

function cell(rows: string[][], r: number, c: number): string {
  return rows[r]?.[c] || '';
}

function num(rows: string[][], r: number, c: number): number {
  return parseNum(cell(rows, r, c));
}

// ── Parse a year tab ────────────────────────────────────────

function parseYearTab(year: number): YearData | null {
  try {
    const rows = gws(`${year}!A1:AA35`);
    if (rows.length < 10) return null;

    // Salary section (0-indexed: row 0=link, row 1=header, row 2=Teddy label, row 3=After RRSP, row 4=Actual)
    const teddyAfterRrspRate = num(rows, 3, 2);
    const teddyAfterRrspSalary = num(rows, 3, 3);
    const teddyAfterRrspTax = num(rows, 3, 4);
    const teddyActualRate = num(rows, 4, 2);
    const teddyActualSalary = num(rows, 4, 3);
    const teddyActualTax = num(rows, 4, 4);

    const nicoleAfterRrspRate = num(rows, 6, 2);
    const nicoleAfterRrspSalary = num(rows, 6, 3);
    const nicoleAfterRrspTax = num(rows, 6, 4);
    const nicoleActualRate = num(rows, 7, 2);
    const nicoleActualSalary = num(rows, 7, 3);
    const nicoleActualTax = num(rows, 7, 4);

    const totalGross = num(rows, 8, 3);
    const totalTax = num(rows, 8, 4);
    const totalNet = num(rows, 9, 3);

    // Contributions (column G-J: row 2=RRSP, row 3=Tax Refund, row 4=RRSP Cost, row 5=TFSA)
    const rrspContrib: { teddy: number; nicole: number } = {
      teddy: num(rows, 2, 7),
      nicole: num(rows, 2, 8),
    };
    const taxRefund: { teddy: number; nicole: number } = {
      teddy: num(rows, 3, 7),
      nicole: num(rows, 3, 8),
    };
    const rrspCost: { teddy: number; nicole: number } = {
      teddy: num(rows, 4, 7),
      nicole: num(rows, 4, 8),
    };
    const tfsaContrib: { teddy: number; nicole: number } = {
      teddy: num(rows, 5, 7),
      nicole: num(rows, 5, 8),
    };

    // RRSP accounts - find rows between "RRSP" header and "TOTAL RRSP"
    const rrspAccounts: {
      [provider: string]: { teddy: number; nicole: number };
    } = {};
    const tfsaAccounts: {
      [provider: string]: { teddy: number; nicole: number };
    } = {};
    let totalRrsp = { teddy: 0, nicole: 0, total: 0 };
    let totalTfsa = { teddy: 0, nicole: 0, total: 0 };
    let tfsaWithdrawals = { teddy: 0, nicole: 0 };
    let privateInvesting = 0,
      resp = 0,
      respContributions = 0;
    let totalSavings = 0;

    // Scan rows for known labels in column G (index 6)
    let inRrsp = false,
      inTfsa = false;
    for (let r = 6; r < Math.min(rows.length, 25); r++) {
      const label = cell(rows, r, 6).trim();
      if (!label) continue;

      if (label === 'RRSP') {
        inRrsp = true;
        inTfsa = false;
        continue;
      }
      if (label === 'TFSA') {
        inRrsp = false;
        inTfsa = true;
        continue;
      }

      if (label.startsWith('TOTAL RRSP')) {
        totalRrsp = {
          teddy: num(rows, r, 7),
          nicole: num(rows, r, 8),
          total: num(rows, r, 9),
        };
        inRrsp = false;
        continue;
      }
      if (label.startsWith('TOTAL TFSA')) {
        totalTfsa = {
          teddy: num(rows, r, 7),
          nicole: num(rows, r, 8),
          total: num(rows, r, 9),
        };
        inTfsa = false;
        continue;
      }
      if (label === 'Withdrawls' || label === 'Withdrawals') {
        tfsaWithdrawals = { teddy: num(rows, r, 7), nicole: num(rows, r, 8) };
        continue;
      }
      if (label.includes('Private')) {
        privateInvesting = num(rows, r, 9);
        continue;
      }
      if (label === 'RESP' && !label.includes('Contrib')) {
        resp = num(rows, r, 9);
        continue;
      }
      if (label.includes('RESP Contrib')) {
        respContributions = num(rows, r, 9);
        continue;
      }
      if (label === 'TOTAL SAVINGS') {
        totalSavings = num(rows, r, 9);
        continue;
      }

      if (inRrsp) {
        rrspAccounts[label] = {
          teddy: num(rows, r, 7),
          nicole: num(rows, r, 8),
        };
      }
      if (
        inTfsa &&
        !label.startsWith('TOTAL') &&
        label !== 'Withdrawls' &&
        label !== 'Withdrawals'
      ) {
        tfsaAccounts[label] = {
          teddy: num(rows, r, 7),
          nicole: num(rows, r, 8),
        };
      }
    }

    // Investment Summary (column L-M, starting row 1)
    let tdSavings = 0,
      wealthsimple = 0,
      shopifyRsu = 0,
      summaryTotal = 0;
    let tdStart = 0,
      tdCurrent = 0,
      tdReturn = 0,
      tdReturnPct = 0;
    let wsData = {
      teddyStart: 0,
      nicoleStart: 0,
      teddyCurrent: 0,
      nicoleCurrent: 0,
      totalStart: 0,
      totalCurrent: 0,
      returnAmount: 0,
      returnPct: 0,
    };
    let totalReturn = 0,
      totalReturnPct = 0;
    let goal = 0,
      totalGoal = 0,
      currentVsGoal = 0,
      pctDifference = 0;

    for (let r = 1; r < Math.min(rows.length, 30); r++) {
      const label = cell(rows, r, 11).trim();
      const val = num(rows, r, 12);
      if (!label) continue;

      if (
        label.includes('TD Savings') ||
        label.includes('TD Direct') ||
        label === 'Total Savings'
      )
        tdSavings = val;
      if (label === 'Wealthsimple') wealthsimple = val;
      if (label.includes('Shopify')) shopifyRsu = val;
      if (label === 'TOTAL') summaryTotal = val;
      if (label === 'Starting Balance') tdStart = val;
      if (label === 'Current Balance') tdCurrent = val;
      if (label === 'Return (in year)' && tdReturn === 0) tdReturn = val;
      if (label === '% Return (in year)' && tdReturnPct === 0)
        tdReturnPct = val;

      // Wealthsimple returns section
      if (label === 'Teddy Starting Balance') wsData.teddyStart = val;
      if (label === 'Nicole Starting Balance') wsData.nicoleStart = val;
      if (label === 'Teddy Current Balance') wsData.teddyCurrent = val;
      if (label === 'Nicole Current Balance') wsData.nicoleCurrent = val;
      if (label === 'Total Starting Balance') wsData.totalStart = val;
      if (label === 'Total Current Balance') wsData.totalCurrent = val;

      if (label.includes('Goal (')) goal = val;
      if (label.includes('Total Goal')) totalGoal = val;
      if (label.includes('Current - Goal')) currentVsGoal = val;
      if (label.includes('% Difference')) pctDifference = val;
    }

    // Check for Total Returns section
    for (let r = 20; r < Math.min(rows.length, 30); r++) {
      const label = cell(rows, r, 11).trim();
      const val = num(rows, r, 12);
      if (label === 'Return (in year)' && r > 22) totalReturn = val;
      if (label === '% Return (in year)' && r > 22) totalReturnPct = val;
    }
    // Second pass for ws returns
    let seenWsReturns = false;
    for (let r = 10; r < Math.min(rows.length, 30); r++) {
      const label = cell(rows, r, 11).trim();
      const val = num(rows, r, 12);
      if (label.includes('Wealthsimple Returns') || label.includes('Returns'))
        seenWsReturns = true;
      if (seenWsReturns && label === 'Return (in year)') {
        wsData.returnAmount = val;
        seenWsReturns = false;
      }
      if (
        label === '% Return (in year)' &&
        wsData.returnAmount !== 0 &&
        wsData.returnPct === 0
      )
        wsData.returnPct = val;
    }

    // Debt
    const debt: { [name: string]: number; totalDebt: number } = {
      totalDebt: 0,
    };
    let subtotal = 0;
    for (let r = 18; r < Math.min(rows.length, 35); r++) {
      const label = cell(rows, r, 6).trim();
      const val = num(rows, r, 9);
      if (label.includes('Mortgage') || label.includes('HELOC'))
        debt[label] = val;
      if (label === 'TOTAL DEBT') debt.totalDebt = val;
      if (label === 'SUBTOTAL') subtotal = val;
    }

    // Tax brackets
    const taxBrackets: YearData['taxBrackets'] = [];
    for (let r = 12; r < Math.min(rows.length, 25); r++) {
      const bracket = cell(rows, r, 1).trim();
      const rate = cell(rows, r, 2).trim();
      const tax = cell(rows, r, 3).trim();
      const cum = cell(rows, r, 4).trim();
      if (!bracket || !rate.includes('%')) break;
      taxBrackets.push({
        upTo: parseNum(bracket),
        rate: parseNum(rate),
        tax: parseNum(tax),
        cumulative: parseNum(cum),
      });
    }

    if (!summaryTotal && totalSavings) summaryTotal = totalSavings;

    return {
      year,
      salary: {
        teddy: {
          gross: teddyActualSalary,
          rrspDeduction: rrspContrib.teddy,
          actualTaxRate: teddyActualRate,
          actualTax: teddyActualTax,
        },
        nicole: {
          gross: nicoleActualSalary,
          rrspDeduction: rrspContrib.nicole,
          actualTaxRate: nicoleActualRate,
          actualTax: nicoleActualTax,
        },
      },
      contributions: {
        rrsp: rrspContrib,
        tfsa: tfsaContrib,
        tfsaWithdrawals,
        respContributions,
      },
      accounts: {
        rrsp: rrspAccounts,
        totalRrsp,
        tfsa: tfsaAccounts,
        totalTfsa,
        privateInvesting,
        resp,
      },
      summary: { tdSavings, wealthsimple, shopifyRsu, total: summaryTotal },
      returns: {
        td: {
          startingBalance: tdStart,
          currentBalance: tdCurrent,
          returnAmount: tdReturn,
          returnPct: tdReturnPct,
        },
        wealthsimple: wsData,
        total: {
          returnAmount: totalReturn || tdReturn + wsData.returnAmount,
          returnPct: totalReturnPct,
        },
        goal,
        totalGoal,
        currentVsGoal,
        pctDifference,
      },
      debt,
      subtotal,
      taxBrackets,
    };
  } catch (err) {
    console.error(`Failed to parse year ${year}:`, err);
    return null;
  }
}

// ── Parse summary tabs ──────────────────────────────────────

function parseSalaries(): SalaryRow[] {
  const rows = gws('Salaries!A1:N30');
  return rows
    .slice(1)
    .filter((r) => r[1] && /^\d{4}$/.test(r[1].trim()))
    .map((r) => ({
      year: parseInt(r[1]),
      teddyGross: parseNum(r[2]),
      teddyTax: parseNum(r[3]),
      nicoleGross: parseNum(r[5]),
      nicoleTax: parseNum(r[6]),
    }));
}

function parseSavingsVsSalaries(): SavingsVsSalaryRow[] {
  const rows = gws('Salaries vs Savings!A1:F20');
  return rows
    .slice(1)
    .filter((r) => r[1] && /^\d{4}$/.test(r[1].trim()))
    .map((r) => ({
      year: parseInt(r[1]),
      totalSavings: parseNum(r[2]),
      totalEarningsBeforeTax: parseNum(r[3]),
      totalEarningsAfterTax: parseNum(r[4]),
      avgTaxRate: parseNum(r[5]),
    }));
}

function parsePredictionModel(): {
  roiGoal: number;
  annualSavings: number;
  years: PredictionRow[];
} {
  const rows = gws('Prediction Model!A1:AC25');
  const roiGoal = parseNum(rows[0]?.[11] || '10');
  const annualSavings = parseNum(rows[0]?.[12] || '50000');
  const years = rows
    .slice(1)
    .filter((r) => r[1] && /^\d{4}$/.test(r[1].trim()))
    .map((r) => ({
      year: parseInt(r[1]),
      predictedSavings: parseNum(r[2]),
      actualSavings: r[3] ? parseNum(r[3]) : null,
      savingsContribution: r[4] ? parseNum(r[4]) : null,
      annualReturn: r[5] ? parseNum(r[5]) : null,
      annualReturnPct: r[6] ? parseNum(r[6]) : null,
      deltaFromGoal: r[7] ? parseNum(r[7]) : null,
      teddyAge: parseInt(r[8] || '0'),
      nicoleAge: parseInt(r[9] || '0'),
    }));
  return { roiGoal, annualSavings, years };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('📊 Importing investment data from Google Sheets...\n');

  const data: InvestmentData = {
    years: {},
    salaries: [],
    savingsVsSalaries: [],
    predictionModel: { roiGoal: 10, annualSavings: 50000, years: [] },
    lastUpdated: new Date().toISOString(),
  };

  // Import year tabs
  const yearTabs = [
    2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
  ];
  for (const year of yearTabs) {
    process.stdout.write(`  ${year}... `);
    const yearData = parseYearTab(year);
    if (yearData) {
      data.years[String(year)] = yearData;
      console.log(`✓ (total: ${yearData.summary.total.toLocaleString()})`);
    } else {
      console.log('✗ failed');
    }
  }

  // Import summary tabs
  process.stdout.write('  Salaries... ');
  data.salaries = parseSalaries();
  console.log(`✓ (${data.salaries.length} rows)`);

  process.stdout.write('  Salaries vs Savings... ');
  data.savingsVsSalaries = parseSavingsVsSalaries();
  console.log(`✓ (${data.savingsVsSalaries.length} rows)`);

  process.stdout.write('  Prediction Model... ');
  data.predictionModel = parsePredictionModel();
  console.log(`✓ (${data.predictionModel.years.length} rows)`);

  saveInvestmentData(data);
  console.log(`\n✅ Saved to db/investments.json`);
}

main().catch(console.error);
