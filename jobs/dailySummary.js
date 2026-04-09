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

    // Generate personalised AI recommendation (used for both email and WhatsApp)
    const aiRec = await GeminiService.generateRecommendation(summaryData, user);

    const firstName = user.name.split(' ')[0];

    // Send WhatsApp summary first — reaches users who may not open email
    if (user.whatsapp_number) {
      await WhatsAppService.sendEveningSummaryWhatsApp(
        user.whatsapp_number, firstName, summaryData, aiRec, lowStock
      );
      console.log(`[Cron] 📱 WhatsApp summary sent to ${user.name}`);
    }

    // Send email summary
    await EmailService.sendSummaryEmail(user, summaryData, aiRec, lowStock);

    console.log(`[Cron] ✅ Summary sent to ${user.name} <${user.email}>`);
  } catch (err) {
    console.error(`[Cron] ❌ Failed for ${user.name} <${user.email}>:`, err.message);
  }
}

// Rotating business quotes for the morning broadcast
const MORNING_QUOTES = [
  'The secret of getting ahead is getting started.',
  'Do not watch the clock; do what it does. Keep going.',
  'A big business starts small.',
  'Opportunities do not happen. You create them.',
  'Chase the vision, not the money.',
  'Work like someone is trying to take your place.',
  'Your income is directly related to your hustle.',
  'Every day you are not tracking is a day you are guessing.',
  'Small daily improvements are the key to long-term results.',
  'Know your numbers, own your future.',
  'Discipline is the bridge between goals and accomplishment.',
  'Great businesses are built one transaction at a time.',
  'The hustle you put in today is the story you tell tomorrow.',
  'Profit does not happen by accident. Track it.',
  'Your next level starts with knowing where you are today.',
];

/**
 * Send personalised 7am morning broadcast to all active users with a WhatsApp number.
 */
async function runMorningBroadcast() {
  console.log(`[Cron] ☀️ Morning broadcast started at ${new Date().toISOString()}`);
  try {
    const users = await UserModel.findAllActive();
    // Pick today's quote based on day-of-year so it's consistent across all users
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const quote = MORNING_QUOTES[dayOfYear % MORNING_QUOTES.length];

    for (const user of users) {
      if (!user.whatsapp_number) continue;
      try {
        const firstName = user.name.split(' ')[0];
        await WhatsAppService.sendMorningBroadcast(user.whatsapp_number, firstName, user.biz_name, quote, user.streak || 0);
        console.log(`[Cron] ☀️ Morning broadcast sent to ${user.name}`);
      } catch (err) {
        console.error(`[Cron] Morning broadcast failed for ${user.name}:`, err.message);
      }
    }
    console.log('[Cron] ☀️ Morning broadcast complete.');
  } catch (err) {
    console.error('[Cron] Morning broadcast job error:', err.message);
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

// ── Schedule all three jobs — fires automatically when this module is required ──

// 6:00 AM WAT — morning broadcast (quote + encouragement)
cron.schedule('0 6 * * *', async () => {
  console.log('[Cron] ☀️ Morning broadcast firing:', new Date().toISOString());
  try {
    await runMorningBroadcast();
    console.log('[Cron] ☀️ Morning broadcast completed.');
  } catch (err) {
    console.error('[Cron] Morning broadcast failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });
console.log('[Cron] Morning broadcast scheduled for 6:00 AM WAT.');

// 6:00 PM WAT — WhatsApp reminder for users who haven't logged today
cron.schedule('0 18 * * *', async () => {
  console.log('[Cron] 🔔 Evening reminder firing:', new Date().toISOString());
  try {
    await runReminderJob();
    console.log('[Cron] 🔔 Evening reminder completed.');
  } catch (err) {
    console.error('[Cron] Evening reminder failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });
console.log('[Cron] Evening reminder scheduled for 6:00 PM WAT.');

// 7:00 PM WAT — full summary email
cron.schedule('0 19 * * *', async () => {
  console.log('[Cron] 🕖 Daily summary firing:', new Date().toISOString());
  try {
    await runDailySummary();
    console.log('[Cron] 🕖 Daily summary completed.');
  } catch (err) {
    console.error('[Cron] Daily summary failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });
console.log('[Cron] Daily summary scheduled for 7:00 PM WAT.');

module.exports = { runDailySummary, runReminderJob, runMorningBroadcast };
