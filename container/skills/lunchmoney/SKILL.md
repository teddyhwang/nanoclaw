---
name: lunchmoney
description: Query personal finances via the dashboard API. View transactions, account balances, spending by category, and search by payee. Use when the user asks about their spending, transactions, finances, accounts, or budget.
allowed-tools: Bash(curl:*)
---

# Lunch Money — Personal Finance

Query personal finance data via the dashboard API running on the host.

## API Base URL

```
http://host.docker.internal:3002
```

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

## Endpoints

### Get user info, categories, and tags

```
GET /api/finance/meta
```

Returns:
```json
{
  "user": {
    "primary_currency": "cad",
    "debits_as_negative": false
  },
  "categories": [
    { "id": 123, "name": "Restaurants", "is_income": false, "is_group": false, "group_id": null }
  ],
  "tags": [
    { "id": 1, "name": "tag-name" }
  ]
}
```

**Fetch meta first** when answering finance questions to understand `debits_as_negative` and resolve category/tag IDs.

### List transactions (filtered)

```
GET /api/finance/transactions?start=YYYY-MM-DD&end=YYYY-MM-DD
```

Query parameters (all optional):
- `start` — start date (inclusive)
- `end` — end date (inclusive)
- `category` — category name substring match (e.g. `restaurant`, `groceries`)
- `status` — `reviewed`, `unreviewed`, `pending`
- `payee` — payee/merchant name substring match
- `account_id` — filter by account ID
- `limit` — max results (default: all)

Transactions are returned **newest first**, already **hydrated** with `category_name` and `account_name`.

Response:
```json
{
  "transactions": [{
    "id": 123,
    "date": "2026-03-20",
    "amount": "24.2600",
    "currency": "cad",
    "to_base": 24.26,
    "payee": "Uber Eats",
    "original_name": "UBER EATS",
    "category_id": 2642589,
    "category_name": "Restaurants",
    "account_name": "TD Visa",
    "notes": null,
    "status": "unreviewed",
    "is_pending": false,
    "plaid_account_id": 377995,
    "tag_ids": [],
    "source": "plaid",
    "is_income": false,
    "exclude_from_totals": false
  }],
  "count": 42,
  "totalCount": 4932,
  "dateRange": { "start": "2020-01-01", "end": "2026-03-28" }
}
```

### Get account balances

```
GET /api/finance/accounts
```

Returns active accounts with current balances:
```json
{
  "accounts": [{
    "id": 123,
    "display_name": "TD Visa",
    "type": "credit",
    "balance": "1234.56",
    "currency": "cad",
    "to_base": 1234.56,
    "institution_name": "TD Canada Trust",
    "status": "active",
    "source": "plaid"
  }]
}
```

Account types: `depository`, `credit`, `investment`, `loan`, `cash`

### Get spending summary by category

```
GET /api/finance/summary?start=YYYY-MM-DD&end=YYYY-MM-DD
```

Both `start` and `end` are required.

Returns spending rollup by category — use this for "how much did I spend on X" or monthly summaries.

## Common Patterns

### Spending summary for a date range

1. Fetch `/api/finance/meta` to understand amount sign semantics
2. Fetch `/api/finance/summary?start=...&end=...` for category rollups
3. Present a concise user-friendly summary

### Transaction search

```bash
# Recent restaurant transactions
curl -s "http://host.docker.internal:3002/api/finance/transactions?start=2026-03-01&end=2026-03-28&category=restaurant"

# Amazon purchases this month
curl -s "http://host.docker.internal:3002/api/finance/transactions?start=2026-03-01&end=2026-03-28&payee=amazon"

# Unreviewed transactions
curl -s "http://host.docker.internal:3002/api/finance/transactions?status=unreviewed&limit=20"

# Last 10 transactions
curl -s "http://host.docker.internal:3002/api/finance/transactions?limit=10"
```

### Account balances

```bash
curl -s "http://host.docker.internal:3002/api/finance/accounts"
```

Parse the JSON response with `node -e` or pipe through shell tools as needed.

## Formatting Reminders

- Always format currency amounts with 2 decimal places (e.g. `$24.26 CAD`)
- Respect the user's `debits_as_negative` setting from `/api/finance/meta` when interpreting amounts
- Transactions come pre-hydrated with `category_name` and `account_name` — no need to resolve IDs
- Group by category when summarizing spending
- Show totals at the bottom of summaries
- For account balances, separate by type (banking, credit, investments, loans)
- Keep responses concise — Discord messages have a 2000 character limit
- **Reminder: NO markdown tables. Use bullet lists or line-per-item format (see top of this skill).**

## Read-Only

This skill is **read-only**. Do not attempt to update transactions, trigger syncs, or modify any data. If the user asks to recategorize or edit a transaction, tell them to do it in the Lunch Money app directly.
