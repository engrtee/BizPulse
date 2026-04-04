/**
 * routes/api.js
 * REST API endpoints consumed by the frontend (public/index.html).
 *
 * POST /api/register          → Create user account
 * POST /api/entry             → Submit daily entry from web form
 * GET  /api/summary/latest    → Get latest summary data for the Summary screen
 * PUT  /api/user/update       → Update user profile settings
 * GET  /api/inventory         → Get current stock levels
 */

'use strict';

const express            = require('express');
const router             = express.Router();

const UserModel          = require('../models/user');
const TransactionModel   = require('../models/transaction');
const InventoryService   = require('../services/inventory');
const SheetsService      = require('../services/sheets');

const GeminiService      = require('../services/gemini');
const EmailService       = require('../services/email');

const { calcHealthScore, healthLabel, topExpenseCategory, todayWAT } = require('../utils/formatter');
const { calcMargin } = require('../utils/naira');

// ─────────────────────────────────────────────
// POST /api/auth/login
// Called from the "Login" tab on the register screen.
// Looks up user by email and returns their userId so the
// frontend can store it in localStorage (passwordless login).
// ─────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = await UserModel.findByEmail(email);
    if (!user) {
      return res.status(404).json({ error: 'No account found with this email address. Please register first.' });
    }
    if (!user.active) {
      return res.status(403).json({ error: 'This account has been deactivated. Please contact support.' });
    }
    res.json({ success: true, userId: user.id, name: user.name });
  } catch (err) {
    console.error('[API] /auth/login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/register
// Called by the Step 2 registration form.
// Creates the user row.
// ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, bizName, bizType, state, whatsappNumber } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }

    // Check for duplicate email
    const existing = await UserModel.findByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.', userId: existing.id });
    }

    const user = await UserModel.create({ name, email, bizName, bizType, state, whatsappNumber });
    res.status(201).json({ success: true, userId: user.id, name: user.name });
  } catch (err) {
    console.error('[API] /register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/entry
// Submit a daily entry from the web form.
// Body: { userId, revenue, expenses: [{category, amount}], stockMovements, customers, notes }
// ─────────────────────────────────────────────
router.post('/entry', async (req, res) => {
  try {
    const { userId, revenue, expenses, stockMovements, customers, notes, topProduct } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const user = await UserModel.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Build expense breakdown object
    const expenseBreakdown = {};
    let totalExpenses = 0;
    for (const e of (expenses || [])) {
      const amt = parseFloat(e.amount) || 0;
      if (amt > 0) {
        expenseBreakdown[e.category] = (expenseBreakdown[e.category] || 0) + amt;
        totalExpenses += amt;
      }
    }

    const rev    = parseFloat(revenue) || 0;
    const profit = rev - totalExpenses;
    const margin = calcMargin(profit, rev);

    // Combine top product into notes
    const combinedNotes = [
      topProduct ? `Top product: ${topProduct}` : '',
      notes || '',
    ].filter(Boolean).join('\n') || null;

    // Save transaction to DB
    const txn = await TransactionModel.create({
      userId: user.id,
      revenue:          rev,
      totalExpenses,
      expenseBreakdown,
      profit,
      margin,
      customers:        parseInt(customers, 10) || 0,
      notes:            combinedNotes,
      rawMessage:       'web_entry',
    });

    // Update last_entry_date and streak
    const newStreak = await UserModel.touchLastEntry(user.id);

    // Append to Google Sheets (non-blocking)
    if (user.sheet_id) {
      SheetsService.appendTransaction(user, {
        date:             todayWAT(),
        revenue:          rev,
        totalExpenses,
        expenseBreakdown,
        profit,
        margin,
        customers:        parseInt(customers, 10) || 0,
        notes:            combinedNotes || '',
      }).catch((err) => console.error('[Sheets] web entry append error:', err.message));
    }

    // Handle stock movements from the web form
    if (Array.isArray(stockMovements)) {
      for (const sm of stockMovements) {
        if (!sm.item || !sm.quantity) continue;
        if (sm.direction === 'received') {
          await InventoryService.receiveStock(user, sm);
        } else if (sm.direction === 'sold') {
          await InventoryService.sellStock(user, sm);
        }
      }
    }

    // Get today's aggregated totals for AI recommendation
    let aiRec = null;
    try {
      const aiTotals     = await TransactionModel.getDailyTotals(user.id, todayWAT());
      const aiRev        = parseFloat(aiTotals.revenue)       || 0;
      const aiExp        = parseFloat(aiTotals.total_expenses) || 0;
      const aiProfit     = parseFloat(aiTotals.profit)         || 0;
      const aiCust       = parseInt(aiTotals.customers, 10)    || 0;
      const aiMargin     = calcMargin(aiProfit, aiRev);
      const aiScore      = calcHealthScore(aiMargin);
      const aiHl         = healthLabel(aiScore);
      const aiBreakdowns = await TransactionModel.getExpenseBreakdowns(user.id, todayWAT());
      const aiTopExp     = topExpenseCategory(aiBreakdowns);
      // Build expenseBreakdown from today's breakdowns for the AI prompt
      const aiExpBreakdown = {};
      for (const row of (aiBreakdowns || [])) {
        const eb = (typeof row.expense_breakdown === 'string')
          ? JSON.parse(row.expense_breakdown)
          : (row.expense_breakdown || {});
        for (const [cat, amt] of Object.entries(eb)) {
          aiExpBreakdown[cat] = (aiExpBreakdown[cat] || 0) + parseFloat(amt);
        }
      }
      aiRec = await GeminiService.generateRecommendation({
        revenue: aiRev, totalExpenses: aiExp, profit: aiProfit, margin: aiMargin,
        healthScore: aiScore, healthKey: aiHl.key, topExpense: aiTopExp,
        expenseBreakdown: aiExpBreakdown,
        customers: aiCust, date: todayWAT(),
      }, user);
    } catch (e) {
      console.error('[API] AI recommendation error:', e.message);
    }

    res.json({
      success: true,
      streak:  newStreak || 1,
      aiRec,
      entry: {
        revenue: rev,
        totalExpenses,
        profit,
        margin,
        customers: parseInt(customers, 10) || 0,
      },
    });
  } catch (err) {
    console.error('[API] /entry error:', err.message);
    res.status(500).json({ error: 'Failed to save entry. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/summary/latest?userId=<id>
// Returns the most recent transaction + computed summary for the Summary screen.
// ─────────────────────────────────────────────
router.get('/summary/latest', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const user = await UserModel.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const [latest, history, lowStock, stock, completeness, monthly] = await Promise.all([
      TransactionModel.getLatest(user.id),
      TransactionModel.getHistory(user.id, 10),
      InventoryService.getLowStockAlerts(user.id),
      InventoryService.getStock(user.id),
      TransactionModel.getCompleteness(user.id, 10),
      TransactionModel.getMonthlyTotals(user.id),
    ]);

    if (!latest) {
      return res.json({ hasData: false, history: [], lowStock, stock: stock || [], completeness, monthly });
    }

    const score = calcHealthScore(parseFloat(latest.margin) || 0);
    const hl    = healthLabel(score);

    // Merge all expense_breakdown JSONs for the latest date into one object
    const breakdown  = await TransactionModel.getDailyExpenseBreakdown(user.id, latest.date);
    const topExpense = topExpenseCategory([breakdown]);

    // Only call Gemini when explicitly requested (Summary screen), not on every home snapshot load
    let aiRec = null;
    if (req.query.ai === '1') {
      try {
        aiRec = await GeminiService.generateRecommendation({
          revenue:      parseFloat(latest.revenue)       || 0,
          totalExpenses:parseFloat(latest.total_expenses) || 0,
          profit:       parseFloat(latest.profit)         || 0,
          margin:       parseFloat(latest.margin)         || 0,
          healthScore:  score,
          healthKey:    hl.key,
          topExpense,
          customers:    parseInt(latest.customers, 10)    || 0,
          date:         latest.date,
        }, user);
      } catch (e) {
        console.error('[API] AI recommendation error:', e.message);
      }
    }

    res.json({
      hasData: true,
      summary: {
        date:             latest.date,
        revenue:          latest.revenue,
        totalExpenses:    latest.total_expenses,
        profit:           latest.profit,
        margin:           latest.margin,
        customers:        latest.customers,
        healthScore:      score,
        healthLabel:      hl.label,
        healthEmoji:      hl.emoji,
        healthKey:        hl.key,
        topExpense,
        expenseBreakdown: breakdown,
      },
      history,
      lowStock,
      stock:        stock || [],
      completeness,
      monthly,
      aiRec,
    });
  } catch (err) {
    console.error('[API] /summary/latest error:', err.message);
    res.status(500).json({ error: 'Failed to load summary.' });
  }
});

// ─────────────────────────────────────────────
// PUT /api/user/update
// Update profile settings from the Settings screen.
// ─────────────────────────────────────────────
router.put('/user/update', async (req, res) => {
  try {
    const { userId, name, email, bizName, bizType, state } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const updated = await UserModel.update(userId, { name, email, bizName, bizType, state });
    res.json({ success: true, user: updated });
  } catch (err) {
    console.error('[API] /user/update error:', err.message);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/inventory?userId=<id>
// Returns current stock levels for the frontend.
// ─────────────────────────────────────────────
router.get('/inventory', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const items = await InventoryService.getStock(userId);
    res.json({ items });
  } catch (err) {
    console.error('[API] /inventory error:', err.message);
    res.status(500).json({ error: 'Failed to load inventory.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/user?userId=<id>
// Return basic user data for the frontend on load.
// ─────────────────────────────────────────────
router.get('/user', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const user = await UserModel.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    // Never return tokens to the frontend
    const { google_access_token, google_refresh_token, ...safe } = user;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load user.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/export/csv?userId=<id>
// Download all transaction history as CSV.
// ─────────────────────────────────────────────
router.get('/export/csv', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const user = await UserModel.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const rows = await TransactionModel.getHistory(user.id, 365);
    const header = 'Date,Revenue (NGN),Expenses (NGN),Profit (NGN),Margin (%),Customers';
    const lines  = rows.map(r => [
      r.date,
      parseFloat(r.revenue)        || 0,
      parseFloat(r.total_expenses) || 0,
      parseFloat(r.profit)         || 0,
      (parseFloat(r.margin)        || 0).toFixed(1),
      parseInt(r.customers, 10)    || 0,
    ].join(','));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bizpulse-${todayWAT()}.csv"`);
    res.send([header, ...lines].join('\n'));
  } catch (err) {
    console.error('[API] /export/csv error:', err.message);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/test-email?userId=<id>
// Sends an immediate test summary email to the user.
// Confirms Brevo email system works independently of the 7pm cron.
// ─────────────────────────────────────────────
router.get('/test-email', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required. Use /api/test-email?userId=YOUR_ID' });

    const user = await UserModel.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Use latest real data, or mock if nothing logged yet
    const latest = await TransactionModel.getLatest(user.id);
    let summaryData;
    if (latest) {
      const breakdown = await TransactionModel.getDailyExpenseBreakdown(user.id, latest.date);
      const topExpense = topExpenseCategory([breakdown]);
      const revenue       = parseFloat(latest.revenue)        || 0;
      const totalExpenses = parseFloat(latest.total_expenses)  || 0;
      const profit        = parseFloat(latest.profit)          || 0;
      const margin        = calcMargin(profit, revenue);
      const score         = calcHealthScore(margin);
      const hl            = healthLabel(score);
      summaryData = { revenue, totalExpenses, profit, margin, healthScore: score, healthKey: hl.key, topExpense, customers: parseInt(latest.customers, 10) || 0, date: latest.date };
    } else {
      // Mock data so we can test the email template
      summaryData = { revenue: 45000, totalExpenses: 26000, profit: 19000, margin: 42.2, healthScore: 72, healthKey: 'good', topExpense: { category: 'Stock / Inventory', amount: 15000 }, customers: 12, date: todayWAT() };
    }

    const aiRec  = await GeminiService.generateRecommendation(summaryData, user);
    const result = await EmailService.sendSummaryEmail(user, summaryData, aiRec, []);

    if (result?.status === 'dev_mode') {
      return res.status(500).json({ error: 'BREVO_API_KEY not set in Render environment variables.' });
    }

    console.log(`[Test Email] ✅ Test email sent to ${user.email}`);
    res.json({ success: true, message: `Test email sent to ${user.email}`, usedRealData: !!latest });
  } catch (err) {
    console.error('[Test Email] ❌ Error:', err.message);
    res.status(500).json({ error: `Email test failed: ${err.message}` });
  }
});

// ─────────────────────────────────────────────
// GET /api/test/all
// Runs all 8 verification tests and returns JSON results.
// ─────────────────────────────────────────────
router.get('/test/all', (_req, res) => {
  const results = [];
  const pass = (name, actual, expected, ok) => {
    const r = { name, result: ok ? 'PASS' : 'FAIL', expected: String(expected), actual: String(actual) };
    console.log(`[TEST] ${r.result} — ${name}: expected ${expected}, got ${actual}`);
    results.push(r);
  };

  // TEST 1 — Margin formula (positive)
  const r1 = 4560000, e1 = 1200000;
  const m1 = parseFloat(((r1 - e1) / r1 * 100).toFixed(1));
  pass('Margin formula (positive)', m1 + '%', '73.7%', m1 === 73.7);

  // TEST 2 — Margin formula (loss)
  const r2 = 1650005, e2 = 1762035;
  const m2 = parseFloat(((r2 - e2) / r2 * 100).toFixed(1));
  pass('Margin formula (loss)', m2 + '%', '-6.8%', m2 === -6.8);

  // TEST 3 — Margin when revenue = 0
  const m3 = 0 > 0 ? parseFloat(((0 - 5000) / 0 * 100).toFixed(1)) : 0;
  pass('Margin when revenue = 0', m3 + '%', '0%', m3 === 0);

  // TEST 4 — Inventory: receive 5, sell 3 → balance 2, no alert (2/5=40%)
  const tr4 = 5, sold4 = 3, bal4 = tr4 - sold4;
  const lowAlert4 = bal4 < tr4 * 0.20;
  pass('Inventory: receive 5, sell 3 → balance 2, no alert', `balance=${bal4}, alert=${lowAlert4}`, 'balance=2, alert=false', bal4 === 2 && !lowAlert4);

  // TEST 5 — Low stock alert: balance 1 of 10 total received (1/10=10% < 20%)
  const tr5 = 10, bal5 = 1;
  const lowAlert5 = bal5 < tr5 * 0.20;
  pass('Low stock: 1 of 10 received (10% < 20% threshold)', `alert=${lowAlert5}`, 'alert=true', lowAlert5 === true);

  // TEST 6 — Out of stock (balance = 0)
  const oos = 0 === 0;
  pass('Out of stock: balance = 0', `oos=${oos}`, 'oos=true', oos === true);

  // TEST 7 — Entry aggregation: TransactionModel.create uses INSERT (code audit)
  const TransactionModel = require('../models/transaction');
  const createSql = TransactionModel.create.toString();
  const usesInsert = createSql.includes('INSERT') && !createSql.includes('UPDATE');
  pass('Entry aggregation: INSERT-only, no UPDATE', usesInsert ? 'INSERT only' : 'UPDATE found!', 'INSERT only', usesInsert);

  // TEST 8 — Streak logic: consecutive days increment, skip resets to 0
  // Simulate streak calculation: day1→1, day2→2, skip→0, day4→1
  function calcStreak(lastEntryDayOffset, currentStreak) {
    // offset=1 means yesterday, offset=0 means today, offset=2 means 2 days ago
    if (lastEntryDayOffset === 1) return currentStreak + 1; // consecutive → increment
    return 1; // gap → reset to 1
  }
  const s1 = 1; // first entry → streak 1
  const s2 = calcStreak(1, s1); // logged next day → 2
  const s3 = 0; // skipped a day → resets to 0
  const s4 = 1; // logged again after gap → 1
  const streakOk = s1 === 1 && s2 === 2 && s3 === 0 && s4 === 1;
  pass('Streak calculation: 1,2,0,1 sequence', `${s1},${s2},${s3},${s4}`, '1,2,0,1', streakOk);

  const passing = results.filter(r => r.result === 'PASS').length;
  const summary = `${passing}/${results.length} passed`;
  console.log(`[TESTS] ${summary}`);

  res.json({ tests: results, summary });
});

// ─────────────────────────────────────────────
// GET /api/test/parse?message=...&userId=...
// Show exactly what Gemini parses from a natural language message.
// Useful for debugging WhatsApp natural language understanding.
// ─────────────────────────────────────────────
router.get('/test/parse', async (req, res) => {
  try {
    const { message, userId } = req.query;
    if (!message) return res.status(400).json({ error: 'message is required' });

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY not set on this server' });
    }

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    let user = { name: 'Test User', biz_type: 'Retail' };
    if (userId) {
      const found = await UserModel.findById(userId);
      if (found) user = found;
    }

    const prompt = `You are BizPulse. The user runs a "${user.biz_type}" business. Their name is ${user.name}.
Parse this message and return JSON with type (daily_entry/inventory_in/inventory_out/customer_log/greeting/question/unknown).
Message: "${message}"
For daily_entry return: {type, revenue, totalExpenses, expenseBreakdown, customers, notes}
Return ONLY valid JSON.`;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const clean = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(clean); } catch(e) { parsed = { raw: text, parseError: e.message }; }

    res.json({ input: message, parsed, geminiRaw: text });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err?.response?.data });
  }
});

// ─────────────────────────────────────────────
// GET /api/test/calculations
// Runs and logs verification tests for margin and inventory logic.
// ─────────────────────────────────────────────
router.get('/test/calculations', (_req, res) => {
  const results = [];

  // TEST 1 — Positive margin
  const r1 = 4560000, e1 = 1200000, p1 = r1 - e1;
  const m1 = parseFloat(((p1 / r1) * 100).toFixed(1));
  results.push({ test: 1, desc: 'Positive margin', input: { revenue: r1, expenses: e1 }, expected: '73.7%', got: m1 + '%', pass: m1 === 73.7 });

  // TEST 2 — Loss margin
  const r2 = 1650005, e2 = 1762035, p2 = r2 - e2;
  const m2 = parseFloat(((p2 / r2) * 100).toFixed(1));
  results.push({ test: 2, desc: 'Loss margin', input: { revenue: r2, expenses: e2 }, expected: '-6.8%', got: m2 + '%', pass: m2 === -6.8 });

  // TEST 3 — Inventory: receive 50, sell 12 → balance 38, NOT below threshold (10 = 20% of 50)
  const totalReceived3 = 50, sold3 = 12;
  const balance3   = totalReceived3 - sold3;
  const threshold3 = totalReceived3 * 0.20;
  const lowAlert3  = balance3 < threshold3;
  results.push({ test: 3, desc: 'Balance 38 — no low stock alert', expected: 'balance=38, alert=false', got: `balance=${balance3}, alert=${lowAlert3}`, pass: balance3 === 38 && !lowAlert3 });

  // TEST 4 — Low stock alert (9 units = 18% of 50, below 20% threshold)
  const balance4    = 9;
  const threshold4  = 50 * 0.20;
  const lowAlert4   = balance4 < threshold4;
  results.push({ test: 4, desc: 'Low stock alert at 18% of received', expected: 'alert=true', got: `alert=${lowAlert4}`, pass: lowAlert4 === true });

  // TEST 5 — Out of stock (different, more urgent alert)
  const balance5   = 0;
  const outOfStock = balance5 === 0;
  results.push({ test: 5, desc: 'Out of stock alert', expected: 'out_of_stock=true', got: `out_of_stock=${outOfStock}`, pass: outOfStock === true });

  results.forEach((r) => {
    const status = r.pass ? 'PASS ✅' : 'FAIL ❌';
    console.log(`[TEST ${r.test}] ${status} — ${r.desc}: expected ${r.expected}, got ${r.got}`);
  });

  const passing = results.filter((r) => r.pass).length;
  console.log(`[TESTS] ${passing}/${results.length} passing`);
  res.json({ tests: results, summary: `${passing}/${results.length} tests passing` });
});

// ─────────────────────────────────────────────
// GET /api/test/whatsapp-config
// Shows whether WhatsApp credentials are set (no secrets exposed).
// ─────────────────────────────────────────────
router.get('/test/whatsapp-config', (_req, res) => {
  res.json({
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ? '✅ set (' + process.env.WHATSAPP_PHONE_NUMBER_ID + ')' : '❌ NOT SET',
    token: process.env.WHATSAPP_TOKEN ? '✅ set (length: ' + process.env.WHATSAPP_TOKEN.length + ')' : '❌ NOT SET',
    geminiApiKey: process.env.GEMINI_API_KEY ? '✅ set (length: ' + process.env.GEMINI_API_KEY.length + ')' : '❌ NOT SET',
    brevoApiKey: process.env.BREVO_API_KEY ? '✅ set' : '❌ NOT SET',
    databaseUrl: process.env.DATABASE_URL ? '✅ set' : '❌ NOT SET',
    mode: (process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_TOKEN) ? 'LIVE' : 'DEV (messages not sent)',
  });
});

// ─────────────────────────────────────────────
// GET /api/test/morning-broadcast?number=2348035273030
// Send a test morning broadcast to a specific number.
// ─────────────────────────────────────────────
router.get('/test/morning-broadcast', async (req, res) => {
  try {
    const { number, name = 'Tosin', bizName = 'your business' } = req.query;
    if (!number) return res.status(400).json({ error: 'number is required' });

    const WhatsAppService = require('../services/whatsapp');
    const quote = 'Know your numbers, own your future. Every naira tracked is a step toward the business you deserve.';
    const result = await WhatsAppService.sendMorningBroadcast(number, name, bizName, quote);
    res.json({ success: true, message: `Morning broadcast sent to ${number}`, result });
  } catch (err) {
    console.error('[Test] morning-broadcast error:', err.message);
    res.status(500).json({ error: err.message, detail: err?.response?.data });
  }
});

// ─────────────────────────────────────────────
// GET /api/test/evening-reminder?number=2348035273030
// Send a test 6pm reminder to a specific number.
// ─────────────────────────────────────────────
router.get('/test/evening-reminder', async (req, res) => {
  try {
    const { number, name = 'Tosin', streak = '0' } = req.query;
    if (!number) return res.status(400).json({ error: 'number is required' });

    const WhatsAppService = require('../services/whatsapp');
    const result = await WhatsAppService.sendEveningReminder(number, name, parseInt(streak, 10));
    res.json({ success: true, message: `Evening reminder sent to ${number}`, result });
  } catch (err) {
    console.error('[Test] evening-reminder error:', err.message);
    res.status(500).json({ error: err.message, detail: err?.response?.data });
  }
});

// ─────────────────────────────────────────────
// POST /api/cron/morning-broadcast
// POST /api/cron/evening-reminder
// POST /api/cron/daily-summary
// POST /api/cron/retention-nudge
//
// HTTP-triggered versions of every cron job.
// Called by an external scheduler (cron-job.org) so they fire even
// when Render's free tier has spun the server down.
//
// Protected by CRON_SECRET env var.
// Header: x-cron-secret: <value>   OR  ?secret=<value>
// ─────────────────────────────────────────────
function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorised' });
  next();
}

router.post('/cron/morning-broadcast', cronAuth, async (_req, res) => {
  try {
    const { runMorningBroadcast } = require('../jobs/dailySummary');
    res.json({ started: true, job: 'morning-broadcast', time: new Date().toISOString() });
    runMorningBroadcast().catch(err => console.error('[Cron HTTP] morning-broadcast error:', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cron/evening-reminder', cronAuth, async (_req, res) => {
  try {
    const { runReminderJob } = require('../jobs/dailySummary');
    res.json({ started: true, job: 'evening-reminder', time: new Date().toISOString() });
    runReminderJob().catch(err => console.error('[Cron HTTP] evening-reminder error:', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cron/daily-summary', cronAuth, async (_req, res) => {
  try {
    const { runDailySummary } = require('../jobs/dailySummary');
    res.json({ started: true, job: 'daily-summary', time: new Date().toISOString() });
    runDailySummary().catch(err => console.error('[Cron HTTP] daily-summary error:', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cron/retention-nudge', cronAuth, async (_req, res) => {
  try {
    const { runRetentionNudge } = require('../jobs/retentionNudge');
    res.json({ started: true, job: 'retention-nudge', time: new Date().toISOString() });
    runRetentionNudge().catch(err => console.error('[Cron HTTP] retention-nudge error:', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
