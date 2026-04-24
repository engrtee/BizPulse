/**
 * services/whatsapp.js
 * Thin wrapper around the Meta WhatsApp Business Cloud API.
 *
 * All outbound messages go through sendMessage().
 * When WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TOKEN are blank,
 * messages are logged to console instead of sent (safe for dev).
 */

'use strict';

require('dotenv').config();
const axios = require('axios');
const { normalizePhone } = require('../utils/phone');
const { MessageModel } = require('../models/db');

const BASE_URL = 'https://graph.facebook.com/v19.0';

/**
 * Send a plain-text WhatsApp message to a phone number.
 * @param {string} to   Recipient number in any format, e.g. "08012345678", "+2348012345678", or "2348012345678"
 * @param {string} body Message text (up to 4096 chars)
 */
async function sendMessage(to, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token         = process.env.WHATSAPP_TOKEN;

  // Safety: normalize phone number to international format
  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) {
    console.error(`[WhatsApp] ❌ Invalid phone number: ${to}`);
    throw new Error(`Invalid phone number: ${to}`);
  }

  // Dev/staging: credentials not yet filled — log instead of crash
  if (!phoneNumberId || !token) {
    console.log(`[WhatsApp DEV] → ${normalizedTo}\n${body}\n`);
    MessageModel.logOutbound(normalizedTo, body).catch(() => {});
    return { status: 'dev_mode', to: normalizedTo, body };
  }

  try {
    const res = await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to: normalizedTo,
        type:              'text',
        text:              { preview_url: false, body },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    // Non-blocking: log every outbound message for admin monitoring
    MessageModel.logOutbound(normalizedTo, body).catch(() => {});
    return res.data;
  } catch (err) {
    console.error('[WhatsApp] Send error:', err?.response?.data || err.message);
    throw err;
  }
}

/**
 * Send the instant acknowledgement reply after a daily entry.
 * @param {string} to          WhatsApp number
 * @param {string} firstName   User's first name
 * @param {object} data        { revenue, totalExpenses, profit, margin, customers, streak, topExpense }
 */
async function sendEntryAck(to, firstName, { revenue, totalExpenses, profit, margin, customers, streak, topExpense, entryMethod, stockSummary }) {
  const fmt = (n) => Number(n).toLocaleString('en-NG');
  const marginStr = `${parseFloat(margin).toFixed(1)}%`;
  const profitAbs = Math.abs(profit);
  const s = parseInt(streak, 10) || 1;

  const streakHeader = s === 1 ? ' 🌱 Day 1 streak' : ` 🔥 Day ${s} streak`;
  const prefix = entryMethod === 'voice' ? '🎤 Voice note logged' : '✅ Logged';

  // Stock lines — show per-product update if available
  let stockLines = '';
  if (Array.isArray(stockSummary) && stockSummary.length > 0) {
    stockLines = '\n' + stockSummary.map(s =>
      `${s.name}: ${s.stock} ${s.unit} remaining ${s.emoji}`
    ).join('\n') + '\n';
  }

  const profitLine = profit >= 0
    ? `Profit:    ₦${fmt(profitAbs)}`
    : `Loss:      ₦${fmt(profitAbs)}`;

  const body =
    `${prefix} ${firstName}!${streakHeader}\n\n` +
    `Revenue:   ₦${fmt(revenue)}\n` +
    `Expenses:  ₦${fmt(totalExpenses)}\n` +
    `${profitLine}\n` +
    `Margin:    ${marginStr}\n` +
    (customers > 0 ? `\nCustomers: ${customers}\n` : '') +
    stockLines +
    `\nFull breakdown in your inbox at 7pm 🎯`;

  return sendMessage(to, body);
}

/**
 * Send a milestone celebration message.
 * Called after streak milestones or engagement milestones.
 * @param {string} to        WhatsApp number
 * @param {string} type      Milestone type key
 * @param {object} context   { firstName, streak, profit }
 */
async function sendMilestone(to, type, { firstName = '', streak = 0, profit = 0 } = {}) {
  let body = '';
  switch (type) {
    case 'day1':
      body = `🎉 Welcome ${firstName}! Your BizPulse journey starts today. Keep logging and I'll keep the insights coming.`;
      break;
    case 'streak7':
      body = `🔥 One week strong, ${firstName}! You're building a powerful habit. 7 days of data is already telling a story.`;
      break;
    case 'streak30':
      body = `📊 One month of data, ${firstName}! You can now see real trends in your business. Keep going!`;
      break;
    case 'streak100':
      body = `🏆 100 days, ${firstName}! You're a data champion. Your business intelligence puts you ahead of 99% of Nigerian SMEs.`;
      break;
    case 'first_profit':
      body = `💰 Profitable day, ${firstName}! Keep it going — consistency is what separates thriving businesses.`;
      break;
    case 'entry10':
      body = `📈 10 entries logged, ${firstName}! Your data is starting to tell a story. Check your Summary for trends.`;
      break;
    default:
      return;
  }
  return sendMessage(to, body);
}

/**
 * Send a 6pm reminder to users who haven't logged today.
 */
async function sendReminder(to, firstName, streak) {
  const s = parseInt(streak, 10) || 0;
  let streakLine = '';
  if (s >= 3)      streakLine = `\n\n🔥 ${s}-day streak on the line — don't break it now!`;
  else if (s >= 1) streakLine = `\n\n📈 Day ${s} — keep the habit going!`;

  const body =
    `Hey ${firstName} 👋 Have you logged today's numbers?\n\n` +
    `Just send: "Made 50k, spent 15k on stock"\n` +
    `I'll handle the rest. 📊` +
    streakLine;

  return sendMessage(to, body);
}

/**
 * Send the current stock levels to a user on "stock?" request.
 * @param {string}  to     WhatsApp number
 * @param {Array}   items  Array of inventory rows from DB
 */
async function sendStockReply(to, items) {
  if (!items || items.length === 0) {
    return sendMessage(to, '📦 No stock items recorded yet.\n\nSend something like:\n"received 50 bags rice at 900 each"\nto start tracking.');
  }

  const lines = items.map(
    (item) => `• ${item.item_name}: ${parseFloat(item.current_balance).toLocaleString('en-NG')} units`
  );

  const body = `📦 Current Stock\n\n${lines.join('\n')}`;
  return sendMessage(to, body);
}

/**
 * Send the help message.
 */
async function sendHelp(to) {
  const body =
    `📘 BizPulse Commands\n\n` +
    `📦 Set opening stock:\n` +
    `"I have 20 oud oil, 15 rose, 5 musk"\n` +
    `Or send a photo of your shelf\n\n` +
    `📦 Stock received from supplier:\n` +
    `"received 50 bags rice at 900 each"\n` +
    `Or send a photo of the receipt\n\n` +
    `📦 Stock sold:\n` +
    `"sold 12 bags rice today"\n\n` +
    `💰 Daily sales + expenses:\n` +
    `"made 45k today, spent 10k on stock"\n\n` +
    `🔍 Check stock levels:\n` +
    `"stock?"\n\n` +
    `📊 Buying calculator:\n` +
    `Send a receipt photo with caption: "35% margin"\n\n` +
    `📊 Summary:\n` +
    `"summary" or "last 7 days"\n\n` +
    `Your full breakdown hits your inbox at 7pm. 🎯`;

  return sendMessage(to, body);
}

/**
 * Send the 7am morning broadcast — personalized with streak + quote.
 * @param {string} to        WhatsApp number
 * @param {string} firstName User's first name
 * @param {string} bizName   Their business name
 * @param {string} quote     The business quote for today
 * @param {number} streak    User's current streak
 */
async function sendMorningBroadcast(to, firstName, bizName, quote, streak) {
  const s = parseInt(streak, 10) || 0;
  let streakLine = '';
  if (s >= 2)       streakLine = `🔥 Day ${s} streak — keep it going!\n\n`;
  else if (s === 1) streakLine = `🌱 Day 1 streak — let's build it!\n\n`;
  else              streakLine = `📅 Today is a great day to start your streak.\n\n`;

  const body =
    `Good morning ${firstName}! ☀️\n\n` +
    streakLine +
    `"${quote}"\n\n` +
    `I'm here when you're ready to log today. 📊`;
  return sendMessage(to, body);
}

/**
 * Send the 7pm daily summary as a WhatsApp message.
 * Replaces (or supplements) the email — delivers highlights + AI insight directly.
 */
async function sendEveningSummaryWhatsApp(to, firstName, summaryData, aiRec, lowStock = []) {
  const fmt  = (n) => Number(n || 0).toLocaleString('en-NG');
  const { revenue, totalExpenses, profit, margin, customers, topExpense, topProducts, date } = summaryData;

  // Lead with top selling product if available
  let topLine = '';
  if (Array.isArray(topProducts) && topProducts.length > 0) {
    const top = topProducts[0];
    topLine = `Top seller: ${top.product_name} — ${top.units_sold || '?'} ${top.unit || 'units'} · ₦${fmt(top.revenue_today)}\n`;
    if (topProducts.length > 1) {
      topLine += topProducts.slice(1).map(p =>
        `${p.product_name} — ${p.units_sold || '?'} ${p.unit || 'units'} · ₦${fmt(p.revenue_today)}`
      ).join('\n') + '\n';
    }
    topLine += '\n';
  } else if (topExpense) {
    topLine = `Top cost: ${topExpense.category} · ₦${fmt(topExpense.amount)}\n\n`;
  }

  const profitLine = profit >= 0
    ? `Profit: ₦${fmt(profit)} · Margin: ${parseFloat(margin).toFixed(1)}%`
    : `Loss: ₦${fmt(Math.abs(profit))} · Margin: ${parseFloat(margin).toFixed(1)}%`;

  // Stock status for any low/critical items
  let stockNote = '';
  if (lowStock && lowStock.length > 0) {
    const alerts = lowStock.map(i => {
      const bal = parseFloat(i.current_balance || 0);
      return bal === 0
        ? `📦 ${i.item_name} — OUT OF STOCK`
        : `📦 ${i.item_name} — ${bal} units left (restock soon)`;
    });
    stockNote = '\n' + alerts.join('\n') + '\n';
  }

  // One specific action from AI
  const action = (aiRec?.actions?.[0]) || (aiRec?.risk) || null;

  const body =
    `📊 *${firstName}, today's summary*\n\n` +
    topLine +
    `Revenue: ₦${fmt(revenue)}\n` +
    `Stock cost: ₦${fmt(totalExpenses)}\n` +
    `${profitLine}\n` +
    (customers > 0 ? `Customers: ${customers}\n` : '') +
    stockNote +
    (action ? `\n${action}\n` : '') +
    `\nFull report 👉 mybizpulse.app`;

  return sendMessage(to, body);
}

/**
 * Send the 6pm reminder to users who haven't logged today.
 * (Alias kept for backward compatibility — sendReminder is the live version)
 */
async function sendEveningReminder(to, firstName, streak) {
  return sendReminder(to, firstName, streak);
}

/**
 * Send the first-time welcome to a new user.
 * Fires once — the moment they send their very first WhatsApp message.
 */
async function sendOnboarding(to, firstName) {
  const body =
    `Your BizPulse account is live, ${firstName}.\n\n` +
    `I track your stock, your sales, and your profit — all from WhatsApp. No apps to download.\n\n` +
    `First: tell me what stock you have right now.\n` +
    `• Voice note: _"I have 20 oud oil, 15 rose, 5 musk"_\n` +
    `• Photo of your shelf or stock list\n` +
    `• Or just type it out\n\n` +
    `Once I know your stock, I'll alert you before anything runs out.\n\n` +
    `After that, message me your daily sales. I'll send you a full profit breakdown every evening.\n\n` +
    `Ready when you are. 🚀`;

  return sendMessage(to, body);
}

/**
 * Send the opening stock request message.
 * Called after onboarding if opening_stock_logged is still false.
 * Personalised by biz_type if available.
 */
async function sendOpeningStockRequest(to, firstName, bizType) {
  const b = (bizType || '').toLowerCase();
  let example = '"I have [product] [quantity], [product] [quantity]"';
  let emoji = '📦';

  if (/fragrance|perfume|oil|scent/i.test(b)) {
    example = '"I have 20 oud oil, 15 rose, 5 musk oil"';
    emoji = '🧴';
  } else if (/retail|provision|fmcg|store|shop/i.test(b)) {
    example = '"I have 50 indomie, 30 peak milk, 20 cabin, 40 eva water"';
    emoji = '🏪';
  } else if (/fashion|cloth|tailor|fabric|ankara/i.test(b)) {
    example = '"I have 40 yards ankara, 20 yards lace, 30 yards george"';
    emoji = '👗';
  } else if (/food|restaurant|bakery|cook/i.test(b)) {
    example = '"I have 10 bags rice, 5 litres palm oil, 20 cartons eggs"';
    emoji = '🍲';
  } else if (/beauty|hair|salon|nail|makeup/i.test(b)) {
    example = '"I have 15 wigs, 10 relaxer packs, 20 hair cream"';
    emoji = '💅';
  }

  const body =
    `I need your current stock before I can watch anything for you. ${emoji}\n\n` +
    `Voice note, photo of your shelf, or type:\n${example}\n\n` +
    `One message. That's all it takes to switch on your stock alerts.`;

  return sendMessage(to, body);
}

/**
 * Send the morning stock briefing (Message 6).
 * Called by morningCoaching.js when opening_stock_logged = true.
 */
async function sendMorningStockBriefing(to, firstName, bizEmoji, products, lastUpdateDaysAgo) {
  if (!products || products.length === 0) return;

  const lines = products.map(p => {
    const stock    = parseFloat(p.current_stock) || 0;
    const velocity = parseFloat(p.velocity_per_day) || 0;
    let emoji = '🟢';
    let daysNote = '';

    if (stock === 0) {
      emoji = '🔴';
      daysNote = ' · OUT OF STOCK';
    } else if (velocity > 0) {
      const daysLeft = stock / velocity;
      if (daysLeft < 1)  { emoji = '🔴'; daysNote = ` · less than 1 day left`; }
      else if (daysLeft < 3) { emoji = '🟡'; daysNote = ` · ~${Math.round(daysLeft)} days left`; }
    } else if (stock < 5) {
      emoji = '🟡';
    }

    return `${emoji} ${p.product_name} — ${stock} ${p.unit || 'units'}${daysNote}`;
  });

  const staleness = lastUpdateDaysAgo >= 2
    ? `\n⚠️ Last update: ${lastUpdateDaysAgo} day${lastUpdateDaysAgo === 1 ? '' : 's'} ago. If you've sold or restocked since then, send me the update.\n`
    : '';

  // Find most urgent item for the action line
  const critical = products.find(p => {
    const s = parseFloat(p.current_stock) || 0;
    const v = parseFloat(p.velocity_per_day) || 0;
    return s === 0 || (v > 0 && s / v < 1);
  });
  const actionLine = critical
    ? `Reorder ${critical.product_name} today — you'll sell through before close.` +
      (critical.last_purchase_price ? ` Last purchase: ₦${Number(critical.last_purchase_price).toLocaleString('en-NG')}.` : '')
    : `Log today's sales whenever you're ready. 📊`;

  const body =
    `Morning ${firstName}! ${bizEmoji}\n\n` +
    `Your stock now:\n${lines.join('\n')}\n` +
    staleness +
    `\n${actionLine}`;

  return sendMessage(to, body);
}

/**
 * Notify user their phone number is not registered.
 */
async function sendNotRegistered(to) {
  const body =
    `👋 Hi! This number isn't registered on BizPulse yet.\n\n` +
    `Already have an account? Log in at mybizpulse.app, go to Settings, and add this WhatsApp number to your profile.\n\n` +
    `New here? Sign up free at: mybizpulse.app\n` +
    `It only takes 2 minutes. 🚀`;
  return sendMessage(to, body);
}

module.exports = {
  sendMessage,
  sendEntryAck,
  sendMilestone,
  sendStockReply,
  sendHelp,
  sendNotRegistered,
  sendOnboarding,
  sendOpeningStockRequest,
  sendMorningStockBriefing,
  sendReminder,
  sendMorningBroadcast,
  sendEveningReminder,
  sendEveningSummaryWhatsApp,
};
