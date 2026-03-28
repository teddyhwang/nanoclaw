---
name: lunchmoney
description: Query and manage personal finances via the Lunch Money API. View transactions, account balances, spending by category, and budgets. Use when the user asks about their spending, transactions, finances, accounts, or budget.
allowed-tools: Bash(curl:*)
---

# Lunch Money — Personal Finance

Query and manage personal finances via the Lunch Money v2 API.

## ⚠️ CRITICAL: Discord Formatting Rules

**NEVER use markdown tables (pipe `|` syntax).** Discord does not render them — they appear as ugly raw text.

Instead, format data as **bullet lists**:
```
Here's last week's spending:

• 🍔 Restaurants — $100.15
• 🛒 Groceries — $53.99
• 🌐 Internet — $108.48
• 🏠 Home Goods — $15.67

**Total: $278.29 CAD**
```

Or for transaction lists, use a **simple line-per-item format**:
```
Mar 17 — Air Gsm — $49.50
Mar 17 — Goss By — $40.73
Mar 18 — Amazon — $15.67
Mar 20 — Bell Canada — $108.48

**Total: $214.38 CAD**
```

**NEVER output `| Column | Column |` or `|---|---|` syntax. It will look broken.**

## Authentication

Credentials are injected automatically by the OneCLI gateway proxy — **do not** set `Authorization` headers manually. Just call the API directly:

```bash
curl -s "https://api.lunchmoney.dev/v2/..."
```

## API Base URL

```
https://api.lunchmoney.dev/v2
```

## Required v2 Workflow

**Important:** paths like `/me`, `/transactions`, `/summary`, `/categories`, etc. in this skill refer to **Lunch Money API URL paths** under `https://api.lunchmoney.dev/v2`. They are **not agent slash commands**.

Example:
- `/me` means `GET https://api.lunchmoney.dev/v2/me`
- `/transactions` means `GET https://api.lunchmoney.dev/v2/transactions`
- `/summary` means `GET https://api.lunchmoney.dev/v2/summary`

Lunch Money v2 has a few important rules that you must follow:

1. **Fetch the Lunch Money API path `/me` first** when answering finance questions that depend on amount sign interpretation.
2. **Do not assume positive always means spending.** Check `debits_as_negative` from the `/me` API response.
3. **Transactions are dehydrated** in v2 — category/account/tag names are not included inline. Resolve IDs via the Lunch Money API paths `/categories`, `/plaid_accounts`, `/manual_accounts`, and `/tags` as needed.
4. **Prefer the Lunch Money API path `/summary` for rollups** (spending by category, budget summaries) when it fits the question.
5. **Use the Lunch Money API path `/transactions` for detailed line items** and custom filtering.

## Endpoints

### Get current user
```bash
curl -s "https://api.lunchmoney.dev/v2/me"
```

Important fields from `/me`:
- `primary_currency`
- `debits_as_negative`
- `budget_name`

### List transactions
```bash
curl -s "https://api.lunchmoney.dev/v2/transactions?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD"
```

Query parameters:
- `start_date` — required, format `YYYY-MM-DD`
- `end_date` — required, format `YYYY-MM-DD`
- `category_id` — filter by category ID
- `plaid_account_id` — filter by account ID
- `status` — `reviewed`, `unreviewed`, `pending`
- `offset` — for pagination

Response shape:
```json
{
  "transactions": [
    {
      "id": 123,
      "date": "2026-03-20",
      "amount": "24.2600",
      "currency": "cad",
      "to_base": 24.26,
      "payee": "Uber Eats",
      "original_name": "UBER EATS",
      "category_id": 2642589,
      "notes": null,
      "status": "unreviewed",
      "is_pending": false,
      "plaid_account_id": 377995,
      "tag_ids": [],
      "source": "plaid"
    }
  ],
  "has_more": false
}
```

**Important v2 notes:**
- Transaction responses are **dehydrated**. They include IDs like `category_id`, `tag_ids`, `plaid_account_id`, not human-friendly names.
- Resolve category/account/tag IDs before presenting results to the user.
- Amount sign depends on the user's `debits_as_negative` setting from `/me`.

### Get a single transaction
```bash
curl -s "https://api.lunchmoney.dev/v2/transactions/{id}"
```

### Update a transaction
```bash
curl -s -X PATCH "https://api.lunchmoney.dev/v2/transactions/{id}" \
  -H "Content-Type: application/json" \
  -d '{"payee": "New Name", "category_id": 123, "notes": "some note", "status": "reviewed"}'
```

Updatable fields: `payee`, `category_id`, `notes`, `status`, `date`, `amount`, `currency`, `tag_ids`.

### List categories
```bash
curl -s "https://api.lunchmoney.dev/v2/categories"
```

Response includes nested `children` for category groups. Key fields: `id`, `name`, `is_group`, `group_id`, `is_income`.

### List tags
```bash
curl -s "https://api.lunchmoney.dev/v2/tags"
```

### List linked accounts (Plaid)
```bash
curl -s "https://api.lunchmoney.dev/v2/plaid_accounts"
```

Key fields: `id`, `display_name`, `type` (depository/credit/investment/loan/cash), `balance`, `currency`, `status`, `institution_name`.

### List manual accounts
```bash
curl -s "https://api.lunchmoney.dev/v2/manual_accounts"
```

### Trigger a Plaid sync
```bash
curl -s -X POST "https://api.lunchmoney.dev/v2/plaid_accounts/fetch"
```

### Get summary / rollup
```bash
curl -s "https://api.lunchmoney.dev/v2/summary?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD"
```

Use the Lunch Money API path `/summary` when the user asks for:
- spending by category
- monthly/weekly rollups
- budget-style summaries
- high-level totals

Use the Lunch Money API path `/transactions` when the user asks for:
- specific purchases
- transaction lists
- merchant searches
- detailed drill-downs

## Common Patterns

### Spending summary for a date range
Preferred approach:
1. Fetch `/me` to understand amount sign semantics
2. Try `/summary` first for category rollups
3. If needed, fetch `/categories` to map category IDs to names
4. Present a concise user-friendly summary

Fallback approach when `/summary` is not enough:
1. Fetch transactions for the date range
2. Fetch categories to map `category_id` → name
3. Group and sum by category
4. Present as a summary

### Account balances
1. Fetch `/me`
2. Fetch `plaid_accounts`
3. Optionally fetch `manual_accounts`
4. Filter by `status: "active"`
5. Present balances grouped by type (banking, credit, investments, loans)

### Recent unreviewed transactions
```bash
curl -s "https://api.lunchmoney.dev/v2/transactions?start_date=$(date -d '30 days ago' +%Y-%m-%d)&end_date=$(date +%Y-%m-%d)&status=unreviewed"
```

## Formatting Reminders

- Always format currency amounts with 2 decimal places (e.g. `$24.26 CAD`)
- Respect the user's `debits_as_negative` setting from `/me` when interpreting amounts
- Resolve IDs to names before presenting results whenever possible
- Group by category when summarizing spending
- Show totals at the bottom of summaries
- For account balances, separate by type (banking, credit, investments, loans)
- Keep responses concise — Discord messages have a 2000 character limit
- **Reminder: NO markdown tables. Use bullet lists or line-per-item format (see top of this skill).**

## Write Operations — Confirmation Required

The following actions modify data and **require explicit user confirmation** before executing:

- Updating transaction payee, category, notes, or status
- Any POST/PATCH/PUT/DELETE request

Always describe the change and ask for confirmation before making write requests.
