/**
 * jobs/morningCoaching.js
 * Daily 6am WAT morning message to all active users with a WhatsApp number.
 *
 * Each message is personalised using:
 *   1. Business persona  (craft_identity, craft_emoji, key_metric, peak_season)
 *   2. Yesterday's actual numbers (revenue, profit, margin %, top expense, customers)
 *   3. User's location   (state — referenced in tip where relevant)
 *   4. Performance-aware tip selection:
 *        - margin < 15%          → margin improvement tip
 *        - expenses > 60% rev    → expense control tip
 *        - otherwise             → rotating tip by day of week + biz type
 *   5. New user reminder for first 7 days (no logged data yet — build the habit)
 *
 * Runs every day at 6:00 AM Africa/Lagos timezone.
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel        = require('../models/user');
const TransactionModel = require('../models/transaction');
const WhatsAppService  = require('../services/whatsapp');
const { getPersona }   = require('../services/personaEngine');
const { query }        = require('../models/db');

// ── Rotating tips by business type (7 per category — one per day of week) ──
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
  beauty: [
    'Your repeat clients are your most reliable income. Keep a list of who comes every 2–4 weeks.',
    'Premium service justifies premium pricing. If your clients never complain about price, you may be charging too little.',
    'A before-and-after photo from a satisfied client is worth more than any paid advert.',
    'Know your busiest hours and make sure you are never short-staffed or out of products then.',
    'Product cost eats margin quietly. Review what you spend on consumables vs what you earn per client.',
    'Wedding season and festive periods fill your calendar fast — plan your pricing and capacity now.',
    'A client who books again within 2 weeks is your most valuable customer. Track who does this.',
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

// ── Performance-aware tips (override day-of-week rotation when triggered) ──
const MARGIN_TIPS = {
  fashion:  'Your margin is tight right now. Review your fabric cost per outfit — even ₦500 off per unit adds up significantly across your week.',
  food:     'Your margin is tight right now. Check your cost per plate — portion size or ingredient cost may have crept up without a matching price increase.',
  retail:   'Your margin is tight right now. Look at which items have the best markup and push those. Slow-moving stock at full price hurts twice.',
  beauty:   'Your margin is tight right now. Review what you spend on products per client vs what you charge. Small leaks add up.',
  services: 'Your margin is tight right now. Check if you are spending hours on low-paying work that crowds out better clients.',
  default:  'Your margin is tight right now. Review your biggest expense category — even a 10% reduction there could transform your profitability this week.',
};

const EXPENSE_TIPS = {
  fashion:  'Your expenses were very high yesterday relative to sales. Check your fabric and material spend — are you buying ahead of confirmed orders or restocking from actual demand?',
  food:     'Your expenses were very high yesterday relative to sales. Ingredient and prep costs may be outpacing revenue. Track your cost per plate against your selling price.',
  retail:   'Your expenses were very high yesterday relative to sales. Review what you restocked yesterday — was it for confirmed demand or just habit?',
  beauty:   'Your expenses were very high yesterday relative to sales. Product spend for a single day should not exceed 30% of revenue. Check yesterday\'s consumable usage.',
  services: 'Your expenses were very high yesterday relative to sales. Service businesses with high expenses often have untracked overhead — staff time, transport, data.',
  default:  'Your expenses were very high yesterday relative to sales. Identify your top spending category and ask: can this be reduced or negotiated this week?',
};

// ── Helpers ───────────────────────────────────────────────────────────────
function getTipCategory(bizType) {
  const b = (bizType || '').toLowerCase();
  if (/fashion|cloth|sewing|tailor|ankara|fabric|garment/i.test(b)) return 'fashion';
  if (/food|restaurant|bakery|catering|cook|buka|canteen|pastry|cake|eatery/i.test(b)) return 'food';
  if (/retail|shop|trading|fmcg|supermarket|provisions|store/i.test(b)) return 'retail';
  if (/beauty|hair|nail|makeup|salon|spa|barb|wig|lace|braid|cosmetic/i.test(b)) return 'beauty';
  if (/service|consult|tech|advertis|education|photo|project|media/i.test(b)) return 'services';
  return 'default';
}

/** Merge expense_breakdown JSONBs and return the top category name */
function getTopExpense(breakdowns) {
  const merged = {};
  for (const b of (breakdowns || [])) {
    if (!b) continue;
    for (const [cat, amt] of Object.entries(b)) {
      merged[cat] = (merged[cat] || 0) + parseFloat(amt || 0);
    }
  }
  if (!Object.keys(merged).length) return null;
  return Object.entries(merged).sort((a, b) => b[1] - a[1])[0][0];
}

/** ₦ short format */
function nairaShort(amount) {
  const n = parseFloat(amount) || 0;
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 1_000)     return `₦${Math.round(n / 1_000)}k`;
  return `₦${Math.round(n)}`;
}

/** Select the right coaching tip based on performance data */
function selectTip(bizType, margin, expenseRatio, persona) {
  const cat = getTipCategory(bizType);

  // Performance-aware overrides
  if (margin > 0 && margin < 15) {
    return MARGIN_TIPS[cat] || MARGIN_TIPS.default;
  }
  if (expenseRatio > 0.6) {
    return EXPENSE_TIPS[cat] || EXPENSE_TIPS.default;
  }

  // Rotating tip by day of week
  const dayOfWeek = new Date().getDay();
  const tipSet    = TIPS[cat] || TIPS.default;
  return tipSet[dayOfWeek % tipSet.length];
}

/** How many days since user registered */
async function getDaysSinceRegistration(userId) {
  const res = await query(
    `SELECT created_at FROM users WHERE id = $1`,
    [userId]
  );
  if (!res.rows.length) return 999;
  const diff = Date.now() - new Date(res.rows[0].created_at).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// ── Message builders ──────────────────────────────────────────────────────

/**
 * Message for users with no entry logged yesterday.
 * Personalised by persona + location + new-user status.
 */
function buildNoDataMessage(firstName, bizType, state, persona, isNewUser, daysSinceReg) {
  const emoji    = persona.craft_emoji    || '📊';
  const identity = persona.craft_identity || 'a Nigerian business owner building something real';
  const metric   = persona.key_metric     || 'daily profit';
  const exAmt    = nairaShort(persona.example_amount || 30000);
  const exExp    = nairaShort((persona.example_amount || 30000) * 0.3);
  const exItem   = persona.example_expense || 'operations';
  const location = state ? ` in ${state}` : '';

  const tip = selectTip(bizType, 0, 0, persona);

  if (isNewUser && daysSinceReg <= 3) {
    // Very new user — build the habit
    return (
      `🌅 Good morning, ${firstName}! ${emoji}\n\n` +
      `Welcome to BizPulse. You are now among the smart ${bizType || 'business'} owners${location} who track their numbers daily.\n\n` +
      `To become *${identity}*, you need one habit above everything else — *knowing your numbers every day*.\n\n` +
      `Today is your chance to start. Just send:\n` +
      `_"made ${exAmt} today spent ${exExp} on ${exItem}"_\n\n` +
      `I will calculate your *${metric}* instantly. 📈`
    );
  }

  if (isNewUser && daysSinceReg <= 7) {
    // Early days — reinforce the habit with a tip
    return (
      `🌅 Good morning, ${firstName}! ${emoji}\n\n` +
      `A new day — another chance to build the habit that separates growing businesses from ones that guess.\n\n` +
      `💡 *Today's insight for your ${bizType || 'business'}${location}:*\n${tip}\n\n` +
      `Send me today's numbers when you close:\n` +
      `_"made ${exAmt} today spent ${exExp} on ${exItem}"_\n\n` +
      `Your *${metric}* breakdown will be ready instantly. 📊`
    );
  }

  // Regular user with no yesterday data
  return (
    `🌅 Good morning, ${firstName}! ☀️\n\n` +
    `A new day, a fresh chance to push your ${bizType || 'business'} forward.\n\n` +
    `💡 *Today's insight:*\n${tip}\n\n` +
    `When you close today, send me your numbers:\n` +
    `_"made ${exAmt} today spent ${exExp} on ${exItem}"_\n\n` +
    `Let's make today count! 📈`
  );
}

/**
 * Message for users who had data yesterday.
 * Personalised by actual profit, margin, top expense, customers, location + persona.
 */
function buildDataMessage(firstName, bizType, state, persona, revenue, profit, margin, customers, topExpense) {
  const emoji    = persona.craft_emoji || '📊';
  const metric   = persona.key_metric  || 'daily profit';
  const exAmt    = nairaShort(persona.example_amount || 30000);
  const exExp    = nairaShort((persona.example_amount || 30000) * 0.3);
  const exItem   = persona.example_expense || 'operations';
  const location = state ? ` in ${state}` : '';

  const expenseRatio = revenue > 0 ? (revenue - profit) / revenue : 0;
  const tip          = selectTip(bizType, margin, expenseRatio, persona);

  // Profit line
  let profitLine;
  if (profit > 0) {
    const marginStr = margin > 0 ? ` (${margin.toFixed(1)}% margin)` : '';
    profitLine = `Yesterday you made *${nairaShort(profit)} profit*${marginStr} 💰`;
    if (margin >= 30) {
      profitLine += ` That is a strong margin for a ${bizType || 'business'}${location}. Keep it going!`;
    } else if (margin >= 15) {
      profitLine += ` Solid result — watch your *${topExpense || metric}* to push that margin higher.`;
    } else {
      profitLine += ` Your margin is tighter than ideal — today's tip addresses that directly.`;
    }
  } else if (profit === 0) {
    profitLine = `Yesterday you broke even — revenue covered expenses exactly. Push for profit today! 💪`;
  } else {
    profitLine = `Yesterday was tough — *${nairaShort(Math.abs(profit))} loss*. Every successful ${bizType || 'business'}${location} has days like that. Today is a fresh start. 💪`;
  }

  // Customer line (only if logged)
  const customerLine = customers > 0
    ? `\nCustomers yesterday: *${customers}* — that is your audience for today.`
    : '';

  // Top expense line (only if available)
  const expenseLine = topExpense
    ? `\nTop expense yesterday: *${topExpense}* — keep an eye on this category.`
    : '';

  return (
    `🌅 Good morning, ${firstName}! ${emoji}\n\n` +
    `${profitLine}${customerLine}${expenseLine}\n\n` +
    `💡 *Today's insight for your ${bizType || 'business'}${location}:*\n${tip}\n\n` +
    `Send me today's numbers when you close and I'll break it all down. 📊\n` +
    `_"made ${exAmt} today spent ${exExp} on ${exItem}"_`
  );
}

// ── Main job ──────────────────────────────────────────────────────────────
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

        // Get yesterday's date in WAT
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

        // Fetch persona + daily totals + expense breakdowns in parallel
        const [persona, totals, breakdowns, daysSinceReg] = await Promise.all([
          getPersona(user),
          TransactionModel.getDailyTotals(user.id, yesterdayStr),
          TransactionModel.getExpenseBreakdowns(user.id, yesterdayStr),
          getDaysSinceRegistration(user.id),
        ]);

        const revenue   = parseFloat(totals?.revenue)  || 0;
        const profit    = parseFloat(totals?.profit)   || 0;
        const customers = parseInt(totals?.customers,10) || 0;
        const margin    = revenue > 0
          ? parseFloat(((profit / revenue) * 100).toFixed(2))
          : 0;
        const topExpense = getTopExpense(breakdowns);
        const isNewUser  = daysSinceReg <= 7;

        let msg;
        if (revenue === 0) {
          msg = buildNoDataMessage(firstName, user.biz_type, user.state, persona, isNewUser, daysSinceReg);
        } else {
          msg = buildDataMessage(firstName, user.biz_type, user.state, persona, revenue, profit, margin, customers, topExpense);
        }

        await WhatsAppService.sendMessage(user.whatsapp_number, msg);
        console.log(`[Morning Coaching] ✅ Sent to ${user.name} (margin: ${margin}%, isNew: ${isNewUser})`);
      } catch (err) {
        console.error(`[Morning Coaching] ❌ Failed for ${user.name}:`, err.message);
      }
    }

    console.log('[Morning Coaching] ✅ Completed.');
  } catch (err) {
    console.error('[Morning Coaching] Fatal error:', err.message);
  }
}

// ── Schedule: 6:00 AM WAT every day ──────────────────────────────────────
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
