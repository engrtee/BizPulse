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

const UserModel            = require('../models/user');
const TransactionModel     = require('../models/transaction');
const InventoryService     = require('../services/inventory');
const ClaudeService        = require('../services/claude');
const EmailService         = require('../services/email');
const WhatsAppService      = require('../services/whatsapp');
const { getPersona }       = require('../services/personaEngine');
const { nairaShort }       = require('../services/nudgeBuilder');
const ConfirmationService  = require('../services/confirmationService');

const { calcHealthScore, healthLabel, topExpenseCategory, todayWAT } = require('../utils/formatter');
const { calcMargin } = require('../utils/naira');

/**
 * Send a 7pm nudge to a user who hasn't logged today.
 * Includes a short Claude-generated coaching insight from their history.
 */
async function sendEveningNudge(user) {
  const firstName = user.name.split(' ')[0];
  const streak    = user.streak || 0;

  // Pull their recent history for a personalised coaching tip
  let coachingTip = '';
  try {
    const history = await TransactionModel.getHistory(user.id, 7);
    if (history && history.length >= 3) {
      const avgRevenue = history.reduce((s, r) => s + parseFloat(r.revenue), 0) / history.length;
      const avgMargin  = history.reduce((s, r) => s + parseFloat(r.margin),  0) / history.length;
      const tip = await ClaudeService.generateNudgeInsight(user, { avgRevenue, avgMargin, dayCount: history.length });
      if (tip) coachingTip = tip;
    }
  } catch (e) {
    // coaching tip is optional — nudge still goes out
  }

  const streakLine = streak >= 3
    ? `\n\n🔥 You're on a ${streak}-day streak — one quick message keeps it alive.`
    : streak >= 1
    ? `\n\n📈 Day ${streak} streak going — keep the habit.`
    : '';

  const genericTip = `Businesses that log consistently spot problems early and fix them before they become losses. The more days you track, the sharper the insights get.`;

  const body =
    `Hey ${firstName}! 👋 No numbers from you today yet.\n\n` +
    `💡 *Today's insight:*\n${coachingTip || genericTip}\n\n` +
    `Send me today's numbers to get your full breakdown and personalised coaching:\n` +
    `_"Made 50k today, spent 15k on stock and 3k transport"_` +
    streakLine;

  await WhatsAppService.sendMessage(user.whatsapp_number, body);
  console.log(`[Cron] 💬 Evening nudge sent to ${user.name}`);
}

/**
 * Process a single user: compute summary, call Gemini, send email.
 * Errors are caught per-user so one failure doesn't block the rest.
 */
async function processUser(user) {
  try {
    // Feature 6: summary frequency gate
    const freq = user.summary_frequency || 'daily';
    if (freq === 'weekly') {
      const dayOfWeek = new Date().toLocaleDateString('en-US', { timeZone: 'Africa/Lagos', weekday: 'short' });
      if (dayOfWeek !== 'Sun') {
        console.log(`[Cron] ⏭ Skipping ${user.name} (weekly summary, not Sunday)`);
        return;
      }
    }

    const date      = todayWAT();
    const totals    = await TransactionModel.getDailyTotals(user.id, date);
    const breakdowns= await TransactionModel.getExpenseBreakdowns(user.id, date);

    const revenue       = parseFloat(totals.revenue)       || 0;
    const totalExpenses = parseFloat(totals.total_expenses) || 0;
    const profit        = parseFloat(totals.profit)         || 0;
    const customers     = parseInt(totals.customers, 10)    || 0;

    // No entries today — send a nudge with a coaching tip instead of silently skipping
    if (revenue === 0 && totalExpenses === 0) {
      console.log(`[Cron] 💬 No entries for ${user.name} on ${date} — sending nudge`);
      if (user.whatsapp_number) {
        await sendEveningNudge(user).catch(e =>
          console.error(`[Cron] Nudge failed for ${user.name}:`, e.message)
        );
      }
      return;
    }

    console.log(`[Cron] 🔍 ${user.name}: Found ₦${Number(revenue).toLocaleString('en-NG')} revenue for ${date}`);

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

    // Generate personalised AI recommendation with Claude (better Nigerian market context)
    const aiRec = await ClaudeService.generateRecommendation(summaryData, user);

    const firstName = user.name.split(' ')[0];

    // Send WhatsApp summary — non-blocking so a token error never blocks the email
    if (user.whatsapp_number) {
      WhatsAppService.sendEveningSummaryWhatsApp(
        user.whatsapp_number, firstName, summaryData, aiRec, lowStock
      ).then(() => console.log(`[Cron] 📱 WhatsApp summary sent to ${user.name}`))
       .catch((err) => console.error(`[Cron] ⚠️  WhatsApp failed for ${user.name}:`, err?.response?.data?.error?.message || err.message));
    }

    // Send email summary — always runs regardless of WhatsApp status
    await EmailService.sendSummaryEmail(user, summaryData, aiRec, lowStock);

    console.log(`[Cron] ✅ Email summary sent to ${user.name} <${user.email}>`);
  } catch (err) {
    console.error(`[Cron] ❌ Failed for ${user.name} <${user.email}>:`, err.message, err.stack);
  }
}

// Rotating business quotes for the morning broadcast
// DEPRECATED: Replaced with dedicated morningCoaching.js job for personalized coaching
// Kept for reference only

/**
 * Send personalised 7am morning broadcast to all active users with a WhatsApp number.
 * DEPRECATED: Use jobs/morningCoaching.js instead for personalized messaging.
 */
async function runMorningBroadcast() {
  console.log('[Cron] ⚠️ runMorningBroadcast is deprecated — use morningCoaching.js instead');
  // This function is no longer called but kept for backward compatibility
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
/**
 * Build a persona-aware 6pm reminder for a user who hasn't logged today.
 * Softer tone than the retention nudge — it's same-day, not re-engagement.
 */
function buildEveningReminder(firstName, persona, streak) {
  const emoji   = persona.craft_emoji    || '📊';
  const metric  = persona.key_metric     || 'daily profit';
  const bizType = persona.business_type  || 'business';
  const exAmt   = nairaShort(persona.example_amount || 30000);
  const exExp   = nairaShort((persona.example_amount || 30000) * 0.3);
  const exItem  = persona.example_expense || 'operations';

  const s = parseInt(streak, 10) || 0;
  const streakLine = s >= 3
    ? `\n\n🔥 Your ${s}-day streak is on the line — one message keeps it alive.`
    : s >= 1
    ? `\n\n📈 Day ${s} — keep the habit going!`
    : '';

  return (
    `${firstName} ${emoji}\n\n` +
    `Have you logged today's ${bizType} numbers?\n\n` +
    `Your *${metric}* for today is waiting to be recorded. Just send:\n` +
    `_"made ${exAmt} today spent ${exExp} on ${exItem}"_\n\n` +
    `I'll handle the full breakdown instantly. 📊` +
    streakLine
  );
}

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
        const persona   = await getPersona(user).catch(() => null);

        let msg;
        if (persona) {
          msg = buildEveningReminder(firstName, persona, user.streak || 0);
        } else {
          // Fallback if persona lookup fails
          const s = parseInt(user.streak, 10) || 0;
          const streakLine = s >= 3 ? `\n\n🔥 ${s}-day streak on the line — don't break it now!` : '';
          msg = `Hey ${firstName} 👋 Have you logged today's numbers?\n\nJust send: "Made 50k, spent 15k on stock"\nI'll handle the rest. 📊${streakLine}`;
        }

        await WhatsAppService.sendMessage(user.whatsapp_number, msg);
        console.log(`[Cron] 🔔 Reminder sent to ${user.name}`);
      } catch (err) {
        console.error(`[Cron] Reminder failed for ${user.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Cron] Reminder job error:', err.message);
  }
}

// ── Schedule all jobs — fires automatically when this module is required ──

// Every 30 minutes — expire stale pending entries (> 4h old)
cron.schedule('*/30 * * * *', async () => {
  try {
    const expired = await ConfirmationService.expireOldEntries();
    if (expired.length > 0) {
      console.log(`[Cron] ⏰ Expired ${expired.length} pending entries`);
    }
  } catch (err) {
    console.error('[Cron] Expiry job error:', err.message);
  }
});

// Every 30 minutes — send 2h reminder for entries that haven't had one
cron.schedule('*/30 * * * *', async () => {
  try {
    const pending = await ConfirmationService.getPendingNeedingReminder();
    for (const entry of pending) {
      try {
        const parsedData = typeof entry.parsed_data === 'string'
          ? JSON.parse(entry.parsed_data)
          : entry.parsed_data;
        const preview = ConfirmationService.buildConfirmationMessage(entry.entry_type, parsedData);
        await WhatsAppService.sendMessage(entry.whatsapp_number,
          `⏰ Hey ${entry.name.split(' ')[0]}, you still have a pending entry waiting for confirmation:\n\n${preview}\n\n` +
          `Reply *YES* to log it or *EDIT* if something's wrong.`
        );
        await ConfirmationService.markReminderSent(entry.id);
        console.log(`[Cron] ⏰ Confirmation reminder sent to ${entry.name}`);
      } catch (e) {
        console.error(`[Cron] Reminder failed for pending ${entry.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[Cron] Confirmation reminder job error:', err.message);
  }
});
console.log('[Cron] Pending entry expiry + 2h reminder scheduled (every 30 min).');

// 6:00 AM WAT — morning coaching now handled by dedicated jobs/morningCoaching.js
// (removed from here to avoid duplicate messages)

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
