/**
 * jobs/dailySummary.js
 * Cron job that runs every day at 7:00 PM WAT (UTC+1).
 *
 * For each active user:
 *   1. Pull today's totals from PostgreSQL
 *   2. Compute health score, top expense, margin
 *   3. Call Gemini for a personalised recommendation
 *   4. Check for low stock alerts
 *   5. Send the HTML email
 *
 * The job skips users with no entries today to avoid empty emails.
 *
 * PHASE 2: business health score extends here
 *   (add trend comparison: today vs 7-day average)
 * PHASE 2: loan-ready financial statements extend here
 *   (monthly P&L export triggered on the last day of the month)
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel        = require('../models/user');
const TransactionModel = require('../models/transaction');
const InventoryService = require('../services/inventory');
const GeminiService    = require('../services/gemini');
const EmailService     = require('../services/email');
const WhatsAppService  = require('../services/whatsapp');

const { calcHealthScore, healthLabel, topExpenseCategory, todayWAT } = require('../utils/formatter');
const { calcMargin } = require('../utils/naira');

/**
 * Process a single user: compute summary, call Gemini, send email.
 * Errors are caught per-user so one failure doesn't block the rest.
 */
async function processUser(user) {
  try {
    const date      = todayWAT();
    const totals    = await TransactionModel.getDailyTotals(user.id, date);
    const breakdowns= await TransactionModel.getExpenseBreakdowns(user.id, date);

    const revenue       = parseFloat(totals.revenue)       || 0;
    const totalExpenses = parseFloat(totals.total_expenses) || 0;
    const profit        = parseFloat(totals.profit)         || 0;
    const customers     = parseInt(totals.customers, 10)    || 0;

    // Skip users with zero activity today
    if (revenue === 0 && totalExpenses === 0) {
      console.log(`[Cron] Skipping ${user.name} — no entries today`);
      return;
    }

    const margin     = calcMargin(profit, revenue);
    const score      = calcHealthScore(margin);
    const hl         = healthLabel(score);
    const topExpense = topExpenseCategory(breakdowns);
    const lowStock   = await InventoryService.getLowStockAlerts(user.id);

    const summaryData = {
      revenue,
      totalExpenses,
      profit,
      margin,
      healthScore: score,
      healthKey:   hl.key,
      topExpense,
      customers,
      date,
    };

    // Generate personalised AI recommendation
    const aiRec = await GeminiService.generateRecommendation(summaryData, user);

    // Send email
    await EmailService.sendSummaryEmail(user, summaryData, aiRec, lowStock);

    console.log(`[Cron] ✅ Summary sent to ${user.name} <${user.email}>`);
  } catch (err) {
    console.error(`[Cron] ❌ Failed for ${user.name} <${user.email}>:`, err.message);
  }
}

/**
 * Main job function — exported so it can also be triggered on-demand in tests.
 */
async function runDailySummary() {
  console.log(`[Cron] 🕖 Daily summary job started at ${new Date().toISOString()}`);

  try {
    const users = await UserModel.findAllActive();
    console.log(`[Cron] Processing ${users.length} active users...`);

    // Process sequentially to avoid hammering Gemini rate limits
    for (const user of users) {
      await processUser(user);
    }

    console.log('[Cron] ✅ Daily summary job complete.');
  } catch (err) {
    console.error('[Cron] Fatal job error:', err.message);
  }
}

/**
 * Schedule: 7:00 PM WAT = 18:00 UTC (WAT is UTC+1).
 * Cron format: second minute hour day month weekday
 * "0 18 * * *" = 6:00 PM UTC = 7:00 PM WAT every day.
 */
/**
 * Send WhatsApp reminder to users who haven't logged today.
 * Runs at 5:00 PM UTC = 6:00 PM WAT.
 */
async function runReminderJob() {
  console.log(`[Cron] 🔔 Reminder job started at ${new Date().toISOString()}`);
  try {
    const users = await UserModel.findAllActive();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

    for (const user of users) {
      if (!user.whatsapp_number) continue;
      // Skip if already logged today
      if (user.last_entry_date) {
        const lastDate = new Date(user.last_entry_date).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
        if (lastDate === today) continue;
      }
      try {
        const firstName = user.name.split(' ')[0];
        await WhatsAppService.sendReminder(user.whatsapp_number, firstName, user.streak || 0);
        console.log(`[Cron] 🔔 Reminder sent to ${user.name}`);
      } catch (err) {
        console.error(`[Cron] Reminder failed for ${user.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Cron] Reminder job error:', err.message);
  }
}

function scheduleDailySummary() {
  // 7:00 PM WAT = 6:00 PM UTC — full summary email
  cron.schedule('0 18 * * *', runDailySummary, { timezone: 'UTC' });
  console.log('[Cron] Daily summary job scheduled for 7:00 PM WAT (6:00 PM UTC).');

  // 6:00 PM WAT = 5:00 PM UTC — WhatsApp reminder for users who haven't logged
  cron.schedule('0 17 * * *', runReminderJob, { timezone: 'UTC' });
  console.log('[Cron] Reminder job scheduled for 6:00 PM WAT (5:00 PM UTC).');
}

module.exports = { scheduleDailySummary, runDailySummary, runReminderJob };
