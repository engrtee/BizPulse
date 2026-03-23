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

const { calcHealthScore, healthLabel, topExpenseCategory, todayWAT } = require('../utils/formatter');
const { calcMargin } = require('../utils/naira');

// ─────────────────────────────────────────────
// POST /api/register
// Called by the Step 2 registration form before OAuth redirect.
// Creates the user row. OAuth callback will add tokens + sheetId.
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
    const { userId, revenue, expenses, stockMovements, customers, notes } = req.body;

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

    // Save transaction to DB
    const txn = await TransactionModel.create({
      userId: user.id,
      revenue:          rev,
      totalExpenses,
      expenseBreakdown,
      profit,
      margin,
      customers:        parseInt(customers, 10) || 0,
      notes:            notes || null,
      rawMessage:       'web_entry',
    });

    // Update last_entry_date
    await UserModel.touchLastEntry(user.id);

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
        notes:            notes || '',
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

    res.json({
      success: true,
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

    const latest   = await TransactionModel.getLatest(user.id);
    const history  = await TransactionModel.getHistory(user.id, 10);
    const lowStock = await InventoryService.getLowStockAlerts(user.id);

    if (!latest) {
      return res.json({ hasData: false, history: [], lowStock });
    }

    const score = calcHealthScore(parseFloat(latest.margin) || 0);
    const hl    = healthLabel(score);

    // Rebuild top expense from breakdown
    const breakdown  = latest.expense_breakdown || {};
    const topExpense = topExpenseCategory([breakdown]);

    res.json({
      hasData: true,
      summary: {
        date:          latest.date,
        revenue:       latest.revenue,
        totalExpenses: latest.total_expenses,
        profit:        latest.profit,
        margin:        latest.margin,
        customers:     latest.customers,
        healthScore:   score,
        healthLabel:   hl.label,
        healthEmoji:   hl.emoji,
        healthKey:     hl.key,
        topExpense,
      },
      history,
      lowStock,
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

module.exports = router;
