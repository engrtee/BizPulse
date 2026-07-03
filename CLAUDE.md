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
- `services/productService.js` (`findProductFuzzy`) — used by the legacy webhook confirmation path.
  Exact normalized match first, then JS-side Levenshtein distance (≤2) against all of the user's products,
  then a canonical-dictionary fallback (`PRODUCT_DICTIONARY`).
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
2. A handful of special-case intercepts run first and short-circuit if matched: NPS rating replies,
   pending-entry YES/EDIT/CANCEL confirmations (legacy path only — see below), margin-recalculation
   percentage replies, and the "Other" business-type clarification flow.
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
`set_goal`, `compare_periods`.

**Important behavioral gap (open, tracked for Batch 4):** Kemi's write tools commit immediately —
there is no confirm-before-commit step in her tool-call path today. A separate, older confirmation
system (`services/confirmationService.js` + the `pending_entries` table, YES/EDIT/CANCEL) exists and is
wired into the legacy rule-based webhook path only (oversell confirmation, biz-type clarification,
margin-recalculation). Any feature that needs "show a draft, wait for YES before committing" (e.g.
photo-in extraction) must explicitly route through `pending_entries` from inside a Kemi tool — it is not
automatic just because the infrastructure exists elsewhere in the file.

**Kemi's own image-handling path** (`routes/webhook.js`, `msg.type === 'image'`) downloads the photo,
base64-encodes it, and passes it straight into `runAgent()` as an image content block — Claude's vision
reads it directly as part of the same tool-calling loop, not via a separate Gemini Vision call.

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

**The legacy rule-based pipeline** (`ParserService`, `GeminiService.parseWithAI`, `handleConfirmedEntry`,
`handleOversellYes/No`, `handleOnDemandSummary`, `buildCalcReply` in `routes/webhook.js`) predates Kemi
and is no longer reachable by real users for the message types Kemi owns. Do not extend it. It is being
removed as part of the market-fit build (2026-07) — if you find yourself editing it, stop and check
whether the equivalent Kemi tool already exists instead.

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

**Low stock / out of stock alerts** (`productService.js` `checkAndSendLowStockAlert`, legacy path only
today — verify Kemi's `log_sale` path triggers the equivalent before shipping any inventory-dependent
push feature):
- Out of stock: `current_stock === 0`
- Low stock: velocity-aware — if 7-day sales velocity > 0, alert when `daysRemaining <= 2`; otherwise
  falls back to the static `current_stock / total_ever_received < 0.20` threshold
- One alert per product per type per day (`stock_alerts_sent` table, unique-indexed)

**`stock_intelligence_mv`** (materialized view, refreshed every 15 min by `digest.js`) precomputes, per
product: 7-day and 28-day velocity, days-of-cover, trend, reorder-suggested flag, a 0–100 stockout-risk
score, and an `is_slow_mover` flag. This is Kemi's `get_stock_intelligence` tool's data source — prefer
reading from here over recomputing velocity ad hoc in a new feature.

---

## DEBT TRACKING — CURRENT STATE (consolidation in progress)

Two debt tables currently coexist:
- **`debtors`** (user_id-keyed, NUMERIC amounts, supports partial payments via `amount_paid`/
  `status IN ('pending','partial','paid')`) — this is the **canonical, actively-written** table. Kemi's
  `log_debt`/`settle_debt`/`get_debts` tools and the legacy credit-sale path both write here.
- **`debts`** (whatsapp_number-keyed, BIGINT kobo amounts, `status IN ('outstanding','settled')`, no
  partial-payment support) — legacy. Nothing writes to it anymore; `getDebtsHandler` still UNION-reads it
  for historical rows. Migration/consolidation into `debtors` is tracked work, not yet done.
**Known invariant violation to fix, not to copy elsewhere:** `DebtorModel.markPaid()` mutates
`amount_paid` in place via UPDATE rather than appending an INSERT-only payment row with a derived
balance — this is the one place in the debt system that doesn't yet follow Fix 1's spirit. New debt/
payment features should use an append-only ledger, not this pattern.

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
- **Known gap (tracked for Batch 0 of the 2026-07 build):** `touchLastEntry()` is called from the web
  dashboard entry form and from the legacy webhook path, but Kemi's write tools
  (`logSaleHandler`/`logExpenseHandler`/etc.) do not call it — meaning streak currently does not advance
  for WhatsApp entries logged through Kemi, the primary channel. Wiring this in is a priority fix.
- Should show on every WhatsApp reply, prominently on the Home page banner, and on the Summary page
  (below the health badge — not next to it). Never on Settings.
- Special celebration messages at 7, 14, 30, 60, 100 days — the messaging content for these still lives
  in `services/whatsapp.js` (`sendMilestone`), but is currently only invoked from the legacy webhook path
  for the same reason as above. Product decision: this should become something Kemi says naturally in
  her own reply voice, not a separate templated message stacked after hers.

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
**Known gap:** these four jobs currently share no send-volume budget — an active user could receive a
6pm reminder, an 8pm digest, and (on the right day) a 10am nudge and a 7:30am briefing, all in one day,
with nothing coordinating total volume. Any new proactive-push feature must be built against a shared
per-user weekly send cap, not just its own logic.

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

**debtors** (canonical debt table, see Debt Tracking section) — `id, user_id, debtor_name, amount,
amount_paid, product_name, status, notes, created_at, paid_at`.

**debts** (legacy, read-only for new code) — `id(UUID), whatsapp_number, debtor_name, amount(BIGINT
kobo), item, note, status, created_at, settled_at`.

**inventory** (legacy, being phased out — see Fix 4) — `id, user_id, item_name, current_balance,
total_received, unit_price, low_stock_threshold, last_updated`.

**pending_entries** — `id, user_id, entry_type, parsed_data(JSONB), original_message, status,
reminder_sent, created_at, confirmed_at, expires_at`. Confirm-before-commit staging table; currently only
wired to the legacy webhook path (see Kemi section).

**conversation_history / trader_facts / goals** — Kemi's memory tables, keyed by `whatsapp_number`
(not `user_id` — a known fragility, see Fix 6).

**stock_intelligence_mv** — materialized view, see Inventory section.

**whatsapp_messages** — every inbound/outbound message, with `whatsapp_message_id` UNIQUE-indexed for
dedup (Fix 5).

**ai_inference_log** — every Gemini parse/recommendation call, for future fine-tuning data.

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
│   ├── whatsapp.js         (outbound send — text only today, no media/template support yet)
│   ├── gemini.js           (email recommendation + voice transcription; parseWithAI is legacy/dead)
│   ├── claude.js           (Claude client used for the 6pm nudge coaching tip)
│   ├── email.js            (build + send emails via Brevo HTTP API)
│   ├── confirmationService.js (pending_entries YES/EDIT/CANCEL — legacy path only, see Kemi section)
│   ├── productService.js   (legacy-path product fuzzy-matching, stock alerts)
│   ├── inventory.js        (legacy inventory table operations)
│   ├── customers.js        (standalone customer-count logging)
│   ├── personaEngine.js    (business-persona-aware messaging)
│   ├── nudgeBuilder.js     (retention nudge copy)
│   ├── messageVariants.js  (A/B message variant tracking)
│   ├── learningService.js  (crowdsourced parse-correction learning)
│   ├── marketData.js
│   ├── stockExamples.js
│   ├── sheets.js           (dormant — Fix 3)
│   └── parser.js           (legacy rule-based parser — dead code pending removal)
├── models/
│   ├── db.js             (connection pool + initDb schema + MessageModel)
│   ├── user.js
│   ├── transaction.js
│   ├── product.js
│   ├── debtor.js          (canonical debt table)
│   ├── inventory.js       (legacy)
│   └── onboarding.js      (WhatsApp-native conversational registration sessions)
├── middleware/
│   └── auth.js            (session-cookie auth for the web dashboard/admin)
├── jobs/
│   ├── dailySummary.js     (6pm reminder + 7pm email summary + confirmation sweeps)
│   ├── morningCoaching.js  (7:30am stock briefing)
│   └── retentionNudge.js   (10am day 3/5/7/14 inactivity nudges)
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

- Google OAuth or Google Drive integration (removed — do not add back)
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
