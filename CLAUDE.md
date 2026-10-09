# BizPulse — AI Agent Context File
# Read this completely before writing any code, making any decision, or suggesting any feature.
# This file is the single source of truth for everything about BizPulse.

---

## WHAT BIZPULSE IS

BizPulse is a WhatsApp-native financial operating system for Nigerian SMEs.

It allows Nigerian small business owners to track their daily revenue and expenses
by sending a single WhatsApp message in natural language — and receive an AI-powered
business summary every evening automatically.

**The one sentence pitch:**
"Your accountant, stock manager, and loan officer — all in one WhatsApp chat."

**The positioning:**
BizPulse is not a tracking app. It is the financial operating system for the 39.6 million
Nigerian SMEs that have never had access to real financial intelligence.

**What makes it different from every competitor:**
- WhatsApp-native data entry — no app to download, no form to fill
- Works in natural Nigerian language including Pidgin and "k" for thousands
- Daily AI-powered push summary — users do not have to come looking for insight
- A conversational AI agent (Kemi) that traders can ask questions and correct entries with, not just a one-shot parser
- Simple enough for a market trader who currently uses a notebook
- Powerful enough to eventually replace an accountant

---

## THE FOUNDER

**Name:** Tosin Ilesanmi
**Background:** Data professional, analytics core domain, developing data engineering skills
**Company:** The Tosin Ilesanmi Data Academy (CAC registered)
**Product:** BizPulse
**Location:** Nigeria
**Stage:** Phase 1 build — first real users being onboarded, market-fit feature expansion underway

---

## TARGET USER — READ THIS CAREFULLY

Before making any product decision ask yourself:
**"Would a market trader in Oshodi understand this at 8pm after a long day?"**

If the answer is no — simplify it.

**Primary user profile:**
- Nigerian small business owner
- Currently records nothing OR uses a paper notebook
- Not confident in their own numbers
- Makes business decisions by experience or guesswork
- Uses WhatsApp constantly — it is their primary digital tool
- Opens the app on a phone, not a laptop
- Tired at the end of the day — wants information, not interaction
- Does not know accounting terminology
- May write in Pidgin, informal English, or mix languages

**Business types from feasibility study (66 responses):**
Services (22), Fashion (13), Retail (9), Online Business (6),
Food/Restaurant (4), Manufacturing, Agricultural Business, Bakery,
Production of Nigerian snacks, Gifts/souvenirs, School, E-commerce,
FMCG, Advertising, Furnishings and supplies, Hairline business,
WhatsApp Business sellers

**What they are struggling with (ranked):**
1. Understanding product performance — 27%
2. Calculating profit — 21%
3. Tracking expenses — 20%
4. Managing inventory — 15%
5. Tracking daily sales — 9%

---

## FEASIBILITY STUDY FINDINGS — 66 RESPONSES

These are real data points from real Nigerian SME owners. Every product decision
must be grounded in this data.

**How they record business numbers:**
- Notebook / Paper: 47%
- Record nothing at all: 29%
- Excel or Google Sheets: 17%
- POS system or business app: 5%
- WhatsApp group / phone notes: 3%

**Confidence in their own numbers:**
- Not confident: 35%
- Somewhat confident: 42%
- Confident: 20%
- Very confident: 3%
- Not/somewhat confident combined: 77%

**How they make business decisions:**
- Market trends / customer demand: 39%
- Based on experience and instinct: 38%
- Mostly guesswork: 12%
- By checking their records: 8%
- Using reports or dashboards: 3%

**KEY INSIGHT:** Only 8% check their records to make decisions.
This means the daily PUSH summary is the most important feature in the entire product.
Users will not come to look at their data. BizPulse must deliver insight to them.

**What they track:**
- Sales: 64%
- Expenses: 52%
- Customers: 39%
- Profit: 36%
- Inventory: 29%
- Loss: 18%

**Non-financial challenges that appeared:**
- Sourcing fund (Bakery) — points to future loan-ready statements feature
- Getting clients (Services) — outside BizPulse scope for now
- Having customers (Hairline business) — outside BizPulse scope for now
- Documentation consistency (Services) — BizPulse directly solves this

---

## NIGERIAN LANGUAGE AND CONTEXT

**Message parsing must handle:**
- "k" means thousands: "30k" = 30,000, "1.5m" = 1,500,000
- Informal: "made 30k today, gave Emeka 5k and spent 8k on stock"
- Pidgin: "I sell am for 5k" = sold for ₦5,000
- Mixed: "sales was 45k, rent 5000, stock 12k transport 3,000"
- Common misspellings and abbreviations
- Numbers without commas or with dots: "45000" "45,000" "45.000"

**Currency:**
- Always display in Nigerian Naira ₦
- Always use toLocaleString('en-NG') for formatting: ₦1,200,000 not ₦1200000
- Never use $ or other currencies
- **Reaffirmed by decision, not just default (2026-07 audit, Batch 6):** multi-currency support was
  explicitly considered and descoped — BizPulse stays Naira-only. Don't add a currency field, FX
  handling, or non-₦ formatting anywhere without a new, explicit product decision to reverse this.

**Kemi's replies must:**
- Reference Nigerian business context specifically
- Mention actual numbers from the user's entry — never give generic advice
- Reference the user's specific business type
- Use plain English (light Pidgin is fine when it fits the trader's own register — Kemi mirrors the user's language, per `trader_facts.language_preference`)
- Be actionable within a Nigerian market context
- Be warm and personal in tone — Kemi is a persona, not a form

**Example of BAD AI recommendation (generic — never do this):**
"Monitor your expense categories closely to protect your profit margin."

**Example of GOOD AI recommendation (specific — always do this):**
"Your staff wages at ₦1,000,000 represent 21.9% of today's revenue for a Services business.
This is within normal range — but consider whether all staff hours directly generate revenue
or if any tasks can be automated to reduce this cost."

---

## CRITICAL PRESERVED FIXES — DO NOT TOUCH

These fixes were implemented after bugs were discovered, or are standing invariants
the whole system depends on. They must NEVER be reverted.

### FIX 1 — Entry Aggregation (MOST CRITICAL)
**Problem fixed:** New WhatsApp entries were overwriting existing records instead of adding to them.
**Fix applied:** Every new entry INSERTS a new row into `transactions`. Nothing is ever overwritten or deleted.
**Applies to every write path** — Kemi's tool handlers (`src/agent/toolHandlers.js`: `logSaleHandler`,
`logExpenseHandler`, `settleDebtHandler`) and the web dashboard entry form (`routes/api.js`) alike.
**The one sanctioned exception:** `TransactionModel.correct()` (`models/transaction.js`) is an
admin-only manual override UPDATE, used from the admin dashboard to fix a data-entry mistake.
It is the ONLY permitted UPDATE on the `transactions` table.
**Rule:** NEVER add another UPDATE path to `transactions`. NEVER use UPDATE where INSERT should be used.
**Before touching any backend save function:** Show the current function first and confirm understanding.

### FIX 2 — Margin Calculation
**Correct formula:** margin = ((revenue - expenses) / revenue) * 100
**If revenue = 0:** margin = 0
**Positive margin = profitable. Negative = loss-making.**
**Two margin bases coexist in the `transactions.margin` column** depending on `entry_method`:
- Daily-aggregate entries (`entry_method = 'text'`/`'voice'`/`'photo'`, from the web form or a full day's
  numbers): margin is **net of all expenses** for the day.
- Per-sale entries Kemi logs (`entry_method = 'kemi'`, from `logSaleHandler`): margin is **gross margin on
  that one sale** — (sale price − cost of goods sold for that item) / sale price — and is `NULL` when no
  cost price is on file for the product (never silently shown as 0% or 100%).
When explaining "profit" to a trader in a single sentence, use: *"the money left after what you spent to
get and sell it"* — and be explicit about which basis a given number uses when it matters (weekly/monthly
pushes use the net-of-expenses basis; a single-sale confirmation uses the gross-COGS basis).
**Never calculate margin any other way, and never blend the two bases in one aggregate without noting it.**

### FIX 3 — No Google Drive / No Google Sheets
### FIX 3 — No Google Drive / No Google OAuth (amended 2026-10: opt-in read-only Sheets mode)
**Amendment (2026-10, founder decision):** a business MAY connect its own Google Sheet as its backend
("Sheets mode") — see the GOOGLE SHEETS MODE section. This is **service-account, read-only, no OAuth**.
Google OAuth, Google Drive, and any WRITE to a sheet remain prohibited. Postgres stays the default
backend for everyone who doesn't connect a sheet. The text below is the original decision, still true
for OAuth/Drive.

**Decision made:** Google Drive and Google OAuth were removed entirely.
**Reason:** Too much friction for low-tech Nigerian users. OAuth flow kills registration completion.
**Data storage:** PostgreSQL on Render only.
**Data ownership:** Users export their data via CSV download endpoint.
**DO NOT:** Add Google OAuth, Google Sheets API, or Google Drive back under any circumstances.
**Note:** Dormant `google_access_token`/`google_refresh_token`/`sheet_id` columns and `services/sheets.js`
still exist in the codebase from before this decision — gated off (never set for new users) but not yet
deleted. Slated for removal; do not build anything new against them.

### FIX 4 — Product/Inventory Duplicate Prevention (Fuzzy Matching)
**Problem fixed:** Users created duplicate inventory items due to case differences, plurals, or spelling
variants ("Laptop", "laptop", "laptops", "oud" vs "oudh").
**Two matching systems currently exist and must both be preserved:**
- `services/productService.js` (`findProductFuzzy`, `processProductTransactions`) — exact normalized
  match first, then JS-side Levenshtein distance (≤2) against all of the user's products, then a
  canonical-dictionary fallback (`PRODUCT_DICTIONARY`). Its only caller was the legacy webhook
  confirmation path, deleted in A1-2 (2026-07) — it now has no production caller (only
  `scripts/migrate-old-inventory.js` and `scripts/stock_stress_test.js` still call it). Left in place
  rather than deleted since those scripts depend on it; do not build new production code against it —
  use `normaliser.js` below instead.
- `src/agent/normaliser.js` (`normaliseProduct`) — used by Kemi's tool handlers
  (`findOrCreateProduct` in `toolHandlers.js`) before every `log_sale`/`log_restock` call.
**Rule:** Any new write path that creates or looks up a `products` row MUST go through one of these two
normalizers first — never insert a raw user-typed product name directly.
**Legacy `inventory` table:** `models/inventory.js` (`getItemFuzzy`, `applyMovement`) is the older,
pre-`products`-table system. It still exists for backward compatibility and is auto-migrated into
`products` the first time a matching product name is seen (`productService.js` `findOrCreateProduct`).
Do not write new features against the `inventory` table — it is being phased out in favor of `products`.
**Existing duplicates:** Run `node scripts/merge-duplicate-inventory.js` manually to combine them (does NOT auto-run).

### FIX 5 — Webhook Idempotency
**Problem this guards against:** Meta redelivers webhooks on timeout or non-2xx response, which can
double-log a sale or double-create a debt if not guarded against.
**Fix applied:** Every inbound message carries Meta's `whatsapp_message_id`. `MessageModel.logInbound()`
(`models/db.js`) checks it against a UNIQUE index (`idx_wa_messages_msgid`) before any processing happens,
and returns `{ duplicate: true }` if already seen — the caller must skip processing entirely in that case.
**Rule:** Any new inbound-message branch in `routes/webhook.js` (new message types, new media types) MUST
call `MessageModel.logInbound()` and check `.duplicate` BEFORE calling `runAgent()` or writing anything —
not after. (This was found violated on the image/photo branch during the 2026-07 audit and fixed as part
of Batch 0; keep it that way.)

### FIX 6 — Multi-Tenant Isolation
Every query that reads or writes trader data must be scoped to that trader — by `user_id` in
`transactions`/`products`/`product_transactions`/`debtors`/`inventory`, or by `whatsapp_number` in the
newer Kemi-specific tables (`debts` legacy, `goals`, `trader_facts`, `conversation_history`).
**Known fragility (not an active leak, but guard against it):** `TransactionModel.correct()`,
`DebtorModel.markPaid()`, `ProductModel.getById()`/`applyStockChange()` accept a bare row id with no
tenant check in their own `WHERE` clause — every current caller happens to pre-scope the id via a
user-scoped lookup first. Any new caller of these functions must do the same; do not add a second
UPDATE/DELETE path to these tables that trusts a client-supplied id without re-verifying ownership.

---

## KEMI — THE LIVE AGENT ARCHITECTURE

**Kemi is the system.** As of the 2026-07 audit, essentially all live WhatsApp traffic — text, voice
notes, and photos, for existing registered users — is routed to Kemi, a Claude-powered tool-calling
agent. Build and reason about new features against Kemi's tools, not the older rule-based pipeline.

**How a message flows today:**
1. `routes/webhook.js` receives the POST, verifies the Meta signature, dedups by `whatsapp_message_id`
   (Fix 5), and looks up the user.
2. A couple of special-case intercepts run first and short-circuit if matched: NPS rating replies, and
   the "Other" business-type clarification flow (a second live user of `pending_entries`/
   `confirmationService.js` alongside Kemi's own `stage_photo_stock_entry`/`confirm_pending_stock_entry`
   tools since Batch 4 — see below).
3. Everything else is handed to `runAgent(whatsappNumber, text, opts)` in `src/agent/agentLoop.js`.
4. `agentLoop.js` loads the last ~20 turns of conversation history and a `trader_facts` rolling-context
   summary, builds a system prompt (`systemPrompt.js`) with the trader's persona/business type baked in,
   and runs a Claude Sonnet tool-use loop (max 8 iterations, `claude-sonnet-4-6`).
5. Tool calls dispatch to `src/agent/toolHandlers.js`. Write tools run sequentially (to avoid races);
   read tools run in parallel.
6. Kemi's final text response is sent back via `WhatsAppService.sendMessage()` and persisted to
   `conversation_history`.

**Kemi's tools (`src/agent/tools.js` schemas, `toolHandlers.js` implementations):**
`log_sale`, `log_restock`, `log_expense`, `get_stock_level`, `get_stock_intelligence`,
`get_sales_summary`, `search_products`, `correct_last_entry`, `log_debt`, `settle_debt`, `get_debts`,
`send_debt_reminder`, `generate_receipt`, `stage_photo_stock_entry`, `confirm_pending_stock_entry`,
`set_goal`, `compare_periods`.

**Resolved (Batch 4, 2026-07):** photo-driven stock entries are the first (and, for now, only) Kemi
write path with a real confirm-before-commit step. Every write tool other than the two below still
commits immediately — this remains a deliberate scope choice (photos are the highest-stakes "Kemi
committed something wrong" risk, per the original Batch 4 audit finding), not an oversight.
`stage_photo_stock_entry` saves a draft into the pre-existing `pending_entries` table
(`services/confirmationService.js`'s `savePending`/`getPendingEntry`/`confirmEntry`/`discardEntry` —
unchanged) and commits nothing; `confirm_pending_stock_entry` (`action: 'confirm'|'cancel'`) actually
commits or discards it. Because images are never persisted to `conversation_history`
(`agentLoop.js` step 4 — text only), Kemi can't "look at the photo again" on the trader's next message;
`agentLoop.js` fetches any pending `photo_stock_in` entry every turn and injects a preview into the
dynamic system prompt (`systemPrompt.js`'s TRADER CONTEXT block) so she knows a draft is open even on a
photo-less turn. A correction is handled as cancel-and-restage, not a fine-grained per-item edit tool.
The older YES/EDIT/CANCEL confirmation system is otherwise still only wired to the "Other" business-type
clarification flow in `routes/webhook.js` — any other feature needing a confirm-before-commit step must
still explicitly route through `pending_entries` from inside a Kemi tool, same as before.

**Kemi's own image-handling path** (`routes/webhook.js`, `msg.type === 'image'`) downloads the photo,
base64-encodes it, and passes it straight into `runAgent()` as an image content block — Claude's vision
reads it directly as part of the same tool-calling loop, not via a separate Gemini Vision call. The
webhook route itself is unchanged by Batch 4 — the confirm-before-commit behavior lives entirely inside
Kemi's own tool choice (`systemPrompt.js`'s READING IMAGES / PENDING PHOTO ENTRY sections), not a new
branch in `routes/webhook.js`.

**8pm WAT digest** (`src/agent/digest.js`) is a separate, non-interactive process on its own cron: it
pulls a SQL data pack per active user and asks Claude to narrate it into a WhatsApp message. It also
owns two housekeeping jobs on the same file: 3am WAT `conversation_history` cleanup, and a 15-minute
refresh of `stock_intelligence_mv` (the materialized view Kemi's `get_stock_intelligence` tool reads —
velocity, days-of-cover, reorder suggestions, stockout-risk score, slow-mover flag, all computed in SQL).

**Gemini's role today** (`services/gemini.js`) is narrower than it used to be: `generateRecommendation()`
still powers the 7pm WAT email's AI recommendation (`jobs/dailySummary.js`), and `transcribeAudio()`
handles voice-note transcription before the transcript is handed to Kemi. `parseWithAI()` — the old
message-classifier — has no live callers outside test/stress-test scripts; it is dead code pending
removal.

**The legacy rule-based pipeline is gone (A1-2, 2026-07).** `ParserService` (`services/parser.js`) was
deleted outright — it had zero callers left anywhere in the codebase. `handleConfirmedEntry`,
`handleOversellYes/No`, `handleDailyEntry`, `handleOnDemandSummary`, and `buildCalcReply` were deleted
from `routes/webhook.js` along with the YES/EDIT/CANCEL and margin-recalculation intercepts that only
existed to reach them — none of it had a live caller: nothing created the `pending_entries` rows those
handlers expected. `GeminiService.parseWithAI` (`services/gemini.js`) is left in place (still has
stress-test-script callers) but has no production caller — do not add one. `routes/webhook.js` now only
routes text/voice/image to Kemi, plus the "Other" business-type clarification and WhatsApp-native
onboarding flows. If you're tempted to extend webhook.js with new parsing/confirmation logic, stop —
build it as a Kemi tool instead.

---

## GOOGLE SHEETS MODE (opt-in, 2026-10 — Phase 1 of the sheet-backed backend)

A business can keep its records in its own Google Sheet; staff update the sheet, the owner uses WhatsApp
only to read. **Postgres is not written to for these businesses** (Fix 1 is untouched — nothing here
INSERTs/UPDATEs `transactions`/`products`).

- **Connect:** the owner pastes the sheet link to Kemi (`connect_google_sheet`). The sheet must be shared
  as **Viewer** with the BizPulse service account (`GOOGLE_SERVICE_ACCOUNT_JSON`; Kemi tells them the
  email). No OAuth. Read-only scope (`spreadsheets.readonly`) — Google enforces it.
- **Layout:** `services/sheets/mapper.js` finds Stock / Purchases / Sales tabs and maps columns by header
  *name* (synonyms, then a Claude fallback). Stock = Stock-tab quantity column if present, else
  purchases − sales. Mapping lives in `sheet_connections.mapping`; the sheet's data is never copied in.
- **Mode switch:** a row in `sheet_connections` = Sheets mode. `agentLoop.js` then offers only
  `get_stock_level` / `get_stock_intelligence` / `get_sales_summary` (answered from the sheet by
  `src/agent/sheetHandlers.js`) plus connect/disconnect. All write tools are withheld.
- **Pushes** (`jobs/sheetJobs.js`): 5-min poll → "just sold" alert for new Sales rows (tracked by row
  hash in `sheet_seen_sales`; history is baselined on connect; only rows dated today/yesterday alert),
  7:30 AM stock, 8:30 PM recap. `sheet_*` push types are exempt from the weekly push cap. Sheet users are
  excluded from every Postgres-based proactive job (`UserModel.findAllActive/findInactiveFor`, 8pm digest).
- **Known gaps:** proactive sheet pushes use free-form `sendMessage` like the other morning/digest jobs —
  outside the 24h window they need approved Meta templates before production. Sales "profit" is not
  computed from sheets (revenue/units only). Phase 2: a WhatsApp/web interface that writes to the sheet.

---

## INVENTORY / PRODUCT CALCULATIONS — EXACT RULES

**Canonical system is the `products` + `product_transactions` tables** (see Fix 4 for the legacy
`inventory` table's status).

**Stock in (restock):**
- `log_restock` tool or legacy `inventory_in` path
- `current_stock` increases by quantity; `total_ever_received` increases by quantity
- `last_purchase_price` updates to the new unit cost (this is a mutable "most recent cost", not an
  immutable per-purchase record — a receipts/cost-history table is a known gap, see Phase B backlog)

**Stock out (sale):**
- `log_sale` tool or legacy `inventory_out` path
- `current_stock` decreases by quantity, floored at 0 (`GREATEST(0, current_stock - qty)`)
- Oversell handling differs by path: Kemi's `logSaleHandler` floors silently; the legacy path
  (`productService.js` `processProductTransactions`) detects oversell before applying the delta and can
  trigger an interactive confirmation via `pending_entries`

**Low stock / out of stock alerts** (`productService.js` `checkAndSendLowStockAlert`):
- **Fixed (Batch 3, 2026-07):** this had zero production callers since the legacy webhook path that
  called it was deleted in A1-2 (Batch 0) — low-stock alerts were silently dead for every Kemi-routed
  sale. `src/agent/toolHandlers.js`'s `logSaleHandler` now calls it (non-blocking) after every stock
  decrement, using the freshly-updated product row.
- Out of stock: `current_stock === 0`
- Low stock: velocity-aware — if 7-day sales velocity > 0, alert when `daysRemaining <= 2`; otherwise
  falls back to the static `current_stock / total_ever_received < 0.20` threshold
- One alert per product per type per day (`stock_alerts_sent` table, unique-indexed) — a separate,
  narrower dedup than the weekly `push_log` budget (see Retention section): `stock_alerts_sent` stops
  the *same* alert repeating same-day, `push_log` caps total proactive volume across *all* push types.
- Also gated by the shared weekly push budget (`services/pushBudget.js`) — `out_of_stock` is exempt from
  the cap, non-zero `low_stock` counts against it like any other push.

**Stock integrity fixes (A1-8, Batch 4, 2026-07):**
- **Void-zeroes-quantity:** `correctLastEntryHandler`'s `delete` action (`src/agent/toolHandlers.js`)
  now zeroes `quantity` on the voided `product_transactions` row, not just `total_amount` — before this,
  a voided sale still inflated `ProductModel.getVelocity()` and `stock_intelligence_mv`'s velocity
  figures, since both `SUM(quantity)` with no voided-row exclusion.
- **`ProductModel.recomputeStock(productId)` / `applyRecompute(productId)`** (`models/product.js`) —
  a repair utility, not wired into any hot path. Recomputes what `current_stock` *should* be purely from
  the `product_transactions` ledger (`SUM(stock_in) - SUM(sale)`, floored at 0, void-safe per the fix
  above) and reports drift; `applyRecompute` writes the correction back. Manual script
  `scripts/recompute-stock.js` (`node scripts/recompute-stock.js [--apply] [--user <whatsapp_number>]`)
  runs it across all products or one trader's — dry-run by default, `--apply` to actually fix drift.
- **Atomic stock+transaction writes:** `logSaleHandler`, `logRestockHandler`, and
  `confirmPendingStockEntryHandler`'s commit path each wrap their `products` stock `UPDATE` +
  `product_transactions` `INSERT` (+ `transactions` `INSERT` where applicable) in a single Postgres
  transaction via the new `withTransaction(fn)` helper (`models/db.js`) — a checked-out client,
  `BEGIN`/`COMMIT`/`ROLLBACK`/`release`. Before this, these were independent pool queries and a crash
  mid-write could desync `current_stock` from the history it's derived from.

**`stock_intelligence_mv`** (materialized view, refreshed every 15 min by `digest.js`) precomputes, per
product: 7-day and 28-day velocity, days-of-cover, trend, reorder-suggested flag, a 0–100 stockout-risk
score, and an `is_slow_mover` flag. This is Kemi's `get_stock_intelligence` tool's data source — prefer
reading from here over recomputing velocity ad hoc in a new feature.

---

## DEBT TRACKING — CURRENT STATE (consolidated, Batch 1 / A1-3, 2026-07)

**`debtors`** (user_id-keyed, NUMERIC amounts) is now the **sole** debt table. It supports partial
payments via `amount_paid`/`status IN ('pending','partial','paid')`, plus `customer_id` (link to
`customers`, once a phone is on file), `disputed`/`disputed_at`, and `last_reminder_sent_at`. Kemi's
`log_debt`/`settle_debt`/`get_debts`/`send_debt_reminder` tools are the only writers.

**`debts`** (whatsapp_number-keyed, legacy) has been migrated into `debtors` via
`scripts/migrate-legacy-debts.js` (manual run, idempotent — safe to re-run) and is no longer read
anywhere in the app (`getDebtsHandler`'s old UNION was removed). The table itself is **not dropped** —
it stays as historical record until Tosin has spot-checked the migrated rows in production, at which
point physical removal is a manual follow-up.
**Historical data-quality note:** despite this doc previously describing `debts.amount` as "BIGINT
kobo", the original (deleted) writer never multiplied by 100 — it stored the raw naira figure straight
into the BIGINT column. The migration copies `debts.amount` through as-is (naira, no `/100`) to match
what was actually written; confirmed by reading the original writer in git history before migrating.

**Ledger fix (A1-3):** `DebtorModel.markPaid()` (`models/debtor.js`) no longer mutates `amount_paid` in
place. It INSERTs into the new append-only `debt_payments` table, then recomputes (never increments)
`debtors.amount_paid`/`status`/`paid_at` from `SUM(debt_payments.amount)` — `debt_payments` is the
source of truth and audit trail; the columns on `debtors` are just a cache always rebuilt from it. This
also fixed a latent bug in `settleDebtHandler`: a "fully paid" reply (amount omitted) after a prior
partial payment now settles the true remaining balance, not the original total.

**Customer contacts + compliance (`models/customer.js`, `customers` table, A2-3/A2-9):** phone numbers
are captured **on-demand only** — Kemi never asks for one when a debt is first logged, only when the
trader actually asks for a reminder to be sent and no number is on file yet (`send_debt_reminder`
returns `needs_phone` in that case). The trader supplying the number is the request-to-contact event.
`STOP`/`DISPUTE` replies from a known customer number are intercepted in `routes/webhook.js` before the
onboarding branch (so they're never swallowed into "what's your name?"): `STOP` sets
`customers.opted_out = true` **globally** (across all traders that number is linked to — the safer
compliance default), `DISPUTE` flags the most recently-reminded outstanding `debtors` row as
`disputed = true` and notifies the trader. `send_debt_reminder` skips opted-out and disputed debtors and
narrates the skip honestly rather than claiming a blanket "reminders sent!". A Meta template send failure
(unapproved template, rate limit, etc.) is caught and surfaced as `send_failed` rather than crashing the
tool call — this matters even with live Meta credentials configured, since credentials being present
doesn't mean a given template is approved.

**Weekly Monday debt digest** (`jobs/debtDigest.js`, 8:00 AM WAT) sends each trader with outstanding
debt a `weekly_debt_digest` template summary; skips traders with zero outstanding debt.

**Full-payment → receipt hook:** `settleDebtHandler` calls `services/receipts.js`'s
`onDebtFullyPaid()` when a debt is fully settled — as of Batch 2 this generates and sends a real cash
receipt to the trader via `generate_receipt`'s underlying handler (see Receipts section below). It can
never recurse into creating another debt, since the synthesized receipt is always `payment_method:
'cash'`.

---

## RECEIPTS (Batch 2, 2026-07)

`generate_receipt` is a Kemi tool that renders a receipt image and sends it back to the **trader**
(not the customer directly — the trader forwards it themselves; sending straight to a customer is
deferred to a future batch, since it would mean extending the STOP/consent machinery built for debt
reminders to a second message type). It is presentation-only: it never writes `transactions`/
`product_transactions` — if the trader wants the sale logged too, Kemi calls `log_sale` in the same turn.

**The Edge 1↔2 interlock** between receipts and debts runs both directions:
- Receipt → debt: a `generate_receipt` call with `payment_method: 'credit'` always creates a `debtors`
  row too (via the same `DebtorModel.create` `log_debt` uses), linked via `receipts.debtor_id` — a
  credit receipt can never exist without a matching debt record.
- Debt → receipt: `settleDebtHandler`'s full-payment hook (above) auto-generates a cash receipt the
  moment a debt is fully paid off.

**Rendering** (`services/receiptRenderer.js`): Satori (plain-object layout tree → SVG, no JSX/build step)
+ `@resvg/resvg-js` (SVG → PNG) — no headless browser, both ship prebuilt binaries, a light footprint
for a small Render.com web service. Fonts are DM Sans/DM Serif Display (`@fontsource/*`, read from
`node_modules` at runtime — no network fetch at request time), **plus `dejavu-fonts-ttf` registered as a
fallback font** for the Naira sign specifically: DM Sans, DM Serif Display, Noto Sans, Noto Sans Symbols,
and Roboto were all tested and none of their Fontsource-bundled subset files include U+20A6 (Currency
Symbols block) — only DejaVu Sans does. Registered last in the `fonts` array with an explicit
`fontFamily: 'DM Sans, DejaVu Sans'` CSS fallback stack, so it only kicks in for the glyphs DM Sans
lacks.

**Sequencing** (`receipt_counters` table): a per-trader receipt number, assigned via a single atomic
UPSERT (`INSERT ... ON CONFLICT DO UPDATE SET next_number = next_number + 1 RETURNING next_number - 1`)
— race-safe under concurrent `generate_receipt` calls because Postgres serializes that statement per
row, with no explicit locking needed. Verified under 10 concurrent calls in
`tests/receipt_generator_test.js`.

**Outbound media** (`services/whatsapp.js`, A2-1): `uploadMedia()` (Meta Media API upload),
`sendImageMessage()` (regular, non-template image send — no Meta template approval needed since the
trader just asked for this), and `sendReceiptImage()` (the two combined). Same dev-mode-safe fallback
pattern as `sendMessage`/`sendTemplateMessage`, and the send is wrapped in try/catch in
`generateReceiptHandler` — a Meta send failure returns `send_failed` for Kemi to narrate honestly rather
than crashing the tool call, the same lesson Batch 1's `send_debt_reminder` learned.

---

## DESIGN PRINCIPLES

### The Golden Rule
**Every design decision must pass this test:**
"Would a tired market trader in Oshodi understand this at 8pm on their phone?"
If no — simplify it.

### Mobile First — Non-Negotiable
- Primary device is a smartphone, not a laptop
- On screens under 768px: sidebar becomes bottom navigation
- Bottom nav: 🏠 Home | ✏️ Entry | 📈 Summary | ⚙️ Settings
- All content readable without zooming on 375px screen
- Test every change on mobile width before considering it done

### Colour System
```
--navy:       #0F2744  (primary, headers, nav background)
--blue:       #1A56A4  (buttons, links, accents)
--blue-light: #2B6CB0  (secondary actions)
--green:      #1A7A4A  (profit, positive values, activate buttons)
--red:        #C53030  (expenses, losses, alerts)
--gold:       #B7791F  (margin, highlights, streak)
--bg:         #F0F4FA  (page background)
--card:       #FFFFFF  (card background)
--muted:      #718096  (secondary text, labels)
--border:     #E2E8F0  (dividers, card borders)
```

### Typography
- Headings: DM Serif Display
- Body: DM Sans
- Load from Google Fonts

### Information Hierarchy
**Home page = daily driver (everything at a glance):**
1. Greeting + streak
2. Today's 4 key metrics
3. Plain English profit/loss sentence
4. AI insight preview (2 lines) + "See full →" link
5. Quick actions (Log + Send Summary)
6. Last 5 days activity
(Remove "How It Works" — user already registered)

**Summary page = deep dive (clean sections):**
1. Full metrics (6 cards)
2. Full AI recommendation
3. Expense breakdown with visual bars
4. Month vs last month comparison
5. Inventory status (only if entries exist)
6. Full entry history with pagination
(Remove: streak, data quality indicator from here)

### Plain English First
Every number must be explained in plain English below it.
- Profit positive: "✅ You earned ₦X more than your expenses today"
- Profit negative: "⚠️ You spent ₦X more than you earned today. Biggest cost: [category]"
- Empty state: never show ₦0 or "NO" — always explain why data is missing

### Simplicity Over Features
When in doubt — remove it.
A confused user is a churned user.
One clear thing beats three unclear things every time.

---

## RETENTION AND ENGAGEMENT

### Streak — Most Important Retention Mechanic
- Tracked in `users.streak`, updated by `UserModel.touchLastEntry()` on every logged entry
  (`last_entry_date` vs yesterday/today in Africa/Lagos time decides increment vs reset)
- **Fixed (A1-1, 2026-07):** Kemi's write tools (`log_sale`/`log_restock`/`log_expense`/`log_debt`/
  `settle_debt`, via `recordActivityMilestone()` in `src/agent/agentLoop.js`) now call `touchLastEntry()`
  and surface a `streak_info: { streak, totalMessages, milestone }` field on the tool result. Kemi
  mentions the streak naturally in her own reply voice per `systemPrompt.js`'s STREAK & MILESTONES
  section — not a separate templated message.
- Should show on every WhatsApp reply, prominently on the Home page banner, and on the Summary page
  (below the health badge — not next to it). Never on Settings.
- Special celebration messages at 7, 14, 30, 60, 100 days (streak) plus first-entry and 10th-entry
  engagement milestones are detected in `recordActivityMilestone()` and celebrated by Kemi herself (one
  extra warm line) per the same STREAK & MILESTONES prompt section — this is the live path for all
  Kemi-routed traffic.
- **Legacy path still exists, do not extend it:** `services/whatsapp.js` (`sendMilestone`) and the
  templated dispatch block in `routes/webhook.js` (`handleConfirmedEntry`, `day1`/`streak7`/`streak30`/
  `streak100`/`entry10`/`first_profit`) only fire from the `pending_entries` YES/EDIT/CANCEL confirmation
  flow (oversell confirmation etc.) — a narrow edge case, not the main Kemi flow. It only covers
  7/30/100, not 14/60. Leave as-is; it's slated for removal with the rest of the legacy pipeline. Because
  it can theoretically fire alongside Kemi's own celebration in the same day, it's part of the "no shared
  send-volume budget" gap below, not a milestone-logic gap.

### Admin Dashboard (/admin — password protected)
Must always show:
- Total registered users
- Activated (sent at least 1 message)
- Active this week (message in last 7 days)
- At risk (no message in 5-14 days) — these need nudges
- Churned (no message in 14+ days)
- Average messages per user per week
- Daily new registrations

### Automated Retention/Engagement Jobs (all Africa/Lagos-scheduled via node-cron)
- `jobs/dailySummary.js` — 6:00 PM WAT evening reminder (users with no entry yet today) + 7:00 PM WAT
  full email summary; also runs a 30-min pending-entry expiry sweep and a 30-min confirmation-reminder
  sweep (both legacy-path only)
- `jobs/morningCoaching.js` — 7:30 AM WAT personalized morning stock briefing
- `src/agent/digest.js` — 8:00 PM WAT Kemi-narrated evening digest, 3:00 AM WAT history cleanup,
  every-15-min `stock_intelligence_mv` refresh
- `jobs/retentionNudge.js` — 10:00 AM WAT, checks inactive users, sends WhatsApp nudges at day 3/5/7/14
  of inactivity
- `jobs/debtDigest.js` — Monday 8:00 AM WAT weekly debt digest (Batch 1, A1-3) — see Debt Tracking section
- `jobs/weeklyProfitNote.js` — Sunday 7:00 PM WAT weekly profit/margin note (Batch 3)
- `jobs/deadStockNudge.js` — Wednesday 9:00 AM WAT slow-mover nudge (Batch 3)

**Resolved (Batch 3, 2026-07):** all six proactive WhatsApp send-sites above, plus the live low-stock
alert (see Inventory section), now share one weekly send-volume budget via `services/pushBudget.js` —
`checkPushBudget(userId, pushType)` / `recordPush(userId, pushType)`, backed by the `push_log` table.
**Weekly cap: 10 sends per rolling 7 days per trader.** `out_of_stock` alerts are the one exempt type
(still logged in `push_log` for admin visibility, just never blocked or counted against the shared
budget) — a "you have zero left" alert is time-sensitive lost-revenue information, not an engagement
nudge. Every other push type (digest, briefing, retention nudges, non-zero low-stock, dead-stock,
weekly profit/debt notes) shares the one budget; a job that can't send due to the cap logs why and
moves on rather than retrying or erroring. The 7pm *email* summary is a separate channel and is not
subject to this WhatsApp-specific budget.

---

## DATABASE — KEY TABLES (as actually defined in `models/db.js`)

**users** — `id, name, email, biz_name, biz_type, state, whatsapp_number, created_at, active,
last_entry_date, streak, first_message_date, last_message_date, total_messages_sent, referred_by,
opening_stock_logged(+_at), summary_frequency`. (Dormant: `sheet_id`, `google_access_token`,
`google_refresh_token` — see Fix 3.)

**transactions** — `id, user_id, date, revenue, total_expenses, expense_breakdown(JSONB), profit, margin,
customers, notes, raw_message, entry_method, sale_type, created_at`.
**RULE:** INSERT-only (Fix 1).

**products** — `id, user_id, product_name, product_name_normalized, unit, last_purchase_price,
last_sale_price, current_stock, total_ever_received, is_active, created_at, updated_at`.

**product_transactions** — `id, user_id, product_id, transaction_type('sale'|'stock_in'), quantity,
unit_price, total_amount, transaction_date, daily_entry_id, notes, channel('retail'|'wholesale'),
sale_type('cash'|'credit'), created_at`.

**debtors** (sole debt table, see Debt Tracking section) — `id, user_id, debtor_name, amount,
amount_paid, product_name, status, notes, created_at, paid_at, customer_id, disputed, disputed_at,
last_reminder_sent_at`.

**debt_payments** — append-only ledger backing `DebtorModel.markPaid()` — `id, debtor_id, amount,
created_at`. Source of truth for `debtors.amount_paid`, never the other way around.

**customers** — a trader's named contacts, captured on-demand when a reminder is requested — `id,
user_id, name, phone, opted_out, opted_out_at, created_at, updated_at`.

**debts** (legacy, fully migrated into `debtors` via `scripts/migrate-legacy-debts.js`, no longer read
anywhere — see Debt Tracking section) — `id(UUID), whatsapp_number, debtor_name, amount, item, note,
status, created_at, settled_at`. Despite the historical "BIGINT kobo" naming, `amount` was actually
always written in naira — see the Debt Tracking section's data-quality note.

**inventory** (legacy, being phased out — see Fix 4) — `id, user_id, item_name, current_balance,
total_received, unit_price, low_stock_threshold, last_updated`.

**pending_entries** — `id, user_id, entry_type, parsed_data(JSONB), original_message, status,
reminder_sent, created_at, confirmed_at, expires_at`. Confirm-before-commit staging table; wired to the
legacy webhook path's "Other" business-type clarification AND (since Batch 4) Kemi's own
`stage_photo_stock_entry`/`confirm_pending_stock_entry` tools (`entry_type = 'photo_stock_in'`) — see
Kemi section.

**conversation_history / trader_facts / goals** — Kemi's memory tables, keyed by `whatsapp_number`
(not `user_id` — a known fragility, see Fix 6).

**stock_intelligence_mv** — materialized view, see Inventory section.

**whatsapp_messages** — every inbound/outbound message, with `whatsapp_message_id` UNIQUE-indexed for
dedup (Fix 5).

**ai_inference_log** — every Gemini parse/recommendation call, for future fine-tuning data.

**receipts** (see Receipts section) — `id, user_id, sequence_number, customer_name, items(JSONB),
total_amount, payment_method('cash'|'credit'), debtor_id, created_at`.

**receipt_counters** — `user_id PRIMARY KEY, next_number`. Atomic per-trader receipt sequence, never
read directly outside the UPSERT that assigns the next number.

**push_log** — `id, user_id, push_type, sent_at`. Backs the shared weekly send-volume budget (see
Retention section) — every proactive WhatsApp push is recorded here, including cap-exempt ones.

**Full list of other tables present:** `customer_logs`, `business_personas`, `message_variants`,
`message_log`, `stock_alerts_sent`, `product_name_dictionary`, `media_log`, `parse_corrections`,
`learned_phrases`, `onboarding_sessions`, `user_sessions`. See `models/db.js` `initDb()` for exact
current schema — treat it as the source of truth over this document if they ever disagree.

---

## TECHNICAL ARCHITECTURE

**Stack:**
- Backend: Node.js + Express on Render.com
- Database: PostgreSQL on Render (managed)
- Conversational AI: Anthropic Claude (Kemi agent — `claude-sonnet-4-6`, tool-calling loop)
- Batch/narration AI: Google Gemini (2.5 Flash for the 7pm email recommendation; also handles voice
  transcription)
- WhatsApp: Meta WhatsApp Business Cloud API
- Email: Brevo HTTP API (axios POST to api.brevo.com — NOT nodemailer/Gmail)
- Frontend: Single HTML file served by Express from /public (NOT Netlify)
- Scheduler: node-cron, all jobs pinned to `timezone: 'Africa/Lagos'`

**Folder structure (as it actually exists):**
```
bizpulse/
├── server.js
├── package.json
├── .env / .env.example
├── CLAUDE.md
├── routes/
│   ├── webhook.js       (WhatsApp webhook — dispatches to Kemi; legacy pipeline being removed)
│   ├── api.js            (frontend API endpoints)
│   ├── email.js           (on-demand summary email trigger)
│   └── admin.js           (password-protected admin dashboard at /admin)
├── src/agent/            (Kemi — the live conversational agent)
│   ├── agentLoop.js       (Claude tool-use loop, dispatch)
│   ├── tools.js           (tool schemas passed to Claude)
│   ├── toolHandlers.js    (tool implementations — direct SQL)
│   ├── systemPrompt.js    (persona + context builder)
│   ├── memory.js          (conversation_history + trader_facts rolling context)
│   ├── normaliser.js      (product name normalization for Kemi's tools)
│   ├── stockIntelligence.js (reads stock_intelligence_mv)
│   └── digest.js          (8pm digest, 3am cleanup, 15-min MV refresh crons)
├── services/
│   ├── whatsapp.js         (outbound send — text, templates, media upload/image send, debt/digest/receipt senders)
│   ├── receiptRenderer.js  (Satori + @resvg/resvg-js HTML→PNG receipt renderer)
│   ├── gemini.js           (email recommendation + voice transcription; parseWithAI is legacy/dead)
│   ├── claude.js           (Claude client used for the 6pm nudge coaching tip)
│   ├── email.js            (build + send emails via Brevo HTTP API)
│   ├── confirmationService.js (pending_entries staging — legacy "Other" biz-type flow + Kemi's photo-in confirm tools, Batch 4)
│   ├── productService.js   (legacy-path product fuzzy-matching, stock alerts)
│   ├── inventory.js        (legacy inventory table operations)
│   ├── customers.js        (standalone customer-COUNT logging — NOT the debt-contact model, see models/customer.js)
│   ├── receipts.js         (full-payment → receipt hook — generates a real receipt as of Batch 2)
│   ├── pushBudget.js       (shared weekly send-volume budget across all proactive pushes, Batch 3)
│   ├── personaEngine.js    (business-persona-aware messaging)
│   ├── nudgeBuilder.js     (retention nudge copy)
│   ├── messageVariants.js  (A/B message variant tracking)
│   ├── learningService.js  (crowdsourced parse-correction learning)
│   ├── marketData.js
│   ├── stockExamples.js
│   ├── sheets.js           (dormant — Fix 3)
│   └── parser.js           (legacy rule-based parser — dead code pending removal)
├── models/
│   ├── db.js             (connection pool + initDb schema + MessageModel + withTransaction helper)
│   ├── user.js
│   ├── transaction.js
│   ├── product.js
│   ├── debtor.js          (sole debt table + append-only debt_payments ledger)
│   ├── customer.js        (trader's debt-contact phone numbers + STOP consent, see Debt Tracking section)
│   ├── inventory.js       (legacy)
│   └── onboarding.js      (WhatsApp-native conversational registration sessions)
├── middleware/
│   └── auth.js            (session-cookie auth for the web dashboard/admin)
├── jobs/
│   ├── dailySummary.js     (6pm reminder + 7pm email summary + confirmation sweeps)
│   ├── morningCoaching.js  (7:30am stock briefing)
│   ├── retentionNudge.js   (10am day 3/5/7/14 inactivity nudges)
│   ├── debtDigest.js       (Monday 8am weekly debt digest)
│   ├── weeklyProfitNote.js (Sunday 7pm weekly profit/margin note, Batch 3)
│   └── deadStockNudge.js   (Wednesday 9am slow-mover nudge, Batch 3)
├── utils/
│   ├── formatter.js        (₦ formatting, dates, health score)
│   ├── naira.js             (currency parsing helpers)
│   ├── periodParser.js      (natural-language date range parsing)
│   └── phone.js              (phone number normalization)
├── scripts/                (one-off maintenance/migration/test scripts — not part of the running app)
└── public/
    └── index.html          (complete frontend — served by Express)
```

**Environment variables:**
```
WHATSAPP_PHONE_NUMBER_ID=     # From Meta dashboard
WHATSAPP_TOKEN=               # Regenerate daily until Meta verified
WHATSAPP_VERIFY_TOKEN=bizpulse_webhook_2026
WHATSAPP_APP_SECRET=          # Used to verify X-Hub-Signature-256 on inbound webhooks
BIZPULSE_NUMBER=              # Dedicated SIM number
ANTHROPIC_API_KEY=            # Required — Kemi agent will not work without it (fail-fast on boot)
GEMINI_API_KEY=               # Required — AI email recommendation + voice transcription (fail-fast on boot)
DATABASE_URL=                 # From Render PostgreSQL
BREVO_API_KEY=                # From Brevo dashboard — used for transactional emails
BREVO_FROM_EMAIL=             # Verified sender email in Brevo
BASE_URL=                     # Render deployment URL
PORT=3000
NODE_ENV=production
ADMIN_PASSWORD=               # For /admin dashboard (password-protected)
```

**DO NOT use:** GMAIL_USER, GMAIL_APP_PASSWORD, nodemailer — all email goes through Brevo HTTP API.

---

## PHASE BOUNDARIES

### Phase 1 — CURRENT BUILD (build this, nothing more)
- WhatsApp daily entry (sales + expenses + customers) via Kemi
- Inventory/product tracking (stock in/out/check, low-stock alerts, stock intelligence)
- Daily 7pm email summary with AI recommendation
- On-demand summary via WhatsApp or web button
- Web dashboard (Home, Daily Entry, Summary, Settings)
- Admin analytics dashboard
- Streak tracking and milestone celebrations (currently being rewired into Kemi — see Retention section)
- Retention nudge system (day 3/5/7/14)
- CSV data export endpoint
- **In active build (2026-07 market-fit expansion, still Phase 1 in spirit — these formalize things the
  data model already partially supports):** debt book consolidation + reminders, receipt generator,
  scheduled pushed insights (profit/debt/stock), photo-in with confirmation

### Phase 2 — DO NOT BUILD YET
- Weekly and monthly trend charts (beyond what compare_periods/get_sales_summary already provide via Kemi)
- Multi-language support (Yoruba, Hausa — Pidgin is already partially handled)
- Referral programme with rewards
- Monthly business review email (Wrapped-style)

### Phase 3 — DO NOT BUILD YET
- Loan-ready financial statements (PDF export)
- Tax compliance summary (VAT/FIRS format)
- Business health score (0-100) beyond the existing margin-based version
- Peer benchmarking by business type
- Partnership with microfinance institutions

### Phase 4 — DO NOT BUILD YET
- Staff payroll tracking
- Multi-location support
- Institutional API for lenders
- BizPulse Personal (personal finance tracker)
- WhatsApp referral leaderboard

---

## WHAT NOT TO BUILD — EVER (unless explicitly instructed)

- Google OAuth or Google Drive integration (removed — do not add back; read-only service-account Sheets mode is the one sanctioned exception)
- Any feature that requires users to leave WhatsApp for initial setup
- Complex accounting terminology in any user-facing text
- Features that require more than one action from a tired user at 8pm
- Anything that increases registration friction
- Push notifications (not supported in current stack — WhatsApp messages are the notification channel)
- Native mobile app (web app only for now)
- Payment processing (not in Phase 1)
- Outbound WhatsApp messages to third parties (a trader's customers) without Meta-approved message
  templates and working STOP/opt-out handling — this is a hard compliance requirement, not a style
  preference

---

## COMPETITIVE CONTEXT

**Tyms.io:** WhatsApp bookkeeping exists in US market — not yet in Nigeria.
Gap: Their WhatsApp feature explicitly says "Available for American businesses only."
BizPulse fills this gap for Nigeria.

**Moniepoint:** Acquired Orda (restaurant management) March 2026.
Moving upmarket toward enterprise restaurants.
Gap: Small food vendors, bukas, mama puts — now underserved again.
BizPulse serves the bottom of the market Moniepoint is vacating.

**Orda:** Acquired by Moniepoint. Restaurant-specific. Required active daily engagement.
Served businesses making ~$70,000/year. Not our target.

**Our moat being built:**
1. Data network effects — proprietary Nigerian SME financial dataset
2. Switching costs — users' financial history lives here
3. Embedded workflows — eventually embedded in loan application processes
4. Community and identity — "I'm a BizPulse business" as a badge of honour
5. Regulatory relationships — SMEDAN, CBN SME desk

---

## HOW TO EVALUATE EVERY DECISION

Before building any feature, changing any UI element, or making any architectural decision,
ask these six questions in order:

**1. Does the tired market trader understand it?**
If a notebook-using fashion trader in Oshodi cannot figure it out at 8pm — simplify it.

**2. Does it help users know if they made money today?**
That is the core question every user is asking. Does this decision help answer it?

**3. Does it work on a phone?**
Test on 375px. If it does not work on mobile it does not exist.

**4. Does it protect the data aggregation fix?**
Any change to transaction saving logic must preserve the INSERT-only rule (Fix 1).

**5. Is it built against Kemi?**
If it's a WhatsApp-facing feature, it should be a Kemi tool (`src/agent/tools.js` +
`toolHandlers.js`), not an extension of the legacy rule-based pipeline.

**6. Is it Phase 1?**
If it is not in the Phase 1 list above — do not build it. Note it for Phase 2.

---

## FINAL REMINDER

BizPulse exists to serve Nigerian SME owners who have never had access to
the financial intelligence that large companies take for granted.

Every line of code, every design decision, every feature added or removed
should be evaluated against this mission.

The user is not a tech-savvy professional.
The user is a market trader who wrote their numbers in a notebook yesterday.
Today they sent a WhatsApp message instead.
Tomorrow they will know exactly whether their business made money.

That is the product. Build it simply. Build it reliably. Build it for them.
