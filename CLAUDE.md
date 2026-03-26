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
- Simple enough for a market trader who currently uses a notebook
- Powerful enough to eventually replace an accountant

---

## THE FOUNDER

**Name:** Tosin Ilesanmi
**Background:** Data professional, analytics core domain, developing data engineering skills
**Company:** The Tosin Ilesanmi Data Academy (CAC registered)
**Product:** BizPulse
**Location:** Nigeria
**Stage:** Phase 1 build — first real users being onboarded

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
- Always use toLocaleString() for formatting: ₦1,200,000 not ₦1200000
- Never use $ or other currencies

**AI recommendations must:**
- Reference Nigerian business context specifically
- Mention actual numbers from the user's entry — never give generic advice
- Reference the user's specific business type
- Use plain English — no accounting jargon
- Be actionable within a Nigerian market context
- Be warm and personal in tone

**Example of BAD AI recommendation (generic — never do this):**
"Monitor your expense categories closely to protect your profit margin."

**Example of GOOD AI recommendation (specific — always do this):**
"Your staff wages at ₦1,000,000 represent 21.9% of today's revenue for a Services business.
This is within normal range — but consider whether all staff hours directly generate revenue
or if any tasks can be automated to reduce this cost."

---

## CRITICAL PRESERVED FIXES — DO NOT TOUCH

These fixes were implemented after bugs were discovered. They must NEVER be reverted.

### FIX 1 — Entry Aggregation (MOST CRITICAL)
**Problem fixed:** New WhatsApp entries were overwriting existing records instead of adding to them.
**Fix applied:** Every new entry INSERTS a new row. Nothing is ever overwritten or deleted.
**Rule:** NEVER change the transaction save/insert logic. NEVER use UPDATE where INSERT should be used.
**Before touching any backend save function:** Show the current function first and confirm understanding.

### FIX 2 — Margin Calculation
**Correct formula:** margin = ((revenue - expenses) / revenue) * 100
**If revenue = 0:** margin = 0
**Positive margin = profitable. Negative = loss-making.**
**Never calculate margin any other way.**

### FIX 3 — No Google Drive / No Google Sheets
**Decision made:** Google Drive and Google OAuth were removed entirely.
**Reason:** Too much friction for low-tech Nigerian users. OAuth flow kills registration completion.
**Data storage:** PostgreSQL on Render only.
**Data ownership:** Users export their data via CSV download endpoint.
**DO NOT:** Add Google OAuth, Google Sheets API, or Google Drive back under any circumstances.

---

## TECHNICAL ARCHITECTURE

**Stack:**
- Backend: Node.js + Express on Render.com
- Database: PostgreSQL on Render (managed)
- AI: Google Gemini 2.0 Flash (gemini-2.0-flash)
- WhatsApp: Meta WhatsApp Business Cloud API
- Email: Brevo HTTP API (axios POST to api.brevo.com — NOT nodemailer/Gmail)
- Frontend: Single HTML file served by Express from /public (NOT Netlify)
- Scheduler: node-cron for daily 7pm WAT summary + 10am WAT retention nudge + 6pm WAT reminder

**Folder structure:**
```
bizpulse/
├── server.js
├── package.json
├── .env
├── .env.example
├── CLAUDE.md
├── README.md
├── routes/
│   ├── webhook.js      (WhatsApp webhook)
│   ├── auth.js         (registration/login)
│   ├── api.js          (frontend API endpoints)
│   ├── email.js        (on-demand summary email trigger)
│   └── admin.js        (password-protected admin dashboard at /admin)
├── services/
│   ├── whatsapp.js     (send/receive + milestone messages)
│   ├── gemini.js       (AI parsing + recommendations — gemini-2.0-flash)
│   ├── email.js        (build + send emails via Brevo HTTP API)
│   ├── parser.js       (parse message types)
│   ├── inventory.js    (stock tracking)
│   └── customers.js    (customer tracking)
├── models/
│   ├── db.js           (PostgreSQL connection)
│   ├── user.js         (user queries incl. admin stats + retention)
│   ├── transaction.js  (transaction queries)
│   └── inventory.js    (inventory queries with dynamic 20% threshold)
├── jobs/
│   ├── dailySummary.js (7pm WAT summary email + 6pm WAT reminder)
│   └── retentionNudge.js (10am WAT nudges at day 3/5/7/14 inactivity)
├── utils/
│   ├── formatter.js    (₦ formatting, dates, health score)
│   └── naira.js        (currency helpers)
└── public/
    └── index.html      (complete frontend — served by Express)
```

**Environment variables:**
```
WHATSAPP_PHONE_NUMBER_ID=     # From Meta dashboard
WHATSAPP_TOKEN=               # Regenerate daily until Meta verified
WHATSAPP_VERIFY_TOKEN=bizpulse_webhook_2026
BIZPULSE_NUMBER=              # Dedicated SIM number
GEMINI_API_KEY=               # From Google AI Studio
DATABASE_URL=                 # From Render PostgreSQL (Supabase connection string)
BREVO_API_KEY=                # From Brevo dashboard — used for transactional emails
BREVO_FROM_EMAIL=             # Verified sender email in Brevo
BASE_URL=                     # Render deployment URL
PORT=3000
NODE_ENV=production
ADMIN_PASSWORD=               # For /admin dashboard (password-protected)
```

**DO NOT use:** GMAIL_USER, GMAIL_APP_PASSWORD, nodemailer — all email goes through Brevo HTTP API.

---

## WHATSAPP MESSAGE TYPES

Every message type is a separate service module. Adding new message types in Phase 2
must not require changes to existing Phase 1 message handlers.

**Supported messages:**
1. Daily sales + expenses: "sales 45000 rent 5000 stock 12000"
2. Inventory received: "received 50 bags rice at 900 each"
3. Inventory sold: "sold 12 bags rice today"
4. Stock check: "stock?" or "inventory?"
5. On-demand summary: "summary" or "report"
6. Help: "help" or "?"
7. Customer count: "customers 15" or "served 20 people today"

**Instant WhatsApp reply format after daily entry:**
```
✅ Logged [First Name]! 🔥 Day [X] streak

Revenue:   ₦45,000
Expenses:  ₦26,000
Profit:    ₦19,000
Margin:    42.2%

Customers today: 12
Top expense: Stock / Inventory

Your full summary hits your inbox at 7pm 🎯
```

**Milestone celebration messages:**
- Day 1: "🎉 Welcome! Your BizPulse journey starts today."
- Day 7 streak: "🔥 One week strong! You're building a powerful habit."
- Day 30 streak: "📊 One month of data! You can now see real trends."
- Day 100 streak: "🏆 100 days! You're a data champion."
- First profitable day: "💰 Profitable day! Keep it going."
- 10th entry: "📈 10 entries logged! Your data is starting to tell a story."

**Retention nudge messages (automated):**
- Day 3 no entry: "Hi [Name] 👋 How did business go today? Just send your numbers and I'll handle the rest."
- Day 5 no entry: "Hey [Name], your last summary was 5 days ago. Even a quick message keeps your streak going 📊"
- Day 7 no entry: "[Name], I haven't heard from you in a week. Everything okay? I'm here when you're ready."
- Day 14 no entry: "[Name], your BizPulse account is still active. Businesses that track consistently are 3x more likely to spot problems early. Ready to start again?"

---

## INVENTORY CALCULATIONS — EXACT RULES

**Stock in:**
- Message: "received 50 bags rice at 900 each"
- stock_in = 50 units
- total_value = 50 × 900 = ₦45,000
- current_balance increases by 50
- total_ever_received increases by 50

**Stock out:**
- Message: "sold 12 bags rice today"
- stock_out = 12 units
- current_balance decreases by 12
- If current_balance would go below 0: set to 0

**Low stock alert threshold:**
- Trigger when: current_balance < 20% of total_ever_received
- Example: received 50 total, balance now 9 → 9/50 = 18% → ALERT
- Alert type: Low Stock (yellow warning)

**Out of stock alert:**
- Trigger when: current_balance = 0
- Alert type: Out of Stock (red — more urgent than low stock)
- Different message from low stock alert

**Verification test (run to confirm correctness):**
```
Start: 0 units
Receive 50 → balance: 50, low stock: NO
Sell 12 → balance: 38, low stock: NO (38/50 = 76%)
Sell 28 → balance: 10, low stock: NO (10/50 = 20% — exactly at threshold)
Sell 1 → balance: 9, low stock: YES (9/50 = 18% — below threshold)
Sell 9 → balance: 0, out of stock: YES
```

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
- Show on every WhatsApp reply
- Show prominently on Home page banner
- Show on Summary page (below health badge — not next to it)
- Special celebration messages at 7, 14, 30, 60, 100 days
- Never show streak on Settings page

### Admin Dashboard (/admin — password protected)
Must always show:
- Total registered users
- Activated (sent at least 1 message)
- Active this week (message in last 7 days)
- At risk (no message in 5-14 days) — these need nudges
- Churned (no message in 14+ days)
- Average messages per user per week
- Daily new registrations

### Automated Retention Jobs
Two cron jobs must exist:
1. dailySummary.js — 7pm WAT every day
2. retentionNudge.js — runs daily, checks inactive users,
   sends WhatsApp nudges at day 3, 5, 7, 14 of inactivity

---

## DATABASE — KEY FIELDS

**Users table must include:**
```sql
id, name, email, biz_name, biz_type, state,
whatsapp_number, created_at, active,
first_message_date,    -- activation tracking
last_message_date,     -- recency tracking
total_messages_sent,   -- engagement depth
streak,                -- consecutive days (retention mechanic)
referred_by            -- referral tracking
```

**Transactions table:**
```sql
id, user_id, date, revenue, total_expenses,
expense_breakdown (JSON), profit, margin,
customers, notes, biz_type, created_at
```
**RULE:** Always INSERT new rows. Never UPDATE existing transaction rows.

**Inventory table:**
```sql
id, user_id, item_name, current_balance,
total_received,      -- total ever received (for 20% threshold)
unit_price,
low_stock_threshold, last_updated
```

---

## PHASE BOUNDARIES

### Phase 1 — CURRENT BUILD (build this, nothing more)
- WhatsApp daily entry (sales + expenses + customers)
- Inventory tracking (stock in/out/check)
- Daily 7pm email summary with AI recommendation
- On-demand summary via WhatsApp or web button
- Web dashboard (Home, Daily Entry, Summary, Settings)
- Admin analytics dashboard
- Streak tracking and milestone celebrations
- Retention nudge system (day 3/5/7/14)
- CSV data export endpoint

### Phase 2 — DO NOT BUILD YET
- Debtor and creditor tracking via WhatsApp
- Weekly and monthly trend charts
- Multi-language support (Pidgin, Yoruba, Hausa)
- Referral programme with rewards
- Monthly business review email (Wrapped-style)

### Phase 3 — DO NOT BUILD YET
- Loan-ready financial statements (PDF export)
- Tax compliance summary (VAT/FIRS format)
- Business health score (0-100)
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
- Push notifications (not supported in current stack)
- Native mobile app (web app only for now)
- Payment processing (not in Phase 1)

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
ask these five questions in order:

**1. Does the tired market trader understand it?**
If a notebook-using fashion trader in Oshodi cannot figure it out at 8pm — simplify it.

**2. Does it help users know if they made money today?**
That is the core question every user is asking. Does this decision help answer it?

**3. Does it work on a phone?**
Test on 375px. If it does not work on mobile it does not exist.

**4. Does it protect the data aggregation fix?**
Any change to transaction saving logic must preserve the INSERT-only rule.

**5. Is it Phase 1?**
If it is not in the Phase 1 list above — do not build it. Note it for Phase 2.

---

## CURRENT STATUS (as of March 2026)

**What is working:**
- WhatsApp webhook receiving and responding to messages
- Daily entry saving to PostgreSQL (INSERT-only — never UPDATE)
- Streak tracking updating correctly on every entry
- WhatsApp ACK with streak in header, top expense, separate margin line
- Milestone celebration messages (Day 1, Day 7/30/100 streak, 10th entry, first profit)
- Dashboard showing revenue, profit, top expense, customers
- Summary page with AI recommendation, CSS expense bar charts,
  month comparison, entry history, inventory status
- Low stock alerts with dynamic 20% threshold (based on total_ever_received)
- Out-of-stock WhatsApp alert (instant on sell)
- Settings page with WhatsApp commands reference
- Data quality card on Settings page
- Email via Brevo HTTP API (port 443 — works on Render free tier)
- On-demand "Send Summary Now" button with fallback to latest date
- AI recommendation using actual business numbers (not generic advice)
- AI recommendation generated immediately after web entry submission
- CSV data export endpoint
- Admin dashboard at /admin (password-protected, shows funnel + 7 metrics)
- Retention nudge cron (day 3/5/7/14 inactivity via WhatsApp)
- Mobile bottom navigation (navy background, active blue top border)
- Home page: greeting + streak, 4 metrics, profit sentence, AI preview, last 5 days
- Gemini 2.0 Flash model for AI parsing and recommendations

**Meta WhatsApp status:**
- Test number working
- Token expires every 24 hours — must regenerate daily in Render env vars
- Meta Business verification in progress (using The Tosin Ilesanmi Data Academy CAC)
- Can add up to 5 test recipient numbers manually in Meta dashboard
- Full public launch blocked until Meta verification approved

**Meta WhatsApp status:**
- Test number working
- Token expires every 24 hours — must regenerate daily
- Meta Business verification in progress
- Using The Tosin Ilesanmi Data Academy CAC for verification
- Can add up to 5 test recipient numbers manually
- Full public launch blocked until Meta verification approved

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
