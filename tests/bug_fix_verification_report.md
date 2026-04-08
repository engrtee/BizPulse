# BizPulse Bug Fix Verification Report
Date: Saturday, 5 April 2026
All fixes applied in commit: 9aa6bc3

---

## VERIFICATION RESULTS

| Fix | Description | Expected | Actual | Status |
|-----|------------|----------|--------|--------|
| Bug Fix 1 | AVG(margin) → correct SUM formula | 94.68% | 94.68% | **FIXED ✓** |
| Bug Fix 2 | Agreed income not counted as revenue | revenue=250000 | revenue=250000, pending_income in notes | **FIXED ✓** |
| Bug Fix 3 | "received iPhone" → inventory_in not revenue | inventory_in | inventory_in | **FIXED ✓** |
| Bug Fix 4 | Wholesale revenue without "sell" keyword | revenue=520000 | revenue=520000 | **FIXED ✓** |
| Warning 1 | parseAmount("1.5m") = 1,500,000 | 1500000 | 1500000 | **FIXED ✓** |
| Warning 2 | Inventory oversell sends WhatsApp warning | warn + clamp | warn fires when qty > balance | **FIXED ✓** |
| Warning 3 | Zero-entry check-in advances streak | streak++ | zero transaction created + streak updated | **FIXED ✓** |
| Warning 4 | Date uses WAT timezone not UTC | WAT date | Africa/Lagos timezone in all DB writes | **FIXED ✓** |

**All 8 fixes verified: YES**
**Ready for real users: YES**

---

## DETAILED RESULTS

### Fix 1 — AVG(margin) Critical Bug
**File:** `models/transaction.js` lines 52, 69, and `create()` date

**Before:**
```sql
COALESCE(AVG(margin), 0) AS margin
```

**After:**
```sql
CASE WHEN SUM(revenue) > 0
  THEN ROUND((SUM(profit) / SUM(revenue)) * 100, 2)
  ELSE 0
END AS margin
```

**Verification:**
- Amaka Day 1 scenario (4 entries: 43k, 27.7k, 0/4.8k, 19.5k)
- OLD AVG: 75.00% ← WRONG
- NEW margin: 94.68% ← CORRECT
- Result: **PASS ✓**

---

### Fix 2 — Agreed Income Not Counted as Revenue
**File:** `services/gemini.js` — parseWithAI prompt

**Test input:** "invoice client today MTN project proposal 250000 Zenith Bank branding meeting they agreed 180000 retainer monthly"

**Before:** `revenue: 430000` (incorrectly included the 180k retainer)

**After:** `revenue: 250000`, `notes: "pending_income: 180000 - Zenith Bank retainer agreed but not yet received"`

**Result: PASS ✓**

---

### Fix 3 — Inventory Receive Misclassified as Revenue
**File:** `services/gemini.js` — parseWithAI prompt

**Test input:** "received new stock iPhone 15 pro 5 units at 850000 each Samsung S24 3 units 620000 each"

**Before:** `type: "daily_entry"`, `revenue: 4,250,000` (treated as sales!)

**After:** `type: "inventory_in"` — correctly routed to inventory handler

**Result: PASS ✓**

---

### Fix 4 — Wholesale Revenue Without "Sell" Keyword
**File:** `services/gemini.js` — parseWithAI prompt

**Test input:** "peak milk 30 carton 7200 each = 216000 indomie 80 carton 3800 each = 304000"

**Before:** `revenue: 0` (not recognised as sales)

**After:** `revenue: 520000` (correctly identified as FMCG sales)

**Result: PASS ✓**

---

### Warning Fix 1 — parseAmount Millions
**File:** `utils/naira.js`

| Input | Before | After |
|-------|--------|-------|
| "1.5m" | 1.5 ❌ | 1,500,000 ✓ |
| "1m" | 1 ❌ | 1,000,000 ✓ |
| "2.5m" | 2.5 ❌ | 2,500,000 ✓ |
| "45k" | 45,000 ✓ | 45,000 ✓ |
| "₦850000" | 850,000 ✓ | 850,000 ✓ |

**Result: PASS ✓**

---

### Warning Fix 2 — Inventory Oversell Warning
**File:** `services/inventory.js`

**Before:** Silently clamped to 0 with no user notification.

**After:** When `requested_qty > current_balance`:
- Sends WhatsApp: "You only have X units of [item] in stock — you tried to sell Y. I've logged X units sold."
- Logs only what was available
- No negative inventory

**Result: PASS ✓**

---

### Warning Fix 3 — Zero Entry Streak Continuity
**File:** `routes/webhook.js`

**Before:** Greetings/check-ins without numbers → streak gap

**After:** Any message (including greetings/check-ins) now:
1. Creates a zero-revenue transaction
2. Calls `touchLastEntry()` to update streak
3. Sends "📅 Check-in logged — Day X streak" confirmation

**Result: PASS ✓**

---

### Warning Fix 4 — WAT Timezone Date Alignment
**Files:** `models/db.js`, `models/transaction.js`, `models/user.js`

**Before:** `DEFAULT CURRENT_DATE` (PostgreSQL UTC)

**After:** `DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE`

This eliminates the bug where entries made at 11pm–midnight WAT (10pm–11pm UTC) were saved with tomorrow's date.

**Result: PASS ✓**

---

## WHAT WAS NOT CHANGED (as instructed)
- Entry aggregation INSERT-only rule — untouched ✓
- WhatsApp webhook routing logic — untouched ✓  
- Cron job schedules — untouched ✓
- Registration and login flow — untouched ✓
- Database schema structure — only DEFAULT value changed ✓
- Frontend HTML/CSS — untouched ✓
- Colour scheme and UI — untouched ✓
- The 69 tests that already passed — all still pass ✓

---

## PRE-LAUNCH REMAINING ITEMS (low priority, no blocker)
These were documented in the stress test but are not critical for launch:

1. **Duplicate detection** — same message twice in 5 mins logs twice (low risk for real users)
2. **Large number sanity check** — ₦1B accepted without confirmation (unlikely in practice)

*Generated by BizPulse Stress Test v1.0 | 5 April 2026*
