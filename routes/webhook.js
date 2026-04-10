/**
 * routes/webhook.js
 * Meta WhatsApp Business Cloud API webhook.
 *
 * GET  /webhook  → Verification handshake (Meta calls this once when you configure the webhook)
 * POST /webhook  → Receives all inbound WhatsApp messages
 *
 * Message routing logic:
 *   1. Parse message type with rule-based parser
 *   2. If needsAI, call Gemini to extract structured data
 *   3. Route to the correct service (transaction, inventory, customers)
 *   4. Write to PostgreSQL + Google Sheets
 *   5. Reply instantly on WhatsApp
 */

'use strict';

const express         = require('express');
const router          = express.Router();
const axios           = require('axios');

const UserModel       = require('../models/user');
const TransactionModel= require('../models/transaction');
const { MessageModel }= require('../models/db');
const { normalizePhone } = require('../utils/phone');

const ParserService   = require('../services/parser');
const GeminiService   = require('../services/gemini');
const ClaudeService   = require('../services/claude');
const WhatsAppService = require('../services/whatsapp');
const InventoryService= require('../services/inventory');
const CustomerService = require('../services/customers');
const SheetsService   = require('../services/sheets');
const EmailService    = require('../services/email');

const { calcHealthScore, healthLabel, topExpenseCategory, todayWAT } = require('../utils/formatter');
const { calcMargin } = require('../utils/naira');
const { parsePeriod } = require('../utils/periodParser');

// ─────────────────────────────────────────────
// GET /webhook — Meta verification handshake
// ─────────────────────────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[Webhook] ✅ Verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('[Webhook] ❌ Verification failed — check WHATSAPP_VERIFY_TOKEN');
  res.sendStatus(403);
});

// ─────────────────────────────────────────────
// POST /webhook — Inbound message handler
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  // Always acknowledge immediately — Meta will retry if you don't respond 200 within 20s
  res.sendStatus(200);

  try {
    const body = req.body;

    // Validate this is a WhatsApp message event
    if (body.object !== 'whatsapp_business_account') return;
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return;

    const value   = body.entry[0].changes[0].value;
    const msg     = value.messages[0];
    const contact = value.contacts?.[0];

    // Only handle text and audio (voice note) messages
    if (msg.type !== 'text' && msg.type !== 'audio') return;

    const from = normalizePhone(msg.from); // canonical 234XXXXXXXXXX format
    const name = contact?.profile?.name || 'there';
    let text        = '';
    let entryMethod = 'text';

    if (msg.type === 'text') {
      text = msg.text.body.trim();
      console.log(`[Webhook] Text message from ${from}: "${text}"`);
    } else {
      // ── Audio / voice note ──
      entryMethod = 'voice';
      const mediaId = msg.audio?.id;
      console.log(`[Webhook] Voice note from ${from}, media_id: ${mediaId}`);

      // Look up user early so we can send a holding message
      const voiceUser = await UserModel.findByWhatsapp(from);
      if (!voiceUser) {
        await WhatsAppService.sendNotRegistered(from);
        return;
      }

      // Acknowledge receipt immediately so the user knows we're working
      await WhatsAppService.sendMessage(from,
        `🎤 Got your voice note, ${voiceUser.name.split(' ')[0]}! Give me a moment...`
      ).catch(() => {});

      try {
        const { buffer, mimeType } = await downloadWhatsAppAudio(mediaId);
        const { transcript, confidence } = await GeminiService.transcribeAudio(buffer, mimeType, voiceUser);

        if (!transcript || confidence < 0.5) {
          await WhatsAppService.sendMessage(from,
            `🎤 I couldn't make out your voice note clearly, ${voiceUser.name.split(' ')[0]}.\n\n` +
            `Could you type your numbers instead?\nExample: "Made 45k today, spent 10k on stock"`);
          return;
        }

        console.log(`[Webhook] Voice transcribed (confidence: ${confidence.toFixed(2)}): "${transcript}"`);
        text = transcript;

        if (confidence < 0.7) {
          console.log(`[Webhook] Low-confidence voice transcript (${confidence.toFixed(2)}) — processing anyway`);
        }
      } catch (err) {
        console.error('[Webhook] Audio processing failed:', err.message);
        await WhatsAppService.sendMessage(from,
          `🎤 Sorry, I had trouble processing your voice note, ${voiceUser.name.split(' ')[0]}.\n\n` +
          `Please type your numbers — example:\n"Made 45k today, spent 10k on stock and 3k transport"`);
        return;
      }
    }

    // ── Look up user ──
    const user = await UserModel.findByWhatsapp(from);
    if (!user) {
      await WhatsAppService.sendNotRegistered(from);
      // Still log the unregistered attempt
      await MessageModel.logInbound(from, null, text).then(id =>
        MessageModel.updateLog(id, { intent: 'unregistered', status: 'no_user' })
      ).catch(() => {});
      return;
    }

    // ── Log inbound message (update with intent/result after processing) ──
    const msgLogId = await MessageModel.logInbound(from, user.id, text).catch(() => null);

    // ── New user onboarding: first ever WhatsApp message ──
    if (!user.first_message_date) {
      const firstName = user.name.split(' ')[0];
      await WhatsAppService.sendOnboarding(from, firstName);
      // Mark first_message_date so this never fires again
      await UserModel.touchLastEntry(user.id);
      await MessageModel.updateLog(msgLogId, { intent: 'onboarding', status: 'processed' }).catch(() => {});
      return;
    }

    // ── NPS response detection (email rating tap: "Rating: 4") ──
    const npsMatch = text.match(/^Rating:\s*([1-5])$/i);
    if (npsMatch) {
      const rating = parseInt(npsMatch[1], 10);
      await MessageModel.updateLog(msgLogId, { intent: 'nps_response', parsedData: { rating }, status: 'processed' }).catch(() => {});
      const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
      await WhatsAppService.sendMessage(from,
        `${stars} Thanks for rating ${rating}/5, ${user.name.split(' ')[0]}!\n\n` +
        `Your feedback helps make BizPulse better for every business owner using it. 🙏`
      );
      return;
    }

    // ── Parse intent ──
    let { type, data, needsAI } = ParserService.parseMessage(text);

    // ── Upgrade with Gemini if needed ──
    if (needsAI) {
      const aiResult = await GeminiService.parseWithAI(text, user);
      type = aiResult.type || 'unknown';
      data = aiResult;

      // ── Fallback: if Gemini failed or returned unknown, try rule-based extraction ──
      if (type === 'unknown') {
        const revenue = ParserService.extractRevenue(text);
        if (revenue > 0) {
          const breakdown    = ParserService.extractExpenses(text);
          const totalExpenses = Object.values(breakdown).reduce((s, v) => s + v, 0);
          const profit       = revenue - totalExpenses;
          const margin       = revenue > 0 ? parseFloat(((profit / revenue) * 100).toFixed(2)) : 0;
          const custMatch    = text.match(/(\d+)\s*(?:customers?|clients?|people|transactions?)/i);
          const customers    = custMatch ? parseInt(custMatch[1], 10) : 0;
          type = 'daily_entry';
          data = { revenue, totalExpenses, expenseBreakdown: breakdown, profit, margin, customers };
        }
      }
    }

    // ── Route to correct handler ──
    switch (type) {

      case 'help': {
        await WhatsAppService.sendHelp(from);
        await MessageModel.updateLog(msgLogId, { intent: 'help', status: 'processed' }).catch(() => {});
        break;
      }

      case 'stock_check': {
        const items = await InventoryService.getStock(user.id);
        await WhatsAppService.sendStockReply(from, items);
        await MessageModel.updateLog(msgLogId, { intent: 'stock_check', status: 'processed' }).catch(() => {});
        break;
      }

      case 'summary': {
        await handleSummaryRequest(user, from);
        await MessageModel.updateLog(msgLogId, { intent: 'summary', status: 'processed' }).catch(() => {});
        break;
      }

      case 'on_demand_summary': {
        await handleOnDemandSummary(user, from, text);
        await MessageModel.updateLog(msgLogId, { intent: 'on_demand_summary', status: 'processed' }).catch(() => {});
        break;
      }

      case 'business_question': {
        await handleBusinessQuestion(user, from, text);
        await MessageModel.updateLog(msgLogId, { intent: 'business_question', status: 'processed' }).catch(() => {});
        break;
      }

      case 'daily_entry': {
        await handleDailyEntry(user, from, data, text, entryMethod);
        await MessageModel.updateLog(msgLogId, {
          intent: 'daily_entry',
          parsedData: { revenue: data.revenue, totalExpenses: data.totalExpenses, profit: data.profit },
          status: 'processed',
        }).catch(() => {});
        break;
      }

      case 'inventory_in': {
        if (!data.item || !data.quantity) {
          await WhatsAppService.sendMessage(from,
            "I couldn't quite get the item details. Try:\n\"received 50 bags rice at 900 each\"");
          await MessageModel.updateLog(msgLogId, { intent: 'inventory_in', status: 'parse_error' }).catch(() => {});
          break;
        }
        const rowIn = await InventoryService.receiveStock(user, data);
        await WhatsAppService.sendMessage(from,
          `✅ Stock updated!\n\n` +
          `📦 ${data.item}: +${data.quantity} units received\n` +
          `Balance: ${parseFloat(rowIn.current_balance).toLocaleString('en-NG')} units`);
        await MessageModel.updateLog(msgLogId, { intent: 'inventory_in', parsedData: data, status: 'processed' }).catch(() => {});
        break;
      }

      case 'inventory_out': {
        if (!data.item || !data.quantity) {
          await WhatsAppService.sendMessage(from,
            "I couldn't quite get the details. Try:\n\"sold 12 bags rice today\"");
          await MessageModel.updateLog(msgLogId, { intent: 'inventory_out', status: 'parse_error' }).catch(() => {});
          break;
        }
        const rowOut = await InventoryService.sellStock(user, data);
        await WhatsAppService.sendMessage(from,
          `✅ Sale recorded!\n\n` +
          `📦 ${data.item}: -${data.quantity} units sold\n` +
          `Balance: ${parseFloat(rowOut.current_balance).toLocaleString('en-NG')} units`);
        await MessageModel.updateLog(msgLogId, { intent: 'inventory_out', parsedData: data, status: 'processed' }).catch(() => {});
        break;
      }

      case 'customer_log': {
        const count = parseInt(data.count, 10) || 0;
        await CustomerService.logCustomers(user, count, text);
        await WhatsAppService.sendMessage(from,
          `✅ Logged ${count} customers today for ${user.name.split(' ')[0]}! 👥`);
        await MessageModel.updateLog(msgLogId, { intent: 'customer_log', parsedData: { count }, status: 'processed' }).catch(() => {});
        break;
      }

      case 'greeting':
      case 'question': {
        if (data.message) {
          await WhatsAppService.sendMessage(from, data.message);
        } else {
          await WhatsAppService.sendMessage(from,
            `Hey ${user.name.split(' ')[0]}! 👋 I'm your BizPulse data assistant. Send me your sales and expenses anytime — or type "help" to see what I can do.`);
        }
        // Update last_message_date/streak without inserting a 0-revenue transaction
        const newStreak = await UserModel.touchLastEntry(user.id);
        const s = parseInt(newStreak, 10) || 1;
        await WhatsAppService.sendMessage(from,
          `📅 Check-in logged — Day ${s} streak${s >= 3 ? ' 🔥' : ''}. Send your numbers whenever you're ready!`
        ).catch(() => {});
        await MessageModel.updateLog(msgLogId, { intent: type, status: 'processed' }).catch(() => {});
        break;
      }

      default: {
        await WhatsAppService.sendMessage(from,
          `I didn't quite get that, ${user.name.split(' ')[0]}.\n\nJust tell me how your business went today — like:\n"Made 45k today, spent 10k on stock and 3k transport"\n\nOr type "help" for commands. 😊`);
        await MessageModel.updateLog(msgLogId, { intent: 'unknown', status: 'unhandled' }).catch(() => {});
        break;
      }
    }
  } catch (err) {
    console.error('[Webhook] Unhandled error:', err.message);
  }
});

// ─────────────────────────────────────────────
// Internal: handle daily_entry messages
// ─────────────────────────────────────────────
async function handleDailyEntry(user, from, data, rawMessage, entryMethod = 'text') {
  const { revenue, totalExpenses, expenseBreakdown, profit, margin, customers, notes } = data;

  // Save to PostgreSQL
  await TransactionModel.create({
    userId: user.id,
    revenue,
    totalExpenses,
    expenseBreakdown,
    profit,
    margin,
    customers,
    notes: notes || rawMessage,
    rawMessage,
    entryMethod,
  });

  // Update last_entry_date and streak
  const newStreak = await UserModel.touchLastEntry(user.id);

  // Append to Google Sheets (non-blocking — failure must not block the WhatsApp reply)
  if (user.sheet_id) {
    SheetsService.appendTransaction(user, {
      date:             todayWAT(),
      revenue,
      totalExpenses,
      expenseBreakdown: expenseBreakdown || {},
      profit,
      margin,
      customers,
      notes:            notes || rawMessage,
    }).catch((err) => console.error('[Sheets] appendTransaction error:', err.message));
  }

  // ✅ CRITICAL FIX: Fetch TODAY'S CUMULATIVE TOTALS from all entries today (not just this entry)
  const date = todayWAT();
  const dailyTotals = await TransactionModel.getDailyTotals(user.id, date);
  const expenseBreakdowns = await TransactionModel.getExpenseBreakdowns(user.id, date);
  
  const cumulativeRevenue = parseFloat(dailyTotals.revenue) || 0;
  const cumulativeTotalExpenses = parseFloat(dailyTotals.total_expenses) || 0;
  const cumulativeProfit = parseFloat(dailyTotals.profit) || 0;
  const cumulativeMargin = cumulativeRevenue > 0 
    ? parseFloat(((cumulativeProfit / cumulativeRevenue) * 100).toFixed(2))
    : 0;
  const cumulativeCustomers = parseInt(dailyTotals.customers, 10) || 0;

  // Derive top expense from ALL TODAY'S ENTRIES (not just this one)
  const topExpense = topExpenseCategory(expenseBreakdowns);

  // Send instant WhatsApp acknowledgement with CUMULATIVE daily totals
  await WhatsAppService.sendEntryAck(from, user.name.split(' ')[0], {
    revenue: cumulativeRevenue,
    totalExpenses: cumulativeTotalExpenses,
    profit: cumulativeProfit,
    margin: cumulativeMargin,
    customers: cumulativeCustomers,
    streak: newStreak,
    topExpense,
    entryMethod,
  });

  // Milestone celebrations (non-blocking)
  const firstName = user.name.split(' ')[0];
  const totalMsgs = await UserModel.getTotalMessages(user.id);
  const s = parseInt(newStreak, 10) || 1;

  if (s === 1 && totalMsgs === 1) {
    WhatsAppService.sendMilestone(from, 'day1', { firstName }).catch(() => {});
  } else if (s === 7) {
    WhatsAppService.sendMilestone(from, 'streak7', { firstName }).catch(() => {});
  } else if (s === 30) {
    WhatsAppService.sendMilestone(from, 'streak30', { firstName }).catch(() => {});
  } else if (s === 100) {
    WhatsAppService.sendMilestone(from, 'streak100', { firstName }).catch(() => {});
  }
  if (totalMsgs === 10) {
    WhatsAppService.sendMilestone(from, 'entry10', { firstName }).catch(() => {});
  }
  if (parseFloat(cumulativeProfit) > 0 && totalMsgs === 1) {
    WhatsAppService.sendMilestone(from, 'first_profit', { firstName }).catch(() => {});
  }

  // Feedback prompt every 7th entry
  if (totalMsgs > 0 && totalMsgs % 7 === 0) {
    WhatsAppService.sendMessage(from,
      `🙏 You've logged ${totalMsgs} entries — that's real consistency, ${firstName}!\n\n` +
      `Quick question: what's *one thing* that would make BizPulse even more useful for your business?\n\n` +
      `Just reply to this message — every response is read personally. 👂`
    ).catch(() => {});
  }

  // If any expenses landed in "Other", ask for clarification
  if ((expenseBreakdown?.Other || 0) > 0) {
    const amt = Number(expenseBreakdown.Other).toLocaleString('en-NG');
    WhatsAppService.sendMessage(from,
      `📝 Quick one: ₦${amt} in expenses couldn't be categorised and was filed as "Other".\n\n` +
      `What was it for? E.g. "₦3k was transport, ₦2k was packaging"\n\n` +
      `This keeps your expense reports clean! 📊`
    ).catch(() => {});
  }
}

// ─────────────────────────────────────────────
// Internal: handle on-demand "summary" request
// ─────────────────────────────────────────────
async function handleSummaryRequest(user, from) {
  const { formatDate, calcHealthScore, healthLabel, topExpenseCategory } = require('../utils/formatter');
  const GeminiService  = require('../services/gemini');
  const EmailService   = require('../services/email');
  const InventoryModel = require('../models/inventory');

  const date = todayWAT();

  // Get today's totals from DB
  const totals     = await TransactionModel.getDailyTotals(user.id, date);
  const breakdowns = await TransactionModel.getExpenseBreakdowns(user.id, date);
  const lowStock   = await InventoryService.getLowStockAlerts(user.id);

  const revenue       = parseFloat(totals.revenue)       || 0;
  const totalExpenses = parseFloat(totals.total_expenses) || 0;
  const profit        = parseFloat(totals.profit)         || 0;
  const customers     = parseInt(totals.customers, 10)    || 0;
  const margin        = calcMargin(profit, revenue);
  const score         = calcHealthScore(margin);
  const hl            = healthLabel(score);
  const topExpense    = topExpenseCategory(breakdowns);

  const summaryData = { revenue, totalExpenses, profit, margin, healthScore: score, healthKey: hl.key, topExpense, customers, date };

  if (revenue === 0) {
    await WhatsAppService.sendMessage(from,
      `📊 No entries logged today yet, ${user.name.split(' ')[0]}.\n\nSend your sales and expenses first, then request your summary.`);
    return;
  }

  const aiRec = await GeminiService.generateRecommendation(summaryData, user);

  // Send email
  await EmailService.sendSummaryEmail(user, summaryData, aiRec, lowStock)
    .catch((err) => console.error('[Email] sendSummaryEmail error:', err.message));

  await WhatsAppService.sendMessage(from,
    `📩 Summary sent to ${user.email}!\n\nCheck your inbox — it includes your AI recommendation for today.`);
}

// ─────────────────────────────────────────────
// Internal: download audio from Meta Media API
// ─────────────────────────────────────────────
async function downloadWhatsAppAudio(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;

  // Step 1 — get the temporary download URL from Meta
  const metaRes = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { url, mime_type } = metaRes.data;

  // Step 2 — download the actual audio bytes
  const audioRes = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
  });

  return {
    buffer:   Buffer.from(audioRes.data),
    mimeType: mime_type || 'audio/ogg; codecs=opus',
  };
}

// ─────────────────────────────────────────────
// On-demand summary with period parsing
// ─────────────────────────────────────────────
async function handleOnDemandSummary(user, from, text) {
  const { parsePeriod } = require('../utils/periodParser');
  const { query } = require('../models/db');

  // Parse period from message (e.g. "show me last 7 days", "give me this month")
  const period = parsePeriod(text);
  const { startDate, endDate, label } = period;

  // Fetch transactions in date range
  const res = await query(
    `SELECT
       date,
       COALESCE(SUM(revenue), 0) as revenue,
       COALESCE(SUM(total_expenses), 0) as total_expenses,
       COALESCE(SUM(profit), 0) as profit,
       COALESCE(SUM(customers), 0) as customers,
       CASE WHEN SUM(revenue) > 0 THEN (SUM(profit) / SUM(revenue)) * 100 ELSE 0 END as margin
     FROM transactions
     WHERE user_id = $1 AND date >= $2 AND date <= $3
     GROUP BY date
     ORDER BY date DESC`,
    [user.id, startDate, endDate]
  );

  const rows = res.rows;

  if (rows.length === 0) {
    await WhatsAppService.sendMessage(from,
      `📊 No data recorded for ${label.toLowerCase()}, ${user.name.split(' ')[0]}.\n\n` +
      `Start logging your business numbers — Send:\n"Made 50k today, spent 15k on stock"`);
    return;
  }

  // Calculate totals across period
  const totalRevenue = rows.reduce((s, r) => s + parseFloat(r.revenue), 0);
  const totalExpenses = rows.reduce((s, r) => s + parseFloat(r.total_expenses), 0);
  const totalProfit = rows.reduce((s, r) => s + parseFloat(r.profit), 0);
  const totalCustomers = rows.reduce((s, r) => s + parseInt(r.customers), 0);
  const avgMargin = totalRevenue > 0 ? parseFloat(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0;

  const fmt = (n) => Number(n).toLocaleString('en-NG');
  const profitAbs = Math.abs(totalProfit);

  const summary = `📊 *${label}* Summary for ${user.name.split(' ')[0]}\n\n` +
    `Days logged: ${rows.length}\n` +
    `Total Revenue: ₦${fmt(totalRevenue)}\n` +
    `Total Expenses: ₦${fmt(totalExpenses)}\n` +
    `Total Profit: ${totalProfit < 0 ? '-' : ''}₦${fmt(profitAbs)}\n` +
    `Average Margin: ${avgMargin}%\n` +
    `Total Customers: ${totalCustomers}\n\n` +
    `Get insights → Send "summary" for today's full breakdown 📈`;

  await WhatsAppService.sendMessage(from, summary);
}

// ─────────────────────────────────────────────
// Business coaching question handler
// ─────────────────────────────────────────────
async function handleBusinessQuestion(user, from, question) {
  const firstName = user.name.split(' ')[0];

  // Send thinking message
  await WhatsAppService.sendMessage(from,
    `🤔 Let me analyze your numbers and get you advice, ${firstName}... (moment please)`).catch(() => {});

  try {
    // Gather user's financial data
    const userData = await gatherUserFinancialData(user.id);

    // If too little data, ask them to log more
    if(!userData.history || userData.history.length < 3) {
      await WhatsAppService.sendMessage(from,
        `I need a bit more data to give you solid advice, ${firstName}! 📊\n\n` +
        `You've logged ${userData.history?.length || 0} entries. Once you hit 3-5, I can spot real patterns.\n\n` +
        `Keep sending your daily numbers — I'll get smarter every day!`);
      return;
    }

    // Use Claude for personalized coaching
    const coaching = await ClaudeService.answerBusinessQuestion(question, user, userData);

    await WhatsAppService.sendMessage(from, coaching);

    // Offer next step
    await WhatsAppService.sendMessage(from,
      `💡 Want another insight? Just ask me anything about your business!\n\n` +
      `Examples:\n• "Is my margin good?"\n• "Should I raise prices?"\n• "Why are expenses so high?"`
    ).catch(() => {});
  } catch (err) {
    console.error('[Webhook] Business question failed:', err.message);
    await WhatsAppService.sendMessage(from,
      `Sorry, I had trouble analyzing your data right now, ${firstName}.\n\nTry again in a moment! 🔄`);
  }
}

// ─────────────────────────────────────────────
// Helper: Gather all financial data for a user
// ─────────────────────────────────────────────
async function gatherUserFinancialData(userId) {
  const { query } = require('../models/db');

  // Get last 30 days of transactions
  const historyRes = await query(
    `SELECT date, revenue, total_expenses, profit, margin, customers
     FROM transactions 
     WHERE user_id = $1 
     ORDER BY date DESC 
     LIMIT 30`,
    [userId]
  );

  // Calculate averages
  const history = historyRes.rows;
  const avgRevenue = history.length > 0 ? history.reduce((s, r) => s + parseFloat(r.revenue), 0) / history.length : 0;
  const avgExpenses = history.length > 0 ? history.reduce((s, r) => s + parseFloat(r.total_expenses), 0) / history.length : 0;
  const avgMargin = history.length > 0 ? history.reduce((s, r) => s + parseFloat(r.margin), 0) / history.length : 0;

  // Get inventory
  const inventoryRes = await query(
    `SELECT item_name, current_balance, unit_price, total_ever_received 
     FROM inventory 
     WHERE user_id = $1`,
    [userId]
  );

  return {
    history,
    avgMetrics: { avgRevenue, avgExpenses, avgMargin },
    inventory: inventoryRes.rows || [],
  };
}

module.exports = router;
