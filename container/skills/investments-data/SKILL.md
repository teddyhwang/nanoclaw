---
name: investments-data
description: Query personal investment tracking data via the dashboard API. Use when users ask about yearly investment totals, returns, contributions, salaries, debt, portfolio composition, or trends.
allowed-tools: Bash(curl:*), Bash(python3:*)
---

# Investments Data — Dashboard API

Query investment and salary data via the dashboard API running on the host. The API returns the stored dataset merged with live Lunch Money account balances for the current year.

## API Base URL

```
http://host.docker.internal:3002
```

## ⚠️ CRITICAL: Discord Formatting Rules

**NEVER use markdown tables (pipe `|` syntax).** Discord does not render them — they appear as ugly raw text.

Use **bullet lists** or **line-per-item** format instead.

## Endpoint

```
GET /api/investments
```

### Quick test

```bash
curl -s "http://host.docker.internal:3002/api/investments" | python3 -c "import sys,json; d=json.load(sys.stdin); print(list(d.keys()))"
```

## Response Shape

Top-level keys:

- `years` — yearly investment/salary/contribution/returns/debt data keyed by year string
- `salaries` — yearly salary summary rows
- `savingsVsSalaries` — savings vs earnings comparison rows
- `predictionModel` — long-term savings/return projections
- `properties` — property valuation data

## Year Data Structure

Within `years[YYYY]`:

- **`salary`** — `teddy.gross`, `teddy.actualTax`, `teddy.actualTaxRate`, `nicole.gross`, `nicole.actualTax`, `nicole.actualTaxRate`
- **`contributions`** — `rrsp`, `tfsa`, `tfsaWithdrawals`, `respContributions`
- **`accounts`** — `rrsp`, `tfsa`, `totalRrsp`, `totalTfsa`, `privateInvesting`, `nonRegistered`, `crypto`, `resp`
- **`summary`** — `tdSavings`, `wealthsimple`, `shopifyRsu`, `total`
- **`returns`** — `td.startingBalance`, `td.currentBalance`, `td.returnAmount`, `td.returnPct`, `wealthsimple.*`, `total.returnAmount`, `total.returnPct`, `goal`, `totalGoal`, `currentVsGoal`, `pctDifference`
- **`debt`** — named debts plus `totalDebt`
- **`subtotal`** — net position for that year

## Common Queries

### List available years

```bash
curl -s "http://host.docker.internal:3002/api/investments" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(sorted(data.get('years', {}).keys()))
"
```

### Summary for a specific year

```bash
curl -s "http://host.docker.internal:3002/api/investments" | python3 -c "
import sys, json
data = json.load(sys.stdin)
year = data['years'].get('2026', {})
print(json.dumps(year, indent=2))
"
```

### Yearly totals overview

```bash
curl -s "http://host.docker.internal:3002/api/investments" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for y, row in sorted(data.get('years', {}).items()):
    total = row.get('summary', {}).get('total', 'N/A')
    subtotal = row.get('subtotal', 'N/A')
    print(f'{y}: total={total}, net={subtotal}')
"
```

### Returns comparison across years

```bash
curl -s "http://host.docker.internal:3002/api/investments" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for y, row in sorted(data.get('years', {}).items()):
    r = row.get('returns', {}).get('total', {})
    amt = r.get('returnAmount', 'N/A')
    pct = r.get('returnPct', 'N/A')
    print(f'{y}: return={amt} ({pct}%)')
"
```

## Common Calculations

### Net income for a year

```
salary.teddy.gross + salary.nicole.gross - salary.teddy.actualTax - salary.nicole.actualTax
```

### Net contributions for a year

```
rrsp.teddy + rrsp.nicole + tfsa.teddy + tfsa.nicole + respContributions - tfsaWithdrawals.teddy - tfsaWithdrawals.nicole
```

### Total return and net position already exist

```
years[YYYY].returns.total.returnAmount / returnPct
years[YYYY].subtotal
```

## Response Guidance

- Be explicit about which year(s) you used
- If comparing years, show both absolute numbers and percentages
- If the user asks for "current" or "latest", use the latest key in `years`
- The current year's data is merged with **live** Lunch Money account balances, so it reflects real-time positions
- Format currency with 2 decimal places and commas (e.g. `$124,500.00`)
- Keep responses concise — Discord messages have a 2000 character limit
- **Reminder: NO markdown tables. Use bullet lists or line-per-item format.**
