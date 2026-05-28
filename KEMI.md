# Kemi — BizPulse Conversational Agent

Kemi is the AI brain behind BizPulse's WhatsApp experience. She replaces the old
static Gemini/Claude prompt pipeline with a full agentic loop that can reason, use
tools, and maintain memory across conversations.

---

## Architecture Overview

```
WhatsApp message
      │
      ▼
routes/webhook.js
  (onboarding, YES/NO confirmation, voice/image handling — unchanged)
      │
      ▼ (registered user, plain text)
src/agent/agentLoop.js  ──  runAgent(whatsappNumber, message)
      │
      ├── memory.js          load history + rolling context
      ├── systemPrompt.js    build system array (cached persona + dynamic context)
      │
      ▼
  ┌─────────────────────────────────────┐
  │         Claude Agentic Loop         │
  │  (claude-sonnet-4-6, max 8 iters)   │
  │                                     │
  │  call → tool_use? → dispatch → call │
  └─────────────────────────────────────┘
      │
      ├── toolHandlers.js    write tools (sequential) + read tools (parallel)
      ├── normaliser.js      fuzzy product name matching (zero npm deps)
      └── stockIntelligence.js  SQL-only stock intelligence queries
      │
      ▼
  final text reply → WhatsApp
      │
      └── memory.js          appendMessage + (if >40 rows) rolling summary
```

---

## Files

| File | Purpose |
|---|---|
| `src/agent/agentLoop.js` | Main entry point — `runAgent()`, dispatch, retry logic |
| `src/agent/memory.js` | Conversation history, rolling context, summary compression |
| `src/agent/systemPrompt.js` | Builds the Claude `system` array with ephemeral cache |
| `src/agent/tools.js` | 12 Claude tool definitions (the API schema) |
| `src/agent/toolHandlers.js` | Implementation of all 12 tools |
| `src/agent/normaliser.js` | Product name normalisation pipeline (zero npm deps) |
| `src/agent/stockIntelligence.js` | SQL-driven stock intelligence + digest data pack |
| `src/agent/digest.js` | Two-stage evening digest + 3 cron jobs |
| `migrations/002_kemi_agent.sql` | DB migration for all new Kemi tables and the MV |

---

## Tools

### Write tools (run sequentially — these touch the DB)
| Tool | What it does |
|---|---|
| `log_sale` | Record a sale, decrement stock, write to both `product_transactions` and `transactions` |
| `log_restock` | Record stock received, increment stock + `total_ever_received` |
| `correct_last_entry` | Void or amend the most recent transaction |
| `log_debt` | Record a credit sale as an outstanding debt |
| `settle_debt` | Mark a debt settled and record the payment as revenue |
| `set_goal` | Create or update a sales/revenue goal |

### Read tools (run in parallel — read-only)
| Tool | What it does |
|---|---|
| `get_stock_level` | Current stock for one product |
| `get_stock_intelligence` | Full stock health buckets from `stock_intelligence_mv` |
| `get_sales_summary` | Revenue and profit summary for a period |
| `search_products` | Find products by fuzzy name match |
| `get_debts` | List outstanding debts, optionally filtered by debtor name |
| `compare_periods` | Compare two date ranges side-by-side |

---

## Two-Stage Evening Digest

The 8pm WAT digest deliberately uses two separate Claude calls:

**Stage 1 — Data assembly** (`assembleDataPack`)
Pure SQL, no AI. Runs 4 queries in parallel via `Promise.all`:
- Today's sales from `product_transactions`
- Yesterday's sales for comparison
- Goals from `goals` table
- Stock intelligence from `stock_intelligence_mv`

Returns a structured JSON pack.

**Stage 2 — Narration** (`narrateDigest`)
Claude reads the JSON pack and writes a 4-7 line WhatsApp-ready summary.
No tools. `max_tokens: 300`. Language mirrors the trader's preference.

These are kept separate so the data layer can be unit-tested without AI,
and so a Claude outage does not prevent the data from being collected.

---

## Memory System

### Conversation history (`conversation_history` table)
- Last 20 turns loaded on every message
- Every turn persisted (user + assistant)
- Rows older than 7 days purged by 3am WAT cron

### Rolling context (`trader_facts` table)
- `language_preference` — detected from messages, updated over time
- `top_products` — JSON array of frequently mentioned product names
- `business_type` — inferred or from registration
- `rolling_summary` — compressed conversation summary (5 bullets)

### Rolling summary compression
Triggered when `conversation_history` row count > 40 for a user.
Claude is called with the last 40 messages and asked to produce 5 bullets.
After compression, history older than the most recent 20 rows is deleted.
This keeps the context window manageable indefinitely.

---

## Cron Jobs (all in `digest.js`)

| Schedule | Job |
|---|---|
| `0 20 * * *` WAT | Evening digest for all active traders |
| `0 3 * * *` WAT | Purge `conversation_history` rows older than 7 days |
| `*/15 * * * *` | `REFRESH MATERIALIZED VIEW CONCURRENTLY stock_intelligence_mv` |

---

## Product Normaliser

`src/agent/normaliser.js` runs a 6-step pipeline with zero npm dependencies:

1. Lowercase + trim
2. Strip filler words (28-word stop list: "of", "the", "a", "pack of", etc.)
3. Nigerian alias map (lappy→laptop, tomatoe→tomato, pomo→cow skin, etc.)
4. Suffix stripping — longest-first (ing, ed, er, es, s) with exception list
5. DB fuzzy match — Levenshtein distance ≤ 2 AND first letter matches
6. Title case output

The Levenshtein implementation uses a flat array instead of a 2D array for performance.

---

## Database Tables Added by Kemi

| Table | Purpose |
|---|---|
| `products` | Product catalogue (one row per product per trader) |
| `product_transactions` | Every stock movement (sale, restock, correction) |
| `conversation_history` | Kemi's message memory |
| `trader_facts` | Rolling context (language pref, top products, summary) |
| `debts` | Outstanding credit sales |
| `goals` | Sales/revenue targets |
| `stock_intelligence_mv` | Materialized view — pre-computed stock health metrics |

The `transactions` table (Phase 1) is still written to by `log_sale` for backward
compatibility with the existing 7pm email summary job.

---

## Backward Compatibility

The webhook change is surgical: only the `// ── Parse intent ──` through the
closing `}` of the switch statement was replaced. Everything else is untouched:

- Onboarding flow (`handleOnboarding`) — unchanged
- YES/NO/EDIT confirmation intercept — unchanged
- Voice note handling — unchanged
- Image processing — unchanged
- Dedup / idempotency check — unchanged
- `first_message_date` activation tracking — unchanged
- NPS response detection — unchanged

---

## Prompt Caching

Every Claude API call passes the system prompt as an array with two blocks:

```js
[
  { type: 'text', text: staticPersona, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: dynamicContext },   // no cache — changes per trader
]
```

The static persona (Kemi's personality, language rules, confirmation format) is
marked ephemeral so Anthropic caches it across calls. The dynamic block (trader
name, business type, top products, rolling summary) is never cached since it
changes per trader and per conversation.
