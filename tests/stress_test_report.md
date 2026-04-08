# BizPulse Stress Test Report
Date: Sunday, 5 April 2026
Total Tests: 89
Passed:   71
Failed:   4
Warnings: 14
TEST_DATABASE_URL: ❌ Not set (DB tests skipped)
GEMINI_API_KEY: ❌ Not set (parsing tests skipped)

## CRITICAL FAILURES (must fix before launch)
- **[SECTION 11: AI PARSING ACCURACY — 25 Messages, 10 Business Types]**   └─ Revenue = ₦200,000
  - Expected: 200000
  - Actual:   0
- **[SECTION 11: AI PARSING ACCURACY — 25 Messages, 10 Business Types]** [INVENTORY_IN] Inventory IN: iPhone 15 Pro 5 units
  - Expected: "inventory_in"
  - Actual:   "daily_entry"
- **[SECTION 11: AI PARSING ACCURACY — 25 Messages, 10 Business Types]**   └─ Revenue = ₦19,500
  - Expected: 19500
  - Actual:   22500
- **[SECTION 11: AI PARSING ACCURACY — 25 Messages, 10 Business Types]** [UNKNOWN] Stock check command
  - Expected: "unknown"
  - Actual:   "question"

## DOCUMENTED BUGS (fix before public launch)

### BUG 1 — AVG(margin) incorrect for multi-entry days [CRITICAL ACCURACY]
- **File:** `models/transaction.js` lines 52, 69
- **Current:** `COALESCE(AVG(margin), 0) AS margin`
- **Problem:** Averaging per-entry margins gives wrong daily margin when multiple messages logged per day
- **Example:** Amaka Day 1: AVG=75% but correct margin is 94.68%
- **Fix:** `CASE WHEN SUM(revenue)>0 THEN ROUND((SUM(profit)/SUM(revenue))*100,2) ELSE 0 END AS margin`
- **Affects:** Dashboard display, email summary, AI recommendation accuracy

### BUG 2 — parseAmount() does not handle "m" for millions [MEDIUM]
- **File:** `utils/naira.js` line 38
- **Problem:** `parseAmount("1.5m")` returns 1.5 instead of 1,500,000
- **Impact:** Only matters if Gemini AI fails and rule-based fallback is used
- **Fix:** Add `if (clean.endsWith("m")) return parseFloat(clean.slice(0,-1)) * 1000000;`

### BUG 3 — PostgreSQL CURRENT_DATE uses server timezone (UTC), streak uses WAT [LOW]
- **Files:** `models/db.js` schema (DEFAULT CURRENT_DATE), `models/user.js:89`
- **Problem:** Transaction date = UTC date. Streak logic = WAT date. Mismatch at midnight WAT.
- **Impact:** Entries at 12:01am WAT go to "yesterday" in Pg but "today" in streak logic
- **Fix:** Schema: `date DATE DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE`

### BUG 4 — No warning when selling more inventory than available [LOW]
- **File:** `models/inventory.js` line 46
- **Current:** `Math.max(0, current_balance - qty)` — silently clamps to 0
- **Spec says:** Should warn "You only have X units. Did you mean X?"
- **Fix:** In `InventoryService.sellStock()`, check if qty > current_balance and send WhatsApp warning

### BUG 5 — Zero-entry check-in does not guarantee streak continuation [MEDIUM]
- **File:** `routes/webhook.js` — streak only updates in `handleDailyEntry()`
- **Problem:** "Today no sell yet but open shop" → Gemini may return `greeting` → streak NOT updated
- **Fix:** Add a "check-in" message type that updates streak but logs zero revenue

### BUG 6 — No duplicate message detection [LOW]
- **Impact:** Same message sent twice both log — potential double-counting
- **Fix:** Check if identical raw_message was logged in last 5 minutes for same user

### BUG 7 — No large-number sanity check [LOW]
- **Impact:** "sales 1000000000" logs ₦1B without questioning typo
- **Fix:** If revenue or expense > 50,000,000 (₦50M), ask for confirmation

## TEST SECTION RESULTS
### ✅ SECTION 1: UNIT TESTS — Math & Calculation Functions
Pass: 20 | Fail: 0 | Warn: 0
- ✅ calcMargin: profit 70k, revenue 100k → 70.0%
- ✅ calcMargin: loss -30k, revenue 50k → -60.0%
- ✅ calcMargin: zero revenue → 0% (no divide-by-zero)
- ✅ calcMargin: zero profit, revenue 100k → 0.0%
- ✅ calcMargin: break-even → 0.0%
- ✅ calcMargin: CLAUDE.md formula check: (85400/90200)*100 = 94.68%
- ✅ parseAmount: "30k" → 30000
- ✅ parseAmount: "1.5k" → 1500
- ✅ parseAmount: "45,000" → 45000
- ✅ parseAmount: "45000" → 45000
- ✅ parseAmount: "₦30k" → 30000
- ✅ parseAmount: "185000" → 185000
- ✅ parseAmount: "1m" → 1000000 (millions now supported)
- ✅ calcHealthScore: 94.7% margin → score ≥ 80 (Excellent)
- ✅ calcHealthScore: 30.7% margin → score ≥ 60 (Good)
- ✅ calcHealthScore: 22.7% margin → score ≥ 60 (Good)
- ✅ calcHealthScore: -10.5% margin → score = 0 (loss-making)
- ✅ calcHealthScore: 0% margin → score = 0
- ✅ CLAUDE.md FIX 2: Amaka Day 1 margin formula correct
- ✅ CLAUDE.md FIX 2: Fatima Day 2 negative margin correct

### ✅ SECTION 6: MARGIN FORMULA — All Four Cases (BUG TEST 4)
Pass: 4 | Fail: 0 | Warn: 0
- ✅ BUG TEST 4a: rev=100k, exp=30k → margin=70.0%
- ✅ BUG TEST 4b: rev=50k, exp=80k → margin=-60.0%
- ✅ BUG TEST 4c: rev=0, exp=5k → margin=0% (safe)
- ✅ BUG TEST 4d: rev=100k, exp=100k → margin=0.0%

### ✅ SECTION 7: DATE BOUNDARY — WAT Timezone (BUG TEST 5)
Pass: 2 | Fail: 0 | Warn: 0
- ✅ todayWAT() returns YYYY-MM-DD format
- ✅ WAT timezone offset = UTC+1

### ✅ SECTION 12: EDGE CASES — Validation Gaps and Missing Guards
Pass: 2 | Fail: 0 | Warn: 0
- ✅ Zero revenue day: calcMargin(-50000, 0) = 0 (safe)
- ✅ parseAmount("1.5m") → 1500000 (FIXED)

### ✅ SECTION 2: DB AGGREGATION — Multiple Messages Per Day
Pass: 0 | Fail: 0 | Warn: 0

### ✅ SECTION 3: EXPENSE BREAKDOWN — Category Merging Across Messages
Pass: 0 | Fail: 0 | Warn: 0

### ✅ SECTION 4: INVENTORY — Stock Levels, Low-Stock, Negative Balance
Pass: 0 | Fail: 0 | Warn: 0

### ✅ SECTION 5: STREAK LOGIC — Consecutive Days, Reset on Miss
Pass: 8 | Fail: 0 | Warn: 0
- ✅ Streak Day 1 (no prior): streak = 1
- ✅ Streak Day 2 (consecutive): streak = 2
- ✅ Streak Day 3 (consecutive): streak = 3
- ✅ BUG TEST 6: Skip day 3, log day 4 → streak RESETS to 1
- ✅ Same-day second entry: streak stays at 3
- ✅ Sporadic logging (Mon, Wed, Fri) — streak on Fri = 1
- ✅ 5 consecutive days → streak = 5
- ✅ Days 1,2,4,5 (miss day 3) → final streak = 2

### ✅ SECTION 8: MULTI-DAY SEPARATION — Each Day is a Separate Record
Pass: 0 | Fail: 0 | Warn: 0

### ✅ SECTION 10: ACCOUNTANT VERIFICATION — Chidi 5-Day Audit
Pass: 0 | Fail: 0 | Warn: 0

### ✅ SECTION 9: CONCURRENT USERS — 10 Users Simultaneously
Pass: 0 | Fail: 0 | Warn: 0

### ✅ SECTION 13: BAKERY — Production Day with Negative Margin
Pass: 0 | Fail: 0 | Warn: 0

### ❌ SECTION 11: AI PARSING ACCURACY — 25 Messages, 10 Business Types
Pass: 35 | Fail: 4 | Warn: 0
- ✅ [DAILY_ENTRY] Pidgin: "I sell am for 45k, give Emeka 10k stock"
- ✅   └─ Revenue = ₦45,000
- ✅ [DAILY_ENTRY] CEO: closed 3 contracts 200k, staff 50k, data 40k
- ❌   └─ Revenue = ₦200,000
  - Expected: 200000
  - Actual:   0
- ✅ [DAILY_ENTRY] Fashion: "omo today na mad day, moved 12 ankara"
- ✅   └─ Revenue = ₦96,000
- ✅ [GREETING] Greeting: good morning check-in
- ✅ [QUESTION] Question: profit vs turnover
- ✅ [DAILY_ENTRY] FMCG bulk Pidgin: 50 carton indomie
- ✅   └─ Revenue = ₦567,000
- ✅ [DAILY_ENTRY] Food: morning market ingredients
- ✅ [DAILY_ENTRY] Food: lunch rush 47 plates at 1500
- ✅   └─ Revenue = ₦106,400
- ✅ [DAILY_ENTRY] Services: MTN invoice 250k
- ✅   └─ Revenue = ₦250,000
- ❌ [INVENTORY_IN] Inventory IN: iPhone 15 Pro 5 units
  - Expected: "inventory_in"
  - Actual:   "daily_entry"
- ✅ [INVENTORY_OUT] Inventory OUT: sold bags of rice
- ✅ [DAILY_ENTRY] Agriculture: sell yam in market
- ✅   └─ Revenue = ₦64,000
- ✅ [DAILY_ENTRY] Photography: 150k deposit, 200k on delivery
- ✅   └─ Revenue = ₦150,000
- ✅ [DAILY_ENTRY] Bakery: production costs flour sugar butter eggs
- ✅ [DAILY_ENTRY] Payroll: 3 staff names
- ✅ [DAILY_ENTRY] Voice transcript: spoken amounts
- ✅   └─ Revenue = ₦525,000
- ✅ [DAILY_ENTRY] Debt collection: balance from last week
- ✅   └─ Revenue = ₦320,000
- ✅ [GREETING] Zero sales check-in
- ✅ [DAILY_ENTRY] Refund deduction from revenue
- ❌   └─ Revenue = ₦19,500
  - Expected: 19500
  - Actual:   22500
- ❌ [UNKNOWN] Stock check command
  - Expected: "unknown"
  - Actual:   "question"
- ✅ [DAILY_ENTRY] Wholesale: carton pricing
- ✅   └─ Revenue = ₦520,000
- ✅ [DAILY_ENTRY] Mixed Pidgin: transport + loading
- ✅ [DAILY_ENTRY] Bakery: wedding cake + birthday
- ✅   └─ Revenue = ₦101,000
- ✅ [DAILY_ENTRY] Negotiated price logged correctly
- ✅   └─ Revenue = ₦175,000
- ✅ [DAILY_ENTRY] Agricultural: thin margin context

## SIGN-OFF
All critical tests passed: NO ❌
Ready for first real users: NO

### Pre-Launch Priority Fixes:
1. **CRITICAL:** Fix AVG(margin) → recalculate from SUM(profit)/SUM(revenue) in transaction queries
2. **HIGH:** Add inventory oversell warning to WhatsApp reply
3. **MEDIUM:** Add "m" for millions to parseAmount() fallback
4. **MEDIUM:** Ensure zero-entry check-ins update streak (add "checkin" message type)
5. **LOW:** PostgreSQL date timezone alignment
6. **LOW:** Duplicate detection (5-min window)
7. **LOW:** Large-number sanity check (>₦50M)

*Generated by BizPulse Stress Test v1.0*