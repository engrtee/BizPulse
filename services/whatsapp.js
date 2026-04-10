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
async function sendEntryAck(to, firstName, { revenue, totalExpenses, profit, margin, customers, streak, topExpense, entryMethod }) {
  const fmt = (n) => Number(n).toLocaleString('en-NG');
  const marginStr = `${parseFloat(margin).toFixed(1)}%`;
  const profitAbs = Math.abs(profit);
  const s = parseInt(streak, 10) || 1;

  // Streak in header line
  let streakHeader = '';
  if (s === 1)    streakHeader = ' 🌱 Day 1 streak';
  else            streakHeader = ` 🔥 Day ${s} streak`;

  const prefix = entryMethod === 'voice' ? '🎤 Voice note logged' : '✅ Logged';

  const body =
    `${prefix} ${firstName}!${streakHeader}\n\n` +
    `Revenue:   ₦${fmt(revenue)}\n` +
    `Expenses:  ₦${fmt(totalExpenses)}\n` +
    `Profit:    ${profit < 0 ? '-' : ''}₦${fmt(profitAbs)}\n` +
    `Margin:    ${marginStr}\n` +
    (customers > 0 ? `\nCustomers today: ${customers}\n` : '\n') +
    (topExpense ? `Top expense: ${topExpense.category}\n` : '') +
    `\nYour full summary hits your inbox at 7pm 🎯`;

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
    `💰 Daily Sales:\n` +
    `"sales 45000 rent 5000 stock 12000"\n` +
    `"made 30k today, spent 10k on stock"\n\n` +
    `📦 Inventory Received:\n` +
    `"received 50 bags rice at 900 each"\n\n` +
    `📦 Inventory Sold:\n` +
    `"sold 12 bags rice today"\n\n` +
    `🔍 Stock Check:\n` +
    `"stock?" or "inventory?"\n\n` +
    `👥 Customers:\n` +
    `"customers 15" or "served 20 today"\n\n` +
    `📊 Summary:\n` +
    `"summary" or "report"\n\n` +
    `Your daily summary email arrives at 7pm every evening. 🎯`;

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
  const { revenue, totalExpenses, profit, margin, customers, topExpense, date } = summaryData;

  const profitLine = profit >= 0
    ? `✅ Profit:    ₦${fmt(profit)}`
    : `⚠️ Loss:      ₦${fmt(Math.abs(profit))}`;

  const dateLabel = new Date(date).toLocaleDateString('en-NG', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos',
  });

  // Use first action from AI rec as the WhatsApp insight — already specific to their biz
  const insight = (aiRec?.actions?.[0]) || (aiRec?.risk) || 'Keep tracking — consistency is what builds profitable businesses.';

  const lowStockLines = lowStock.length > 0
    ? `\n⚠️ Low stock: ${lowStock.map(i => `${i.item_name} (${Number(i.current_balance).toLocaleString('en-NG')} left)`).join(', ')}\n`
    : '';

  const body =
    `📊 *${firstName}, here's your ${dateLabel} summary*\n\n` +
    `Revenue:    ₦${fmt(revenue)}\n` +
    `Expenses:   ₦${fmt(totalExpenses)}\n` +
    `${profitLine}\n` +
    `Margin:     ${parseFloat(margin).toFixed(1)}%\n` +
    (customers > 0 ? `Customers:  ${customers}\n` : '') +
    (topExpense ? `Top cost:   ${topExpense.category} (₦${fmt(topExpense.amount)})\n` : '') +
    lowStockLines +
    `\n💡 *Insight:*\n${insight}\n\n` +
    `❓ *Ask me anything:* "Is my margin good?", "Should I raise prices?", or send "summary last 7 days" for trends.\n\n` +
    `Full report 👉 ${process.env.FRONTEND_URL || process.env.BASE_URL || 'https://mybizpulse.app'}`;

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
 * Send the first-time welcome + command guide to a new user.
 * Fires once — the moment they send their very first WhatsApp message.
 */
async function sendOnboarding(to, firstName) {
  const body =
    `Welcome to BizPulse, ${firstName}! 🎉\n\n` +
    `I'm your business assistant. Just message me your daily numbers and I'll track everything for you.\n\n` +
    `Here's what you can send me:\n\n` +
    `💰 Daily sales + expenses:\n` +
    `"Made 45k today, spent 10k on stock and 5k transport"\n\n` +
    `📦 Received stock:\n` +
    `"Received 50 bags rice at 900 each"\n\n` +
    `📦 Sold stock:\n` +
    `"Sold 12 bags rice today"\n\n` +
    `🔍 Check your stock:\n` +
    `"stock?" or "inventory?"\n\n` +
    `📊 Get your full report:\n` +
    `"summary" or "report"\n\n` +
    `❓ See all commands:\n` +
    `"help"\n\n` +
    `Your full summary email arrives every evening at 7pm. 🎯\n\n` +
    `Ready when you are — send me today's numbers! 💪`;

  return sendMessage(to, body);
}

/**
 * Notify user their phone number is not registered.
 */
async function sendNotRegistered(to) {
  const body =
    `👋 Hi! This number isn't registered on BizPulse yet.\n\n` +
    `Sign up at: ${process.env.BASE_URL}\n` +
    `It takes 2 minutes. 🚀`;
  return sendMessage(to, body);
}

module.exports = { sendMessage, sendEntryAck, sendMilestone, sendStockReply, sendHelp, sendNotRegistered, sendOnboarding, sendReminder, sendMorningBroadcast, sendEveningReminder, sendEveningSummaryWhatsApp };
