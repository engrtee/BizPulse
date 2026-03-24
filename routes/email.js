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

    const date      = todayWAT();
    const totals    = await TransactionModel.getDailyTotals(user.id, date);
    const breakdowns= await TransactionModel.getExpenseBreakdowns(user.id, date);
    const lowStock  = await InventoryService.getLowStockAlerts(user.id);

    const revenue       = parseFloat(totals.revenue)       || 0;
    const totalExpenses = parseFloat(totals.total_expenses) || 0;
    const profit        = parseFloat(totals.profit)         || 0;
    const customers     = parseInt(totals.customers, 10)    || 0;
    const margin        = calcMargin(profit, revenue);
    const score         = calcHealthScore(margin);
    const hl            = healthLabel(score);
    const topExpense    = topExpenseCategory(breakdowns);

    if (revenue === 0 && totalExpenses === 0) {
      return res.status(400).json({
        error: 'No entries found for today. Log some sales or expenses first.',
      });
    }

    const summaryData = {
      revenue, totalExpenses, profit, margin,
      healthScore: score, healthKey: hl.key,
      topExpense, customers, date,
    };

    const aiRec  = await GeminiService.generateRecommendation(summaryData, user);
    const result = await EmailService.sendSummaryEmail(user, summaryData, aiRec, lowStock);

    // Detect silent dev-mode (GMAIL env vars not configured on the server)
    if (result?.status === 'dev_mode') {
      return res.status(500).json({
        error: 'Email not configured on server. Set GMAIL_USER and GMAIL_APP_PASSWORD in your Render environment variables, then redeploy.',
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
