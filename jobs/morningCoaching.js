/**
 * jobs/morningCoaching.js
 * Daily 6am WAT coaching message with market insights.
 *
 * Sends personalized business motivation + one actionable insight.
 * Runs every day at 6am Africa/Lagos timezone.
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel = require('../models/user');
const TransactionModel = require('../models/transaction');
const ClaudeService = require('../services/claude');
const WhatsAppService = require('../services/whatsapp');
const MarketDataService = require('../services/marketData');
const { todayWAT } = require('../utils/formatter');

/**
 * Send morning coaching to all active users.
 */
async function runMorningCoaching() {
  console.log(`[Morning Coaching] 🌟 Starting at ${new Date().toISOString()}`);

  try {
    // Get all active users (those who've entered at least once)
    const users = await UserModel.findAllActive();

    if (users.length === 0) {
      console.log('[Morning Coaching] No active users yet.');
      return;
    }

    console.log(`[Morning Coaching] Sending to ${users.length} active users...`);

    for (const user of users) {
      if (!user.whatsapp_number) continue;

      try {
        const firstName = user.name.split(' ')[0];

        // Get yesterday's performance
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        const yesterdayTotals = await TransactionModel.getDailyTotals(user.id, yesterdayStr);
        const yesterdayRevenue = parseFloat(yesterdayTotals.revenue) || 0;
        const yesterdayProfit = parseFloat(yesterdayTotals.profit) || 0;

        // Create context for Claude
        const context = {
          firstName,
          businessType: user.biz_type,
          yesterdayRevenue,
          yesterdayProfit,
        };

        // Get market insight
        const marketInsight = await MarketDataService.getMarketInsight(
          user.biz_type,
          {
            revenue: yesterdayRevenue,
            totalExpenses: yesterdayRevenue - yesterdayProfit,
            margin: yesterdayRevenue > 0 ? ((yesterdayProfit / yesterdayRevenue) * 100) : 0,
          }
        );

        // Prepare coaching message
        const coachingMsg = getCoachingMessage(context, marketInsight);

        await WhatsAppService.sendMessage(user.whatsapp_number, coachingMsg);
        console.log(`[Morning Coaching] ✅ Sent to ${user.name}`);
      } catch (err) {
        console.error(`[Morning Coaching] ❌ Failed for ${user.name}:`, err.message);
      }
    }

    console.log('[Morning Coaching] ✅ Completed.');
  } catch (err) {
    console.error('[Morning Coaching] Fatal error:', err.message);
  }
}

/**
 * Generate personalized morning coaching message.
 */
function getCoachingMessage(context, marketInsight) {
  const { firstName, businessType, yesterdayRevenue, yesterdayProfit } = context;

  if (yesterdayRevenue === 0) {
    // No data yesterday
    return (
      `🌅 Good morning, ${firstName}! ☀️\n\n` +
      `Ready for another day? Log your numbers with me:\n` +
      `"Made 50k today, spent 15k stock, 3k transport"\n\n` +
      `Let's build your business insight today! 📊`
    );
  }

  // Had data yesterday
  const profitLine = yesterdayProfit > 0
    ? `Yesterday was profitable — ₦${Number(yesterdayProfit).toLocaleString('en-NG')} profit! 💰`
    : `Yesterday was rough, but today's a new chance. Let's go! 💪`;

  return (
    `🌅 Good morning, ${firstName}! ☀️\n\n` +
    `${profitLine}\n\n` +
    `${marketInsight.insight}\n\n` +
    `Send me your numbers today — let's see what today brings! 📈`
  );
}

// ── Schedule morning coaching for 6:00 AM WAT ──
cron.schedule('0 6 * * *', async () => {
  console.log('[Cron] 🌟 Morning coaching firing:', new Date().toISOString());
  try {
    await runMorningCoaching();
  } catch (err) {
    console.error('[Cron] Morning coaching failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });

console.log('[Cron] Morning coaching scheduled for 6:00 AM WAT.');

module.exports = { runMorningCoaching };
