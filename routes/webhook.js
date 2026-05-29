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

const ParserService      = require('../services/parser');
const GeminiService      = require('../services/gemini');
const ClaudeService      = require('../services/claude');
const WhatsAppService    = require('../services/whatsapp');
const InventoryService   = require('../services/inventory');
const CustomerService    = require('../services/customers');
const SheetsService      = require('../services/sheets');
const EmailService       = require('../services/email');
const { trackOutcome }   = require('../services/messageVariants');
const ConfirmationService = require('../services/confirmationService');
const ProductService      = require('../services/productService');
const ProductModel        = require('../models/product');
const DebtorModel         = require('../models/debtor');
const LearningService     = require('../services/learningService');
const OnboardingModel     = require('../models/onboarding');

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

    // Handle text, audio (voice note), and image messages
    if (msg.type !== 'text' && msg.type !== 'audio' && msg.type !== 'image') return;

    const from      = normalizePhone(msg.from); // canonical 234XXXXXXXXXX format
    const name      = contact?.profile?.name || 'there';
    const wasMsgId  = msg.id || null;          // Meta message ID — used for dedup
    let text        = '';
    let entryMethod = 'text';

    if (msg.type === 'text') {
      text = msg.text.body.trim();
      console.log(`[Webhook] Text message from ${from}: "${text}"`);
    } else if (msg.type === 'audio') {
      // ── Audio / voice note — transcribe then pass to Kemi ──
      entryMethod = 'voice';
      const mediaId = msg.audio?.id;
      console.log(`[Webhook] Voice note from ${from}, media_id: ${mediaId}`);

      const voiceUser = await UserModel.findByWhatsapp(from);
      if (!voiceUser) {
        const voiceSession = await OnboardingModel.getSession(from);
        if (voiceSession) {
          await WhatsAppService.sendMessage(from,
            `Almost there! Please reply to my last question as a text message to complete setup. 😊`);
        } else {
          await OnboardingModel.createSession(from);
          await WhatsAppService.sendMessage(from,
            `👋 Hi! Welcome to *BizPulse*.\n\n` +
            `Let's get you set up first — *what's your name?* 😊`
          );
        }
        return;
      }

      await WhatsAppService.sendMessage(from,
        `🎤 Got your voice note, ${voiceUser.name.split(' ')[0]}! Give me a moment...`
      ).catch(() => {});

      try {
        const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
        const { transcript, confidence } = await GeminiService.transcribeAudio(buffer, mimeType, voiceUser);
        console.log(`[Webhook] Voice transcribed (confidence: ${confidence.toFixed(2)}): "${transcript}"`);

        if (!transcript || confidence < 0.5) {
          await WhatsAppService.sendMessage(from,
            `🎤 I couldn't make out your voice note clearly, ${voiceUser.name.split(' ')[0]}.\n\n` +
            `Could you type your numbers instead?\nExample: "Made 45k today, spent 10k on stock"`);
          return;
        }

        // Hand transcript to Kemi — she handles all intent detection and logging
        text = transcript;

      } catch (err) {
        console.error('[Webhook] Audio processing failed:', err.message);
        await WhatsAppService.sendMessage(from,
          `🎤 Sorry, I had trouble processing your voice note, ${voiceUser.name.split(' ')[0]}.\n\n` +
          `Please type your numbers — example:\n"Made 45k today, spent 10k on stock and 3k transport"`);
        return;
      }
    }

    if (msg.type === 'image') {
      // ── Photo / image — routed through Kemi (Claude Vision) ──
      entryMethod = 'photo';
      const mediaId = msg.image?.id;
      const caption = (msg.image?.caption || '').trim();
      console.log(`[Webhook] Image from ${from}, media_id: ${mediaId}`);

      const photoUser = await UserModel.findByWhatsapp(from);
      if (!photoUser) {
        const photoSession = await OnboardingModel.getSession(from);
        if (photoSession) {
          await WhatsAppService.sendMessage(from,
            `Almost there! Please reply to my last question as a text message to complete setup. 😊`);
        } else {
          await OnboardingModel.createSession(from);
          await WhatsAppService.sendMessage(from,
            `👋 Hi! Welcome to *BizPulse*.\n\n` +
            `Let's get you set up first — *what's your name?* 😊`
          );
        }
        return;
      }

      await WhatsAppService.sendMessage(from,
        `📸 Got your photo, ${photoUser.name.split(' ')[0]}! Reading it now...`
      ).catch(() => {});

      try {
        const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
        const imageBase64   = buffer.toString('base64');
        const imageMimeType = (mimeType || 'image/jpeg').split(';')[0];
        const promptText    = caption ||
          'I sent you a photo of my stock notebook or receipt. Please read every item and quantity you can see and log them for me.';

        const { runAgent } = require('../src/agent/agentLoop');
        const kemisResponse = await runAgent(from, promptText, { imageBase64, imageMimeType });
        await WhatsAppService.sendMessage(from, kemisResponse);

        await MessageModel.logInbound(from, photoUser.id, promptText, wasMsgId).then(r =>
          MessageModel.updateLog(r?.id, { intent: 'kemi_image', status: 'processed' })
        ).catch(() => {});
      } catch (err) {
        console.error('[Webhook] Image processing failed:', err.message);
        await WhatsAppService.sendMessage(from,
          `📸 Had trouble reading that photo, ${photoUser.name.split(' ')[0]}.\n\n` +
          `You can type your stock instead:\n_"I have 20 bags rice, 10 cartons indomie"_`);
      }
      return;
    }

    // ── Look up user ──
    const user = await UserModel.findByWhatsapp(from);
    if (!user) {
      // Route to WhatsApp-native conversational registration
      const session = await OnboardingModel.getSession(from);
      if (session) {
        await handleOnboarding(from, text, session);
      } else {
        await OnboardingModel.createSession(from);
        await WhatsAppService.sendMessage(from,
          `👋 Hi! Welcome to *BizPulse* — your WhatsApp business tracker.\n\n` +
          `I help Nigerian business owners track sales, expenses, and stock — ` +
          `all from WhatsApp. No app needed.\n\n` +
          `*What's your name?* (Just your first name is fine 😊)`
        );
      }
      await MessageModel.logInbound(from, null, text, wasMsgId).then(r =>
        MessageModel.updateLog(r?.id, { intent: 'onboarding', status: 'in_progress' })
      ).catch(() => {});
      return;
    }

    // ── Dedup: skip if Meta already delivered this message_id ──
    const logResult = await MessageModel.logInbound(from, user.id, text, wasMsgId).catch(() => ({ id: null, duplicate: false }));
    if (logResult.duplicate) {
      console.log(`[Webhook] ⏭ Duplicate message_id ${wasMsgId} — skipping`);
      return;
    }
    const msgLogId = logResult.id;

    // ── New user onboarding: first ever WhatsApp message ──
    if (!user.first_message_date) {
      const firstName = user.name.split(' ')[0];
      await WhatsAppService.sendOnboarding(from, firstName, user.biz_type);
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

    // ── Confirmation intercept (YES / EDIT / CANCEL) ─────────────────────────
    const upperText = text.trim().toUpperCase();

    // CANCEL — only meaningful for oversell_confirmation
    if (upperText === 'CANCEL') {
      const pending = await ConfirmationService.getPendingEntry(user.id);
      if (pending && pending.entry_type === 'oversell_confirmation') {
        await ConfirmationService.discardEntry(pending.id);
        await WhatsAppService.sendMessage(from,
          `✅ Sale cancelled. No changes made to your stock.`);
        await MessageModel.updateLog(msgLogId, { intent: 'oversell_cancel', status: 'processed' }).catch(() => {});
        return;
      }
    }

    if (upperText === 'YES' || upperText === 'Y' || upperText === 'CONFIRM') {
      const pending = await ConfirmationService.getPendingEntry(user.id);
      if (pending) {
        // Oversell YES — add missing stock then process sale
        if (pending.entry_type === 'oversell_confirmation') {
          await ConfirmationService.confirmEntry(pending.id);
          await handleOversellYes(user, from, pending);
          await MessageModel.updateLog(msgLogId, { intent: 'oversell_yes', status: 'processed' }).catch(() => {});
          return;
        }
        await ConfirmationService.confirmEntry(pending.id);

        // ── Learning: record correction if this YES follows an EDIT ──────────
        try {
          const editedEntry = await ConfirmationService.getRecentEditedEntry(user.id);
          if (editedEntry && editedEntry.id !== pending.id) {
            const origData = typeof editedEntry.parsed_data === 'string'
              ? JSON.parse(editedEntry.parsed_data) : editedEntry.parsed_data;
            const confData = typeof pending.parsed_data === 'string'
              ? JSON.parse(pending.parsed_data) : pending.parsed_data;
            LearningService.recordCorrection(
              user.id,
              user.state,
              { type: editedEntry.entry_type, data: origData, message: editedEntry.original_message },
              { type: pending.entry_type,     data: confData, message: pending.original_message }
            ).catch(e => console.error('[Learning] Hook error:', e.message));
          }
        } catch (e) {
          console.error('[Learning] Correction hook failed:', e.message);
        }
        // ─────────────────────────────────────────────────────────────────────

        await handleConfirmedEntry(user, from, pending);
        await MessageModel.updateLog(msgLogId, { intent: 'confirm_yes', status: 'processed' }).catch(() => {});
        return;
      }
      // No pending entry — fall through to normal parse
    } else if (upperText === 'EDIT' || upperText === 'NO' || upperText === 'N') {
      const pending = await ConfirmationService.getPendingEntry(user.id);
      if (pending) {
        // Oversell NO — sell from unlogged stock, cap at 0, log warning
        if (pending.entry_type === 'oversell_confirmation' && (upperText === 'NO' || upperText === 'N')) {
          await ConfirmationService.confirmEntry(pending.id);
          await handleOversellNo(user, from, pending);
          await MessageModel.updateLog(msgLogId, { intent: 'oversell_no', status: 'processed' }).catch(() => {});
          return;
        }
        await ConfirmationService.editEntry(pending.id);
        await WhatsAppService.sendMessage(from,
          `No problem, ${user.name.split(' ')[0]}! 📝\n\nSend me the corrected numbers and I'll log them.`);
        await MessageModel.updateLog(msgLogId, { intent: 'confirm_edit', status: 'processed' }).catch(() => {});
        return;
      }
      // No pending entry — fall through to normal parse
    }
    // ────────────────────────────────────────────────────────────────────────

    // ── Margin recalculation intercept (user replied with just a % number) ──
    const reCalcMatch = text.trim().match(/^(\d+)\s*%?$/);
    if (reCalcMatch) {
      const pending = await ConfirmationService.getPendingEntry(user.id);
      if (pending && pending.entry_type === 'calc_context') {
        const parsedCalc = typeof pending.parsed_data === 'string'
          ? JSON.parse(pending.parsed_data) : pending.parsed_data;
        const newMargin = parseInt(reCalcMatch[1]);
        const replyMsg  = buildCalcReply(parsedCalc.products || [], newMargin);
        await WhatsAppService.sendMessage(from, replyMsg);
        await ConfirmationService.savePending(user.id, 'calc_context',
          { ...parsedCalc, lastMargin: newMargin }, text);
        await MessageModel.updateLog(msgLogId, { intent: 'calc_recalculate', status: 'processed' }).catch(() => {});
        return;
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // ── Kemi Agent ──
    const { runAgent } = require('../src/agent/agentLoop');
    const kemisResponse = await runAgent(from, text);
    await WhatsAppService.sendMessage(from, kemisResponse);
    await MessageModel.updateLog(msgLogId, { intent: 'kemi_agent', status: 'processed' }).catch(() => {});
  } catch (err) {
    console.error('[Webhook] Unhandled error:', err.message);
  }
});

// ─────────────────────────────────────────────
// Internal: commit a confirmed pending entry
// ─────────────────────────────────────────────
async function handleConfirmedEntry(user, from, pending) {
  const { entry_type, parsed_data: data, original_message } = pending;
  const parsedData = typeof data === 'string' ? JSON.parse(data) : data;

  if (entry_type === 'daily_entry') {
    await handleDailyEntry(user, from, parsedData, original_message, 'text');
    return;
  }

  if (entry_type === 'inventory_in') {
    const hasProducts = Array.isArray(parsedData.products) && parsedData.products.length > 0;
    if (hasProducts) {
      const date = todayWAT();
      const summary = await ProductService.processProductTransactions(user.id, user, parsedData.products, null, date, WhatsAppService).catch(() => []);
      const lines = summary.length > 0
        ? summary.map(s => `📦 ${s.name}: ${s.stock} ${s.unit} now in stock`)
        : parsedData.products.map(p => `📦 ${p.product_name}: +${p.quantity || '?'} ${p.unit || 'units'} received`);
      await WhatsAppService.sendMessage(from, `✅ Stock updated!\n\n${lines.join('\n')}`);
    } else {
      const rowIn = await InventoryService.receiveStock(user, parsedData);
      await WhatsAppService.sendMessage(from,
        `✅ Stock updated!\n\n` +
        `📦 ${parsedData.item}: +${parsedData.quantity} units received\n` +
        `Balance: ${parseFloat(rowIn.current_balance).toLocaleString('en-NG')} units`);
    }
    return;
  }

  if (entry_type === 'oversell_confirmation') {
    // Handled via handleOversellYes / handleOversellNo — should not reach here directly
    return;
  }

  if (entry_type === 'inventory_out') {
    const hasProducts = Array.isArray(parsedData.products) && parsedData.products.length > 0;
    const isCredit    = parsedData.sale_type === 'credit';
    const debtorName  = parsedData.debtor_name || null;
    const fmt = (n) => Number(n || 0).toLocaleString('en-NG');

    // ── Oversell pre-flight check ──
    if (hasProducts && !isCredit) {
      const oversells = [];
      for (const p of parsedData.products) {
        if (p.transaction_type !== 'sale' || !p.quantity) continue;
        const found = await ProductService.findProductFuzzy(user.id, p.product_name).catch(() => null);
        if (!found) continue;
        const currentStock = await ProductModel.getCurrentStock(found.id);
        if (currentStock > 0 && parseFloat(p.quantity) > currentStock) {
          oversells.push({
            product_name:  found.product_name,
            product_id:    found.id,
            requested_qty: parseFloat(p.quantity),
            available_qty: currentStock,
            difference:    parseFloat(p.quantity) - currentStock,
          });
        }
      }
      if (oversells.length > 0) {
        await ConfirmationService.savePending(user.id, 'oversell_confirmation', {
          original_entry: parsedData,
          oversells,
        }, original_message);
        const question = ConfirmationService.buildOversellQuestion(oversells);
        await WhatsAppService.sendMessage(from, question);
        return;
      }
    }

    if (hasProducts) {
      const date    = todayWAT();
      const summary = await ProductService.processProductTransactions(user.id, user, parsedData.products, null, date, WhatsAppService).catch(() => []);
      const lines   = summary.length > 0
        ? summary.map(s => `📦 ${s.name}: ${s.stock} ${s.unit} remaining  ${s.emoji} ${s.status.replace('_', ' ').toLowerCase()}`)
        : parsedData.products.map(p => `📦 ${p.product_name}: -${p.quantity || '?'} ${p.unit || 'units'} sold`);

      if (isCredit && debtorName) {
        // Credit sale: stock deducted, no revenue yet — record the debt
        const creditTotal = parsedData.products.reduce((s, p) => s + parseFloat(p.total_amount || 0), 0);
        await DebtorModel.create({
          userId:      user.id,
          debtorName:  debtorName,
          amount:      creditTotal,
          productName: parsedData.products.map(p => p.product_name).join(', '),
          notes:       original_message,
        });
        await WhatsAppService.sendMessage(from,
          `📝 *Credit sale recorded!*\n\n` +
          `${lines.join('\n')}\n\n` +
          `💳 *${debtorName}* owes you ₦${fmt(creditTotal)}.\n\n` +
          `When they pay, send:\n_"${debtorName} paid me [amount]"_ 💰`
        );
      } else {
        // Calculate true gross profit using stored cost prices
        let totalRevenue = 0;
        let totalCogs    = 0;
        const noCostItems = [];

        for (const p of parsedData.products) {
          const qty       = parseFloat(p.quantity)    || 0;
          const sellPrice = parseFloat(p.unit_price)  || 0;
          const lineRev   = qty * sellPrice || parseFloat(p.total_amount) || 0;
          totalRevenue += lineRev;

          if (qty > 0) {
            const found     = await ProductService.findProductFuzzy(user.id, p.product_name).catch(() => null);
            const costPrice = parseFloat(found?.last_purchase_price) || 0;
            if (costPrice > 0) {
              totalCogs += costPrice * qty;
            } else if (sellPrice > 0) {
              noCostItems.push(p.product_name);
            }
          }
        }

        let profitLine = '';
        if (totalRevenue > 0 && totalCogs > 0) {
          const grossProfit = totalRevenue - totalCogs;
          const grossMargin = ((grossProfit / totalRevenue) * 100).toFixed(1);
          profitLine =
            `\nRevenue: ₦${fmt(totalRevenue)}\n` +
            `Cost:    ₦${fmt(totalCogs)}\n` +
            `Profit:  ₦${fmt(grossProfit)} (${grossMargin}% margin)`;
        } else if (totalRevenue > 0 && noCostItems.length > 0) {
          profitLine =
            `\nRevenue: ₦${fmt(totalRevenue)}\n` +
            `⚠️ No buying price saved for ${noCostItems.slice(0, 2).join(', ')}.\n` +
            `Send: "${noCostItems[0]} buying price is [amount]" to track real profit.`;
        }

        await WhatsAppService.sendMessage(from, `✅ Sale recorded!\n\n${lines.join('\n')}${profitLine}`);
      }
    } else {
      const rowOut = await InventoryService.sellStock(user, parsedData);
      await WhatsAppService.sendMessage(from,
        `✅ Sale recorded!\n\n` +
        `📦 ${parsedData.item}: -${parsedData.quantity} units sold\n` +
        `Balance: ${parseFloat(rowOut.current_balance).toLocaleString('en-NG')} units`);
    }
    return;
  }

  if (entry_type === 'opening_stock') {
    const products = parsedData.products || [];
    if (products.length === 0) {
      await WhatsAppService.sendMessage(from,
        `No products found, ${user.name.split(' ')[0]}. Try typing: _"I have 20 oud oil, 15 rose, 5 musk"_`);
      return;
    }
    await ProductService.setOpeningStock(user.id, products);
    await UserModel.markOpeningStockLogged(user.id);
    const lines = products.map(p =>
      `📦 ${p.product_name || 'Unknown'}: ${p.quantity || '?'} ${p.unit || 'units'}`
    ).join('\n');
    await WhatsAppService.sendMessage(from,
      `✅ Stock set, ${user.name.split(' ')[0]}!\n\n${lines}\n\n` +
      `I'll alert you before anything runs low. Send your daily sales whenever you're ready. 🚀`
    );
    return;
  }

  if (entry_type === 'stock_zero') {
    const { product_name, product_id, current_stock } = parsedData;
    const zeroed = await ProductService.zeroProductStock(user.id, product_id, todayWAT());
    const qty    = zeroed || current_stock || 0;
    await WhatsAppService.sendMessage(from,
      `🔴 *${product_name}* marked as out of stock (${qty.toLocaleString('en-NG')} units cleared).\n\n` +
      `When you restock, send:\n_"received [number] ${product_name} at [price] each"_\nand I'll update your inventory. 📦`
    );
    return;
  }

  if (entry_type === 'debt_payment') {
    const { debtor_name, amount } = parsedData;
    const fmt = (n) => Number(n || 0).toLocaleString('en-NG');

    // Find matching outstanding debt
    const debtor = await DebtorModel.findPending(user.id, debtor_name).catch(() => null);

    // Record as revenue regardless of whether a debtor record exists
    await TransactionModel.create({
      userId:         user.id,
      revenue:        amount,
      totalExpenses:  0,
      expenseBreakdown: {},
      profit:         amount,
      margin:         100,
      customers:      0,
      notes:          `Debt payment received from ${debtor_name}`,
      rawMessage:     original_message,
      entryMethod:    'text',
    });
    await UserModel.touchLastEntry(user.id);

    if (debtor) {
      const updated   = await DebtorModel.markPaid(debtor.id, amount);
      const remaining = Math.max(0, parseFloat(updated.amount) - parseFloat(updated.amount_paid));
      if (remaining <= 0) {
        await WhatsAppService.sendMessage(from,
          `✅ *${debtor_name} is fully settled!*\n\n` +
          `₦${fmt(amount)} received. Full debt of ₦${fmt(debtor.amount)} cleared. 🎉\n\n` +
          `Revenue logged: ₦${fmt(amount)}`
        );
      } else {
        await WhatsAppService.sendMessage(from,
          `✅ *Partial payment recorded — ${debtor_name}*\n\n` +
          `Received: ₦${fmt(amount)}\n` +
          `Still outstanding: ₦${fmt(remaining)}\n\n` +
          `Revenue logged: ₦${fmt(amount)} 💰`
        );
      }
    } else {
      await WhatsAppService.sendMessage(from,
        `✅ *₦${fmt(amount)} from ${debtor_name}* logged as today's revenue. 💰\n\n` +
        `(No outstanding debt found for this name — recorded as income.)`
      );
    }
    return;
  }
}

// ─────────────────────────────────────────────
// Internal: oversell YES — add missing stock, then deduct full qty
// ─────────────────────────────────────────────
async function handleOversellYes(user, from, pending) {
  const { original_entry, oversells } = typeof pending.parsed_data === 'string'
    ? JSON.parse(pending.parsed_data) : pending.parsed_data;
  const date = todayWAT();
  const fmt  = (n) => Number(n || 0).toLocaleString('en-NG');

  // Auto-restock: add the missing units for each oversold product
  for (const o of oversells) {
    const restockProducts = [{
      product_name:     o.product_name,
      transaction_type: 'stock_in',
      quantity:         o.difference,
      unit_price:       null,
      total_amount:     0,
      unit:             'units',
      channel:          'retail',
    }];
    await ProductService.processProductTransactions(
      user.id, user, restockProducts, null, date, WhatsAppService
    ).catch(e => console.error('[Oversell YES] Restock failed:', e.message));
  }

  // Now process the original sale at the full requested quantity
  const summary = await ProductService.processProductTransactions(
    user.id, user, original_entry.products, null, date, WhatsAppService
  ).catch(() => []);

  const lines = summary.length > 0
    ? summary.map(s => `📦 ${s.name}: ${s.stock} ${s.unit} remaining`)
    : original_entry.products.map(p => `📦 ${p.product_name}: sold ${p.quantity || '?'} ${p.unit || 'units'}`);

  const restockNote = oversells.map(o =>
    `↳ Auto-added ${fmt(o.difference)} ${o.product_name} to balance your stock`
  ).join('\n');

  await WhatsAppService.sendMessage(from,
    `✅ *Sale recorded!*\n\n${lines.join('\n')}\n\n` +
    `📝 *Auto-corrected restock:*\n${restockNote}`
  );
}

// ─────────────────────────────────────────────
// Internal: oversell NO — sell from unlogged stock, cap at 0
// ─────────────────────────────────────────────
async function handleOversellNo(user, from, pending) {
  const { original_entry, oversells } = typeof pending.parsed_data === 'string'
    ? JSON.parse(pending.parsed_data) : pending.parsed_data;
  const date = todayWAT();

  // Process sale normally — productService already caps at 0 via GREATEST
  const summary = await ProductService.processProductTransactions(
    user.id, user, original_entry.products, null, date, WhatsAppService
  ).catch(() => []);

  const lines = summary.length > 0
    ? summary.map(s => `📦 ${s.name}: ${s.stock} ${s.unit} remaining`)
    : oversells.map(o => `📦 ${o.product_name}: set to 0 (sold from unlogged stock)`);

  await WhatsAppService.sendMessage(from,
    `✅ *Sale recorded!*\n\n${lines.join('\n')}\n\n` +
    `⚠️ Stock went to 0 — you may have unlogged inventory. ` +
    `Send _"received [qty] [product]"_ when you're ready to update it.`
  );
}

// ─────────────────────────────────────────────
// Internal: handle daily_entry messages
// ─────────────────────────────────────────────
async function handleDailyEntry(user, from, data, rawMessage, entryMethod = 'text') {
  const { revenue, totalExpenses, expenseBreakdown, profit, margin, customers, notes, entry_date } = data;

  // Save to PostgreSQL — use entry_date if Gemini detected a past date
  const txRow = await TransactionModel.create({
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
    entryDate: entry_date || null,
  });

  // Update last_entry_date and streak
  const newStreak = await UserModel.touchLastEntry(user.id);

  // Attribute any pending retention nudge to this entry (non-blocking)
  trackOutcome(user.id).catch(() => {});

  // Process product-level transactions extracted by Gemini
  let stockSummary = [];
  if (Array.isArray(data.products) && data.products.length > 0) {
    const prodDate = entry_date || todayWAT();
    stockSummary = await ProductService.processProductTransactions(
      user.id, user, data.products, txRow?.id || null, prodDate, WhatsAppService
    ).catch(e => { console.error('[Products] processProductTransactions error:', e.message); return []; });
  }

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

  // Fetch cumulative totals for the entry's date (today, or the backdated date)
  const date = entry_date || todayWAT();
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

  // Stock update lines (Part 8) — sent as a separate message after the main ACK
  if (stockSummary.length > 0) {
    const lines = stockSummary.map(s =>
      `- ${s.name}: ${s.stock} ${s.unit} remaining  ${s.emoji} ${s.status.replace('_', ' ').toLowerCase()}`
    );
    WhatsAppService.sendMessage(from, `📦 Stock update:\n${lines.join('\n')}`).catch(() => {});
  }

  // Milestone celebrations (non-blocking)
  const firstName = user.name.split(' ')[0];
  const totalMsgs = await UserModel.getTotalMessages(user.id);
  const s = parseInt(newStreak, 10) || 1;

  // Soft gate — nudge once on first entry if opening stock hasn't been logged
  if (!user.opening_stock_logged && totalMsgs === 1) {
    WhatsAppService.sendMessage(from,
      `📦 One more thing — tell me what stock you currently have so I can alert you before anything runs out.\n\n` +
      `Just say: _"I have 20 oud oil, 15 rose, 5 musk"_ or send a photo of your shelf. 📸`
    ).catch(() => {});
  }

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
  const { calcHealthScore, healthLabel, topExpenseCategory } = require('../utils/formatter');
  const EmailService = require('../services/email');

  const date = todayWAT();

  // Get today's totals, expense breakdowns, stock alerts, and full inventory
  const [totals, breakdowns, lowStock, allInventory] = await Promise.all([
    TransactionModel.getDailyTotals(user.id, date),
    TransactionModel.getExpenseBreakdowns(user.id, date),
    InventoryService.getLowStockAlerts(user.id),
    InventoryService.getStock(user.id),
  ]);

  const revenue       = parseFloat(totals.revenue)       || 0;
  const totalExpenses = parseFloat(totals.total_expenses) || 0;
  const profit        = parseFloat(totals.profit)         || 0;
  const customers     = parseInt(totals.customers, 10)    || 0;
  const margin        = calcMargin(profit, revenue);
  const score         = calcHealthScore(margin);
  const hl            = healthLabel(score);
  const topExpense    = topExpenseCategory(breakdowns);

  const summaryData = {
    revenue, totalExpenses, profit, margin,
    healthScore: score, healthKey: hl.key,
    topExpense, customers, date,
    inventory: allInventory,  // full stock counts for the summary
  };

  if (revenue === 0) {
    await WhatsAppService.sendMessage(from,
      `📊 No entries logged today yet, ${user.name.split(' ')[0]}.\n\nSend your sales and expenses first, then request your summary.`);
    return;
  }

  const aiRec = await ClaudeService.generateRecommendation(summaryData, user);

  // Send numbers directly in WhatsApp — user asked, they should see it here
  await WhatsAppService.sendEveningSummaryWhatsApp(from, user.name.split(' ')[0], summaryData, aiRec, lowStock);

  // Also send email with full report (non-blocking)
  EmailService.sendSummaryEmail(user, summaryData, aiRec, lowStock)
    .catch((err) => console.error('[Email] sendSummaryEmail error:', err.message));
}

// ─────────────────────────────────────────────
// Internal: download media (audio or image) from Meta Media API
// ─────────────────────────────────────────────
async function downloadWhatsAppMedia(mediaId) {
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
    `SELECT item_name, current_balance, unit_price, total_received
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

// ─────────────────────────────────────────────
// Internal: WhatsApp-native conversational registration
// ─────────────────────────────────────────────
const BIZ_TYPES = {
  '1': 'Retail',
  '2': 'Fashion',
  '3': 'Food/Restaurant',
  '4': 'Beauty/Hair',
  '5': 'Electronics',
  '6': 'Fragrance/Perfume',
};

async function handleOnboarding(from, text, session) {
  const step      = session.step;
  const collected = typeof session.collected === 'string'
    ? JSON.parse(session.collected)
    : (session.collected || {});

  if (step === 'name') {
    const raw  = text.trim().replace(/[^a-zA-Z\s'.-]/g, '').trim();
    const name = raw.split(' ').slice(0, 3).join(' '); // cap at 3 words

    if (!name || name.length < 2) {
      await WhatsAppService.sendMessage(from,
        `Just your first name — e.g. "Amina" or "Chukwuemeka" 😊`);
      return;
    }

    collected.name = name;
    await OnboardingModel.updateSession(from, 'biz_type', collected);
    await WhatsAppService.sendMessage(from,
      `Hi ${name.split(' ')[0]}! 🙌\n\n` +
      `What type of business do you run?\n\n` +
      `1. Provision/Retail shop\n` +
      `2. Fashion/Clothing\n` +
      `3. Food/Restaurant\n` +
      `4. Beauty/Hair\n` +
      `5. Electronics/Phones\n` +
      `6. Fragrance/Perfume\n` +
      `7. Other\n\n` +
      `Reply with the number or describe your business.`
    );
    return;
  }

  if (step === 'biz_type') {
    const t       = text.trim();
    const bizType = BIZ_TYPES[t] || (t === '7' ? null : t);

    if (!bizType && t === '7') {
      // "Other" chosen — ask them to describe
      await OnboardingModel.updateSession(from, 'biz_type_other', collected);
      await WhatsAppService.sendMessage(from,
        `No problem! Briefly describe your business:\n_(e.g. "I sell provisions", "Online store", "Spare parts")_`
      );
      return;
    }

    collected.biz_type = bizType || t;
    await OnboardingModel.updateSession(from, 'state', collected);
    await WhatsAppService.sendMessage(from,
      `Got it — ${collected.biz_type}! 👌\n\n` +
      `Which state are you in?\n\n` +
      `(e.g. Lagos, Abuja, Kano, Rivers, Ogun...)`
    );
    return;
  }

  if (step === 'biz_type_other') {
    // Free-text business type from "Other" branch
    collected.biz_type = text.trim() || 'Other';
    await OnboardingModel.updateSession(from, 'state', collected);
    await WhatsAppService.sendMessage(from,
      `Got it — ${collected.biz_type}! 👌\n\n` +
      `Which state are you in?\n\n` +
      `(e.g. Lagos, Abuja, Kano, Rivers, Ogun...)`
    );
    return;
  }

  if (step === 'state') {
    const stateVal = text.trim();
    if (!stateVal || stateVal.length < 2) {
      await WhatsAppService.sendMessage(from,
        `Which Nigerian state? e.g. "Lagos" or "Abuja" 📍`);
      return;
    }
    collected.state = stateVal;
    await OnboardingModel.updateSession(from, 'email', collected);
    await WhatsAppService.sendMessage(from,
      `📍 ${stateVal}!\n\n` +
      `Last step — drop your email so I can send your evening profit report.\n\n` +
      `_(Type "skip" if you don't have one)_`
    );
    return;
  }

  if (step === 'email') {
    const input      = text.trim().toLowerCase();
    const isSkip     = input === 'skip' || input === 'no' || input === 'none';
    const emailToUse = isSkip
      ? `wa_${from}@bizpulse.local`
      : input;

    if (!isSkip && !input.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      await WhatsAppService.sendMessage(from,
        `That doesn't look like a valid email — try again.\n\n` +
        `(e.g. yourname@gmail.com)\n\n` +
        `Or reply *skip* to continue without email.`
      );
      return;
    }

    // Block duplicate email registrations
    if (!isSkip) {
      const existing = await UserModel.findByEmail(emailToUse);
      if (existing) {
        await WhatsAppService.sendMessage(from,
          `That email already has a BizPulse account. 📱\n\n` +
          `To link this WhatsApp number, log in at mybizpulse.app → Settings → Update WhatsApp number.\n\n` +
          `Or use a different email to create a new account.`
        );
        return;
      }
    }

    const firstName = (collected.name || '').split(' ')[0];

    try {
      await UserModel.create({
        name:           collected.name,
        email:          emailToUse,
        bizName:        `${firstName}'s Business`,
        bizType:        collected.biz_type,
        state:          collected.state,
        whatsappNumber: from,
      });
    } catch (err) {
      // email uniqueness collision on the local placeholder is extremely unlikely
      // but handle it gracefully
      console.error('[Onboarding] create user error:', err.message);
      await WhatsAppService.sendMessage(from,
        `Something went wrong on our side. Try again in a moment — just send any message.`);
      await OnboardingModel.deleteSession(from);
      return;
    }

    await OnboardingModel.deleteSession(from);

    await WhatsAppService.sendMessage(from,
      `✅ You're in, ${firstName}! Welcome to BizPulse.\n\n` +
      `I'm tracking your *${collected.biz_type}* in *${collected.state}*.\n\n` +
      `Everything runs right here on WhatsApp — no app to download.`
    );

    // Fire the standard onboarding message (asks for opening stock)
    await WhatsAppService.sendOnboarding(from, firstName, collected.biz_type);
  }
}

// ─────────────────────────────────────────────
// Buying calculator: compute selling prices at target margin
// ─────────────────────────────────────────────
function buildCalcReply(products, targetMarginPct) {
  const fmt = n => Number(n || 0).toLocaleString('en-NG');
  const lines = (products || [])
    .filter(p => p.unit_price)
    .map(p => {
      const cost   = parseFloat(p.unit_price);
      const sellAt = Math.ceil(cost / (1 - targetMarginPct / 100));
      const unit   = p.unit && p.unit !== 'units' ? ` (per ${p.unit.replace(/s$/, '')})` : '';
      return `*${p.product_name}*${unit}\n  Cost: ₦${fmt(cost)} → Sell at: *₦${fmt(sellAt)}*`;
    });

  if (lines.length === 0) {
    return (
      `I couldn't read cost prices from that receipt.\n\n` +
      `Try a clearer photo or type the items:\n_"Indomie 3800, Peak Milk 7200"_ + "35% margin"`
    );
  }

  return (
    `📊 *Selling prices at ${targetMarginPct}% margin*\n\n` +
    lines.join('\n\n') +
    `\n\nWant a different margin? Just reply with the number.\n_Example: "40"_`
  );
}

module.exports = router;
