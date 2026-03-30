/**
 * routes/email.js
 * On-demand email trigger endpoint.
 *
 * POST /api/summary/send
 * Body: { userId }
 *
 * Can be called from:
 *   - The "Send Me a Summary Now" button on the Home screen
 *   - The Settings screen
 *   - The WhatsApp "summary" command (via webhook.js)
 */

'use strict';

const express            = require('express');
const router             = express.Router();

const UserModel          = require('../models/user');
const TransactionModel   = require('../models/transaction');
const InventoryService   = require('../services/inventory');
const GeminiService      = require('../services/gemini');
const EmailService       = require('../services/email');

const { calcHealthScore, healthLabel, topExpenseCategory, todayWAT } = require('../utils/formatter');
const { calcMargin } = require('../utils/naira');

router.post('/send', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const user = await UserModel.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Try today first; fall back to most recent date if nothing logged today
    const todayDate = todayWAT();
    let effectiveDate = todayDate;

    let totals = await TransactionModel.getDailyTotals(user.id, todayDate);
    let revenue       = parseFloat(totals?.revenue)        || 0;
    let totalExpenses = parseFloat(totals?.total_expenses) || 0;

    if (revenue === 0 && totalExpenses === 0) {
      const latest = await TransactionModel.getLatest(user.id);
      if (!latest) {
        return res.status(400).json({ error: 'No entries found yet. Log some numbers first and try again.' });
      }
      effectiveDate = latest.date;
      totals        = { revenue: latest.revenue, total_expenses: latest.total_expenses, profit: latest.profit, customers: latest.customers };
      revenue       = parseFloat(latest.revenue)        || 0;
      totalExpenses = parseFloat(latest.total_expenses) || 0;
    }

    const breakdowns= await TransactionModel.getExpenseBreakdowns(user.id, effectiveDate);
    const lowStock  = await InventoryService.getLowStockAlerts(user.id);

    const profit        = parseFloat(totals.profit)         || 0;
    const customers     = parseInt(totals.customers, 10)    || 0;
    const margin        = calcMargin(profit, revenue);
    const score         = calcHealthScore(margin);
    const hl            = healthLabel(score);
    const topExpense    = topExpenseCategory(breakdowns);

    // Build expenseBreakdown object from breakdown rows for AI context
    const expenseBreakdown = {};
    for (const row of (breakdowns || [])) {
      const eb = (typeof row.expense_breakdown === 'string')
        ? JSON.parse(row.expense_breakdown)
        : (row.expense_breakdown || {});
      for (const [cat, amt] of Object.entries(eb)) {
        expenseBreakdown[cat] = (expenseBreakdown[cat] || 0) + parseFloat(amt);
      }
    }

    const summaryData = {
      revenue, totalExpenses, profit, margin,
      healthScore: score, healthKey: hl.key,
      topExpense, expenseBreakdown, customers, date: effectiveDate,
    };

    const aiRec  = await GeminiService.generateRecommendation(summaryData, user);
    const result = await EmailService.sendSummaryEmail(user, summaryData, aiRec, lowStock);

    // Detect dev-mode (BREVO_API_KEY not configured on the server)
    if (result?.status === 'dev_mode') {
      return res.status(500).json({
        error: 'Email not configured on server. Set BREVO_API_KEY in your Render environment variables, then redeploy.',
      });
    }

    res.json({ success: true, message: `Summary sent to ${user.email}` });
  } catch (err) {
    console.error('[Email Route] /send error:', err.message);
    // Surface the real nodemailer error so it's visible in the UI
    res.status(500).json({ error: `Email failed: ${err.message}` });
  }
});

module.exports = router;
