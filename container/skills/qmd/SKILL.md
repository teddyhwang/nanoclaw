---
name: qmd
description: Search markdown knowledge bases, notes, and documentation using QMD. Use when users ask to search notes, find documents, look up past conversations, or recall information from memory.
allowed-tools: Bash(qmd:*)
---

# QMD - Quick Markdown Search

Local search engine for your markdown memory, notes, and conversations.

## Quick Start

```bash
# Keyword search (fastest, exact terms)
qmd search "calendar security settings"

# Get a specific document
qmd get "qmd://nanoclaw-memory/global/CLAUDE.md"

# List all indexed files
qmd ls nanoclaw-memory
```

## Search Commands

### `qmd search` — BM25 keyword search (recommended first try)
```bash
qmd search "keywords here"
qmd search "exact phrase" -c nanoclaw-memory
qmd search "term1 term2 -exclude"
```

### `qmd query` — Hybrid search with auto-expansion (best recall)
```bash
qmd query "what are the security rules?"
```

### `qmd get` — Retrieve a specific document
```bash
qmd get "qmd://nanoclaw-memory/global/CLAUDE.md"
qmd get "#docid"
```

### `qmd multi-get` — Batch retrieve by glob
```bash
qmd multi-get "conversations/*.md"
```

## Search Tips

- Use `search` first for known terms (fast, no LLM needed)
- Use `query` when you don't know the exact words
- Use exact phrases in quotes: `"connection pool"`
- Exclude terms with minus: `performance -sports`
- 2-5 keywords work best for `search`

## Collections

The `nanoclaw-memory` collection indexes all markdown files in the groups folder, including conversation history and memory files.
