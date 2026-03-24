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

const BASE_URL = 'https://graph.facebook.com/v19.0';

/**
 * Send a plain-text WhatsApp message to a phone number.
 * @param {string} to   Recipient number in international format, e.g. "2348012345678"
 * @param {string} body Message text (up to 4096 chars)
 */
async function sendMessage(to, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token         = process.env.WHATSAPP_TOKEN;

  // Dev/staging: credentials not yet filled — log instead of crash
  if (!phoneNumberId || !token) {
    console.log(`[WhatsApp DEV] → ${to}\n${body}\n`);
    return { status: 'dev_mode', to, body };
  }

  try {
    const res = await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
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
 * @param {object} data        { revenue, totalExpenses, profit, margin, customers }
 */
async function sendEntryAck(to, firstName, { revenue, totalExpenses, profit, margin, customers, streak }) {
  const fmt = (n) => Number(n).toLocaleString('en-NG');
  const marginStr = `${parseFloat(margin).toFixed(1)}%`;
  const profitSign = profit >= 0 ? '' : '-';
  const s = parseInt(streak, 10) || 1;

  let streakLine = '';
  if (s === 1)      streakLine = '\n🌱 Day 1 streak — great start!';
  else if (s < 7)   streakLine = `\n🔥 ${s}-day streak — keep it going!`;
  else if (s < 14)  streakLine = `\n🔥 ${s}-day streak — one week strong!`;
  else if (s < 30)  streakLine = `\n🔥🔥 ${s}-day streak — you're crushing it!`;
  else              streakLine = `\n🏆 ${s}-day streak — absolute legend!`;

  const body =
    `✅ Logged ${firstName}!\n\n` +
    `Revenue:  ₦${fmt(revenue)}\n` +
    `Expenses: ₦${fmt(totalExpenses)}\n` +
    `Profit:   ${profitSign}₦${fmt(Math.abs(profit))} (${marginStr} margin)\n\n` +
    (customers > 0 ? `Customers today: ${customers}\n\n` : '') +
    `Your full summary hits your inbox at 7pm 🎯` +
    streakLine;

  return sendMessage(to, body);
}

/**
 * Send a 6pm reminder to users who haven't logged today.
 */
async function sendReminder(to, firstName, streak) {
  const s = parseInt(streak, 10) || 0;
  let streakWarning = '';
  if (s >= 3) streakWarning = `\n\n⚠️ Don't break your ${s}-day streak!`;

  const body =
    `👋 Hey ${firstName}, you haven't logged today's numbers yet.\n\n` +
    `Take 30 seconds now — just send:\n` +
    `"sales 50k expenses 15k"\n\n` +
    `Small habit, big results. 💪` +
    streakWarning;

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
 * Notify user their phone number is not registered.
 */
async function sendNotRegistered(to) {
  const body =
    `👋 Hi! This number isn't registered on BizPulse yet.\n\n` +
    `Sign up at: ${process.env.BASE_URL}\n` +
    `It takes 2 minutes. 🚀`;
  return sendMessage(to, body);
}

module.exports = { sendMessage, sendEntryAck, sendStockReply, sendHelp, sendNotRegistered, sendReminder };
