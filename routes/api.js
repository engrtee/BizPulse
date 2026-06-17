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
const ProductModel       = require('../models/product');
// SheetsService is legacy — only runs when user.sheet_id is set (never for new users since Google Drive was removed).
const SheetsService      = require('../services/sheets');

const GeminiService      = require('../services/gemini');
const EmailService       = require('../services/email');
const WhatsAppService    = require('../services/whatsapp');

const { calcHealthScore, healthLabel, topExpenseCategory, todayWAT } = require('../utils/formatter');
const { calcMargin } = require('../utils/naira');
const { normalizePhone } = require('../utils/phone');
const { createSession, requireAuth } = require('../middleware/auth');

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
    await createSession(user.id, res);
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

    if (!name || !email || !whatsappNumber) {
      return res.status(400).json({ error: 'Name, email, and WhatsApp number are required.' });
    }

    // Check for duplicate email
    const existing = await UserModel.findByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.', userId: existing.id });
    }

    const normalizedPhone = normalizePhone(whatsappNumber);
    if (!normalizedPhone) {
      return res.status(400).json({ error: 'Please enter a valid Nigerian WhatsApp number (e.g. 08012345678).' });
    }

    // Check for duplicate WhatsApp number
    const existingPhone = await UserModel.findByWhatsapp(normalizedPhone);
    if (existingPhone) {
      return res.status(409).json({ error: 'This WhatsApp number is already registered. Please use the Login tab to access your account.' });
    }

    const user = await UserModel.create({ name, email, bizName, bizType, state, whatsappNumber: normalizedPhone });
    await createSession(user.id, res);

    // Send WhatsApp welcome message immediately on registration (non-blocking)
    if (normalizedPhone) {
      const firstName = user.name.split(' ')[0];
      WhatsAppService.sendMessage(normalizedPhone,
        `${firstName}, you're registered on BizPulse! 🎉\n\n` +
        `I'm Kemi — I'll be tracking your business right here on WhatsApp.\n\n` +
        `Before we start, I need one thing from you:\n` +
        `Tell me what stock you currently have.\n\n` +
        `This is Step 1. Without it, I can't alert you before things run out or tell you which products are making you money.\n\n` +
        `Reply to this message with what you have:\n` +
        `_"I have 50 bags rice, 20 cartons indomie, 10 peak milk"_\n\n` +
        `Or snap a photo of your shelf or notebook and send it — I'll read it myself. 📸\n\n` +
        `Once you do this, I'll handle everything. Sales, stock, profit — all tracked automatically. 🚀`
      ).catch((err) => console.error('[API] Registration WhatsApp welcome failed:', err.message));
    }

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
router.post('/entry', requireAuth, async (req, res) => {
  try {
    const { revenue, expenses, stockMovements, customers, notes, topProduct } = req.body;
    const userId = req.authUserId;

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
    console.log(`[API] 💾 Saving entry for user ${user.id} (${user.name}): ₦${rev} revenue`);
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
    
    if (!txn || !txn.id) {
      console.error('[API] ❌ Transaction create returned null or no ID!');
      return res.status(500).json({ error: 'Failed to save transaction' });
    }
    
    console.log(`[API] ✅ Saved transaction ID: ${txn.id} with date: ${txn.date}`);
    
    // FAILSAFE: Verify entry actually exists in database
    const verification = await TransactionModel.getDailyTotals(user.id, txn.date);
    if (!verification) {
      console.error('[API] 🚨 CRITICAL: Entry was not found after save!');
      return res.status(500).json({ error: 'Entry was not persisted' });
    }

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
        id: txn.id,
        revenue: parseFloat(txn.revenue),
        totalExpenses: parseFloat(txn.total_expenses),
        profit: parseFloat(txn.profit),
        margin: parseFloat(txn.margin),
        customers: parseInt(txn.customers, 10),
        date: txn.date,
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
router.get('/summary/latest', requireAuth, async (req, res) => {
  try {
    const userId = req.authUserId;
    const user = await UserModel.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const [latest, history, allProducts, completeness, monthly] = await Promise.all([
      TransactionModel.getLatest(user.id),
      TransactionModel.getHistory(user.id, 10),
      ProductModel.getWithHealth(user.id),
      TransactionModel.getCompleteness(user.id, 10),
      TransactionModel.getMonthlyTotals(user.id),
    ]);

    // Compute low-stock alerts from products table (same source as WhatsApp/Kemi).
    // Map to the legacy field names (item_name / current_balance) so the existing
    // frontend HTML works without changes.
    const lowStock = allProducts
      .filter(p => {
        const bal = parseFloat(p.current_stock)       || 0;
        const tot = parseFloat(p.total_ever_received) || 0;
        const vel = parseFloat(p.velocity_per_day)    || 0;
        return bal === 0
          || (tot > 0 && bal < tot * 0.20)
          || (vel > 0 && bal / vel <= 2);
      })
      .map(p => ({
        item_name:       p.product_name,
        current_balance: p.current_stock,
        unit:            p.unit || 'units',
      }));

    const stock = allProducts.map(p => ({
      item_name:       p.product_name,
      current_balance: p.current_stock,
      unit:            p.unit || 'units',
    }));

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
router.put('/user/update', requireAuth, async (req, res) => {
  try {
    const { name, email, bizName, bizType, state, whatsappNumber } = req.body;
    const userId = req.authUserId;

    const normalizedPhone = whatsappNumber ? normalizePhone(whatsappNumber) : undefined;
    const updated = await UserModel.update(userId, { name, email, bizName, bizType, state, whatsappNumber: normalizedPhone });
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
router.get('/inventory', requireAuth, async (req, res) => {
  try {
    const userId = req.authUserId;

    // Read from products table (Kemi's source of truth) and map to the legacy
    // field names so any existing frontend code continues to work unchanged.
    const products = await ProductModel.getWithHealth(userId);
    const items = products.map(p => ({
      id:              p.id,
      user_id:         p.user_id,
      item_name:       p.product_name,
      current_balance: p.current_stock,
      total_received:  p.total_ever_received,
      unit_price:      p.last_purchase_price,
      unit:            p.unit || 'units',
    }));
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
router.get('/user', requireAuth, async (req, res) => {
  try {
    const userId = req.authUserId;
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
router.get('/export/csv', requireAuth, async (req, res) => {
  try {
    const userId = req.authUserId;
    const user = await UserModel.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const rows = await TransactionModel.getHistory(user.id, 9999);
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
// GET /api/products/:userId
// All active products with health status + velocity.
// ─────────────────────────────────────────────
router.get('/products/:userId', requireAuth, async (req, res) => {
  try {
    const userId = req.authUserId;
    const ProductModel = require('../models/product');
    const products = await ProductModel.getWithHealth(userId);
    res.json({ success: true, products });
  } catch (err) {
    console.error('[API] /products error:', err.message);
    res.status(500).json({ error: 'Could not load products.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/products/:userId/performance
// 7d and 30d revenue + units sold per product.
// ─────────────────────────────────────────────
router.get('/products/:userId/performance', requireAuth, async (req, res) => {
  try {
    const userId = req.authUserId;
    const ProductModel = require('../models/product');
    const performance = await ProductModel.getPerformance(userId);
    res.json({ success: true, performance });
  } catch (err) {
    console.error('[API] /products/performance error:', err.message);
    res.status(500).json({ error: 'Could not load product performance.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/products/:userId/alerts
// Products with low stock or out-of-stock status.
// ─────────────────────────────────────────────
router.get('/products/:userId/alerts', requireAuth, async (req, res) => {
  try {
    const userId = req.authUserId;
    const ProductModel = require('../models/product');
    const products = await ProductModel.getWithHealth(userId);

    const alerts = products
      .map(p => {
        const stock    = parseFloat(p.current_stock)      || 0;
        const received = parseFloat(p.total_ever_received) || 0;
        const velocity = parseFloat(p.velocity_per_day)   || 0;

        let status = 'HEALTHY';
        let daysRemaining = null;

        if (stock === 0) {
          status = 'OUT_OF_STOCK';
        } else if (velocity > 0) {
          daysRemaining = stock / velocity;
          if (daysRemaining <= 2)   status = 'CRITICAL';
          else if (daysRemaining <= 5) status = 'LOW';
        } else if (received > 0 && stock / received < 0.20) {
          status = 'LOW';
        }

        return { ...p, status, daysRemaining };
      })
      .filter(p => p.status !== 'HEALTHY');

    res.json({ success: true, alerts });
  } catch (err) {
    console.error('[API] /products/alerts error:', err.message);
    res.status(500).json({ error: 'Could not load stock alerts.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/stock-movements/:userId
// Last 20 product transactions (stock movements log).
// ─────────────────────────────────────────────
router.get('/stock-movements/:userId', requireAuth, async (req, res) => {
  try {
    const userId = req.authUserId;
    const limit  = parseInt(req.query.limit, 10) || 20;
    const ProductModel = require('../models/product');
    const movements = await ProductModel.getRecentMovements(userId, limit);
    res.json({ success: true, movements });
  } catch (err) {
    console.error('[API] /stock-movements error:', err.message);
    res.status(500).json({ error: 'Could not load stock movements.' });
  }
});

module.exports = router;
