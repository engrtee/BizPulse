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

const ParserService   = require('../services/parser');
const GeminiService   = require('../services/gemini');
const WhatsAppService = require('../services/whatsapp');
const InventoryService= require('../services/inventory');
const CustomerService = require('../services/customers');
const SheetsService   = require('../services/sheets');
const EmailService    = require('../services/email');

const { calcHealthScore, healthLabel, topExpenseCategory, todayWAT } = require('../utils/formatter');
const { calcMargin } = require('../utils/naira');

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

    const from = msg.from; // phone number e.g. "2348012345678"
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

        // If confidence is borderline, note it in the entry — processing continues normally
        if (confidence < 0.7) {
          text = transcript + ` [voice note — please verify amounts]`;
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
        break;
      }

      case 'stock_check': {
        const items = await InventoryService.getStock(user.id);
        await WhatsAppService.sendStockReply(from, items);
        break;
      }

      case 'summary': {
        // Trigger an on-demand email and reply on WhatsApp
        await handleSummaryRequest(user, from);
        break;
      }

      case 'daily_entry': {
        await handleDailyEntry(user, from, data, text, entryMethod);
        break;
      }

      case 'inventory_in': {
        if (!data.item || !data.quantity) {
          await WhatsAppService.sendMessage(from,
            "I couldn't quite get the item details. Try:\n\"received 50 bags rice at 900 each\"");
          break;
        }
        const row = await InventoryService.receiveStock(user, data);
        await WhatsAppService.sendMessage(from,
          `✅ Stock updated!\n\n` +
          `📦 ${data.item}: +${data.quantity} units received\n` +
          `Balance: ${parseFloat(row.current_balance).toLocaleString('en-NG')} units`);
        break;
      }

      case 'inventory_out': {
        if (!data.item || !data.quantity) {
          await WhatsAppService.sendMessage(from,
            "I couldn't quite get the details. Try:\n\"sold 12 bags rice today\"");
          break;
        }
        const row = await InventoryService.sellStock(user, data);
        await WhatsAppService.sendMessage(from,
          `✅ Sale recorded!\n\n` +
          `📦 ${data.item}: -${data.quantity} units sold\n` +
          `Balance: ${parseFloat(row.current_balance).toLocaleString('en-NG')} units`);
        break;
      }

      case 'customer_log': {
        const count = parseInt(data.count, 10) || 0;
        await CustomerService.logCustomers(user, count, text);
        await WhatsAppService.sendMessage(from,
          `✅ Logged ${count} customers today for ${user.name.split(' ')[0]}! 👥`);
        break;
      }

      case 'greeting':
      case 'question': {
        // Gemini already composed a warm reply — send it directly
        if (data.message) {
          await WhatsAppService.sendMessage(from, data.message);
        } else {
          await WhatsAppService.sendMessage(from,
            `Hey ${user.name.split(' ')[0]}! 👋 I'm your BizPulse data assistant. Send me your sales and expenses anytime — or type "help" to see what I can do.`);
        }
        // Still create a zero-entry transaction so the streak advances
        await TransactionModel.create({
          userId: user.id, revenue: 0, totalExpenses: 0,
          expenseBreakdown: {}, profit: 0, margin: 0, customers: 0,
          notes: 'Check-in (no numbers logged)', rawMessage: text,
        });
        const newStreak = await UserModel.touchLastEntry(user.id);
        const firstName = user.name.split(' ')[0];
        const s = parseInt(newStreak, 10) || 1;
        // Append streak line to let the user know it counted
        await WhatsAppService.sendMessage(from,
          `📅 Check-in logged — Day ${s} streak${s >= 3 ? ' 🔥' : ''}. Send your numbers whenever you're ready!`
        ).catch(() => {});
        break;
      }

      default: {
        await WhatsAppService.sendMessage(from,
          `I didn't quite get that, ${user.name.split(' ')[0]}.\n\nJust tell me how your business went today — like:\n"Made 45k today, spent 10k on stock and 3k transport"\n\nOr type "help" for commands. 😊`);
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

  // Derive top expense from this entry's breakdown
  const topExpense = topExpenseCategory([expenseBreakdown || {}]);

  // Send instant WhatsApp acknowledgement
  await WhatsAppService.sendEntryAck(from, user.name.split(' ')[0], {
    revenue, totalExpenses, profit, margin, customers, streak: newStreak, topExpense,
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
  if (parseFloat(profit) > 0 && totalMsgs === 1) {
    // First entry and profitable
    WhatsAppService.sendMilestone(from, 'first_profit', { firstName }).catch(() => {});
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

module.exports = router;
