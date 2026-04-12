/**
 * jobs/morningCoaching.js
 * Daily 6am WAT morning message to all active users with a WhatsApp number.
 *
 * Each message contains:
 *   1. Warm personal greeting
 *   2. Yesterday's profit result (with celebration or encouragement)
 *   3. One simple, rotating business coaching tip (by business type, day of week)
 *   4. Prompt to log today's numbers
 *
 * Runs every day at 6:00 AM Africa/Lagos timezone.
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel        = require('../models/user');
const TransactionModel = require('../models/transaction');
const WhatsAppService  = require('../services/whatsapp');

// ── Rotating coaching tips by business type ─────────────
// 7 tips per category — one per day of the week (Sunday=0 … Saturday=6)
const TIPS = {
  fashion: [
    'Note which items sold fastest this week. Your best sellers deserve priority restocking before you run out.',
    'A customer who buys once can buy again. Do you have a way to follow up with your repeat buyers?',
    'Your fabric and finish quality is your reputation. One bad product can cost you 10 future customers.',
    'Items sitting unsold for 30+ days are tying up your cash. Consider a small discount to move them faster.',
    'Your best marketing is a happy customer wearing your work. Ask satisfied buyers to send you a photo to share.',
    'Always price to include your time and skill. Undercharging hurts your business more than you realise.',
    'Slow days are good days to restock, tidy your display, and plan for the busy periods coming ahead.',
  ],
  food: [
    'Food waste is silent profit loss. Track what gets thrown away and adjust your prep quantities.',
    'Your fastest-selling dish is your hero product. Make sure you never, ever run out of it.',
    'A clean, organised kitchen speeds up service and reduces costly mistakes during rush hours.',
    'Loyal customers are worth more than new ones. Do you know who comes back to you every single week?',
    'One small price increase on your top seller, done right, can meaningfully boost your daily profit.',
    'Track your daily customer count every day. A downward trend is a signal to act before it becomes a crisis.',
    'Good food at a fair price beats cheap food at any price. Compete on quality and consistency, not price.',
  ],
  retail: [
    'Your fastest-selling items should always be in stock. Losing a sale to "out of stock" is avoidable profit loss.',
    'Buying in bulk when you have the cash lowers your unit cost and pushes more into your margin.',
    'A loyal customer buys regularly and refers friends. Treat your repeat buyers especially well.',
    'Check which items have not moved in 30 days. Slow stock ties up cash you could use to buy faster-moving goods.',
    'Your shop layout and display are part of your product. A well-organised shop sells more.',
    'One reliable supplier relationship beats ten unreliable ones. Protect the good relationships you have.',
    'The best time to restock is before you run out — not after. Watch your fast movers daily.',
  ],
  services: [
    'Under-promise and over-deliver. It is the fastest way to build a reputation that brings referrals.',
    'Your time is your product. Are you charging enough for it? Review your rates against your quality.',
    'One satisfied client who tells three friends is worth more than any advertisement you could pay for.',
    'Write down the steps for what you do well. Systems free you from having to remember everything yourself.',
    'Follow up with past clients. A simple "how are things going?" message often leads to repeat business.',
    'Raise your prices gradually as your reputation grows. Confidence in your value is part of your service.',
    'Know which of your services makes the most profit — not just which ones you do most often.',
  ],
  default: [
    'What got measured yesterday is your baseline. Today, aim to push one step further.',
    'Consistency is your biggest competitive advantage. Businesses that track daily know more than those that guess.',
    'Small improvements every day compound into results that will surprise you in 30 days.',
    'Tracking your numbers makes you 3x more likely to catch a problem before it becomes a serious loss.',
    'Your data is your edge. Most of your competitors are making decisions by guesswork.',
    'Cash is the oxygen of your business. Always know what is coming in and going out this week.',
    'The habit of logging is worth more than any single insight. You are building something real.',
  ],
};

/**
 * Pick the right tip set for a business type, then return today's tip.
 */
function getCoachingTip(businessType) {
  const dayOfWeek = new Date().getDay(); // 0=Sun … 6=Sat
  const biz = (businessType || '').toLowerCase();

  let tipSet = TIPS.default;
  if (/fashion|cloth/i.test(biz))                                          tipSet = TIPS.fashion;
  else if (/food|restaurant|bakery|beverage|catering/i.test(biz))          tipSet = TIPS.food;
  else if (/retail|trading|fmcg|e-commerce|online|whatsapp business/i.test(biz)) tipSet = TIPS.retail;
  else if (/service|consult|technology|advertising|education|photo|project/i.test(biz)) tipSet = TIPS.services;

  return tipSet[dayOfWeek % tipSet.length];
}

/**
 * Build the morning message for one user.
 */
function buildMorningMessage(firstName, businessType, yesterdayRevenue, yesterdayProfit) {
  const tip = getCoachingTip(businessType);

  if (yesterdayRevenue === 0) {
    // No entry logged yesterday
    return (
      `🌅 Good morning, ${firstName}! ☀️\n\n` +
      `A new day, a fresh chance to push your business forward.\n\n` +
      `💡 *Today's tip:*\n${tip}\n\n` +
      `When you close today, send me your numbers and I'll give you your full breakdown:\n` +
      `_"Made 50k today, spent 15k stock, 3k transport"_\n\n` +
      `Let's make today count! 📈`
    );
  }

  // They had data yesterday — show the result warmly
  const profitFormatted = '₦' + Number(Math.abs(yesterdayProfit)).toLocaleString('en-NG');
  let profitLine;
  if (yesterdayProfit > 0) {
    profitLine = `Yesterday you made *${profitFormatted} profit* 💰 That's real money in your pocket. Keep it going!`;
  } else if (yesterdayProfit === 0) {
    profitLine = `Yesterday you broke even — your revenue covered your expenses exactly. Push for profit today! 💪`;
  } else {
    profitLine = `Yesterday was tough — *${profitFormatted} loss*. Today is a fresh start. Every successful business has days like that. 💪`;
  }

  return (
    `🌅 Good morning, ${firstName}! ☀️\n\n` +
    `${profitLine}\n\n` +
    `💡 *Today's tip:*\n${tip}\n\n` +
    `Send me today's numbers when you close and I'll break it all down for you. 📊`
  );
}

/**
 * Main job — send morning message to every active user with a WhatsApp number.
 */
async function runMorningCoaching() {
  console.log(`[Morning Coaching] 🌟 Starting at ${new Date().toISOString()}`);

  try {
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

        // Get yesterday's totals
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

        const totals = await TransactionModel.getDailyTotals(user.id, yesterdayStr);
        const yesterdayRevenue = parseFloat(totals.revenue) || 0;
        const yesterdayProfit  = parseFloat(totals.profit)  || 0;

        const msg = buildMorningMessage(firstName, user.biz_type, yesterdayRevenue, yesterdayProfit);

        await WhatsAppService.sendMessage(user.whatsapp_number, msg);
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

// ── Schedule: 6:00 AM WAT every day ─────────────────────
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
