---
name: investments-data
description: Read and analyze the personal investment tracking data from the read-only investments.json snapshot. Use when users ask about yearly investment totals, returns, contributions, salaries, debt, portfolio composition, or trends from the investment dashboard data.
---

# Investments Data — Read-only dashboard dataset

Use this skill to answer questions about the investment dashboard dataset stored in:

```bash
/workspace/extra/investments-data/investments.json
```

## Main-channel check

This data mount is only available in the main channel.

Run:

```bash
test -f /workspace/extra/investments-data/investments.json && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, reply:

> Investment dashboard data is available in the main chat only.

Then stop.

## Important constraints

- The file is **read-only** inside the container.
- Do **not** try to modify it.
- This file is the persisted dashboard dataset, not the whole live dashboard state.
- The current year shown in the dashboard may also incorporate live Lunch Money balances separately. If the user asks about the live current year and precision matters, say that the dashboard may merge this file with live account data.

## What the file contains

Top-level keys typically include:

- `years` — yearly investment/salary/contribution/returns/debt data keyed by year string
- `salaries` — yearly salary summary rows
- `savingsVsSalaries` — savings vs earnings comparison rows
- `predictionModel` — long-term savings/return projections
- `properties` — property valuation data

Within `years[YYYY]`, important sections include:

- `salary`
  - `teddy.gross`, `teddy.actualTax`, `teddy.actualTaxRate`
  - `nicole.gross`, `nicole.actualTax`, `nicole.actualTaxRate`
- `contributions`
  - `rrsp`, `tfsa`, `tfsaWithdrawals`, `respContributions`
- `accounts`
  - `rrsp`, `tfsa`, `totalRrsp`, `totalTfsa`, `privateInvesting`, `nonRegistered`, `crypto`, `resp`
- `summary`
  - `tdSavings`, `wealthsimple`, `shopifyRsu`, `total`
- `returns`
  - `td.startingBalance`, `td.currentBalance`, `td.returnAmount`, `td.returnPct`
  - `wealthsimple.totalStart`, `wealthsimple.totalCurrent`, `wealthsimple.returnAmount`, `wealthsimple.returnPct`
  - `total.returnAmount`, `total.returnPct`
  - `goal`, `totalGoal`, `currentVsGoal`, `pctDifference`
- `debt`
  - named debts plus `totalDebt`
- `subtotal`
  - net position for that year view

## Recommended workflow

### 1. Inspect available years

```bash
python3 - <<'PY'
import json
p='/workspace/extra/investments-data/investments.json'
with open(p) as f:
    data=json.load(f)
print(sorted(data.get('years', {}).keys()))
PY
```

### 2. Extract the relevant year or table

Example: summary for a specific year

```bash
python3 - <<'PY'
import json
p='/workspace/extra/investments-data/investments.json'
year='2026'
with open(p) as f:
    data=json.load(f)
print(json.dumps(data['years'][year], indent=2))
PY
```

Example: quick yearly totals

```bash
python3 - <<'PY'
import json
p='/workspace/extra/investments-data/investments.json'
with open(p) as f:
    data=json.load(f)
for y, row in sorted(data.get('years', {}).items()):
    print(y, row.get('summary', {}).get('total'), row.get('subtotal'))
PY
```

### 3. Summarize clearly

Prefer concise bullets like:

- 2026 total investments: ...
- 2026 total return: ... (...%)
- 2026 debt: ...
- 2026 net position: ...

## Common calculations

### Net income for a year

```text
salary.teddy.gross + salary.nicole.gross - salary.teddy.actualTax - salary.nicole.actualTax
```

### Net contributions for a year

```text
rrsp.teddy + rrsp.nicole + tfsa.teddy + tfsa.nicole + respContributions - tfsaWithdrawals.teddy - tfsaWithdrawals.nicole
```

### Total return already exists

Use:

```text
years[YYYY].returns.total.returnAmount
years[YYYY].returns.total.returnPct
```

### Net position already exists

Use:

```text
years[YYYY].subtotal
```

## Response guidance

- Be explicit about which year(s) you used.
- If comparing years, show both absolute numbers and percentages when helpful.
- If the user asks for “current” or “latest”, use the latest key in `years` unless they clearly mean live Lunch Money balances.
- If the data appears inconsistent with the live dashboard, mention that the live current year may be merged with fresh balances outside this file.
