---
name: investments-data
description: Query personal investment tracking data via the dashboard API. Use when users ask about yearly investment totals, returns, contributions, salaries, debt, portfolio composition, or trends.
allowed-tools: Bash(curl:*)
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

## Response Shape

Top-level keys:

- `years` — yearly data keyed by year string (e.g. `"2026"`)
- `salaries` — yearly salary summary rows
- `savingsVsSalaries` — savings vs earnings comparison rows
- `predictionModel` — long-term savings/return projections
- `properties` — property valuation data
- `lastUpdated` — ISO timestamp of last data update

## Year Data Structure

Within `years[YYYY]`:

- **`salary`** — `teddy.gross`, `teddy.actualTax`, `teddy.actualTaxRate`, `nicole.gross`, `nicole.actualTax`, `nicole.actualTaxRate`
- **`contributions`** — `rrsp`, `tfsa`, `tfsaWithdrawals`, `respContributions`
- **`accounts`** — `rrsp`, `tfsa`, `totalRrsp`, `totalTfsa`, `privateInvesting`, `nonRegistered`, `crypto`, `resp`
- **`summary`** — `tdSavings`, `wealthsimple`, `shopifyRsu`, `total`
- **`returns`** — `td.startingBalance`, `td.currentBalance`, `td.returnAmount`, `td.returnPct`, `wealthsimple.*`, `total.returnAmount`, `total.returnPct`, `goal`, `totalGoal`, `currentVsGoal`, `pctDifference`
- **`debt`** — named debts plus `totalDebt`
- **`subtotal`** — net position for that year

## Examples

```bash
# Full investment data (includes live current-year balances)
curl -s "http://host.docker.internal:3002/api/investments"
```

Parse the JSON response with `node -e` or pipe through shell tools as needed.

## Common Calculations

- **Net income:** `salary.teddy.gross + salary.nicole.gross - salary.teddy.actualTax - salary.nicole.actualTax`
- **Total return:** `years[YYYY].returns.total.returnAmount` / `.returnPct`
- **Net position:** `years[YYYY].subtotal`

## Response Guidance

- Be explicit about which year(s) you used
- If comparing years, show both absolute numbers and percentages
- If the user asks for "current" or "latest", use the latest key in `years`
- The current year's data is merged with **live** Lunch Money account balances
- Format currency with 2 decimal places and commas (e.g. `$124,500.00`)
- Keep responses concise — Discord messages have a 2000 character limit
- **Reminder: NO markdown tables. Use bullet lists or line-per-item format.**
