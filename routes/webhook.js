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

    if (msg.type === 'image') {
      // ── Photo / image ──
      entryMethod = 'photo';
      const mediaId = msg.image?.id;
      const caption = (msg.image?.caption || '').trim();
      console.log(`[Webhook] Image from ${from}, media_id: ${mediaId}`);

      const photoUser = await UserModel.findByWhatsapp(from);
      if (!photoUser) {
        await WhatsAppService.sendNotRegistered(from);
        return;
      }

      await WhatsAppService.sendMessage(from,
        `📸 Got your photo, ${photoUser.name.split(' ')[0]}! Analyzing it...`
      ).catch(() => {});

      try {
        const { buffer, mimeType } = await downloadWhatsAppAudio(mediaId);

        // ── Buying calculator mode: caption contains a margin target ──
        const marginCaption = caption.match(/(\d+)\s*%|(\d+)\s*margin|margin\s*(\d+)|sell.*?(\d+)|what.*?(\d+)/i);
        if (marginCaption) {
          const targetMargin = parseInt(
            marginCaption[1] || marginCaption[2] || marginCaption[3] ||
            marginCaption[4] || marginCaption[5]
          );
          const { products: receiptItems } = await GeminiService.analyzePhoto(buffer, mimeType, photoUser, 'stock_in');
          const normalizedCalc = (receiptItems || []).map(p => ({
            product_name: p.product || p.product_name || 'Unknown',
            unit_price:   p.price   || p.unit_price   || null,
            unit:         p.unit    || 'units',
          }));
          const calcReply = buildCalcReply(normalizedCalc, targetMargin);
          await WhatsAppService.sendMessage(from, calcReply);
          await ConfirmationService.savePending(
            photoUser.id, 'calc_context',
            { products: normalizedCalc, lastMargin: targetMargin },
            caption
          );
          return;
        }

        // ── Stock photo mode: opening stock or inventory receipt ──
        const isOpeningStock = !photoUser.opening_stock_logged ||
          /\bopening\b|\bi have\b|\bi get\b|\bmy stock\b/i.test(caption);
        const intent = isOpeningStock ? 'opening_stock' : 'inventory_in';
        const { products: rawProducts } = await GeminiService.analyzePhoto(buffer, mimeType, photoUser, intent);

        // Normalise field names from analyzePhoto format → system format
        const normalized = (rawProducts || []).map(p => ({
          product_name: p.product    || p.product_name || 'Unknown',
          quantity:     p.quantity   || null,
          unit:         p.unit       || 'units',
          unit_price:   p.price      || p.unit_price   || null,
          confidence:   p.confidence || 'medium',
        }));

        // Derive overall confidence from item-level values
        const overallConf = normalized.some(p => p.confidence === 'low') ? 'low'
          : normalized.every(p => p.confidence === 'high') ? 'high' : 'medium';

        // Log media attempt (non-blocking)
        const { query: dbQuery } = require('../models/db');
        dbQuery(
          `INSERT INTO media_log (user_id, media_type, intent, parse_success, product_count)
           VALUES ($1, 'image', $2, $3, $4)`,
          [photoUser.id, intent, normalized.length > 0, normalized.length]
        ).catch(() => {});

        if (normalized.length === 0) {
          await WhatsAppService.sendMessage(from,
            `📸 I couldn't identify any products in that photo, ${photoUser.name.split(' ')[0]}.\n\n` +
            `Try a clearer photo of your stock shelf or handwritten list, ` +
            `or type it out:\n_"I have 50 bags rice, 20 packs indomie"_`);
          return;
        }

        const confNote = overallConf === 'low'
          ? `\n\n⚠️ I'm not 100% certain about some items — check the numbers carefully.`
          : '';

        const entryType   = isOpeningStock ? 'opening_stock' : 'inventory_in';
        const pendingData = { products: normalized, source: 'photo' };
        await ConfirmationService.savePending(photoUser.id, entryType, pendingData, caption || '[photo]');
        const confirmMsg = ConfirmationService.buildConfirmationMessage(entryType, pendingData) + confNote;
        await WhatsAppService.sendMessage(from, confirmMsg);
      } catch (err) {
        console.error('[Webhook] Image processing failed:', err.message);
        await WhatsAppService.sendMessage(from,
          `📸 Sorry, I had trouble reading that photo, ${photoUser.name.split(' ')[0]}.\n\n` +
          `You can type your stock instead:\n_"I have 50 bags rice, 20 packs indomie"_`);
      }
      return;
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
      // Prompt for opening stock immediately after welcome
      await WhatsAppService.sendMessage(from,
        `📦 *First step:* Tell me what stock you have right now.\n\n` +
        `You can:\n` +
        `• Voice note: _"I have 20 oud oil, 15 rose, 5 musk"_\n` +
        `• Photo of your shelf or stock list\n` +
        `• Or just type it out\n\n` +
        `Once I know your stock, I'll alert you before anything runs out. 🎯`
      ).catch(() => {});
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

    // ── Confirmation intercept (YES / EDIT) ──────────────────────────────────
    const upperText = text.trim().toUpperCase();
    if (upperText === 'YES' || upperText === 'Y' || upperText === 'CONFIRM') {
      const pending = await ConfirmationService.getPendingEntry(user.id);
      if (pending) {
        await ConfirmationService.confirmEntry(pending.id);
        await handleConfirmedEntry(user, from, pending);
        await MessageModel.updateLog(msgLogId, { intent: 'confirm_yes', status: 'processed' }).catch(() => {});
        return;
      }
      // No pending entry — fall through to normal parse
    } else if (upperText === 'EDIT' || upperText === 'NO' || upperText === 'N') {
      const pending = await ConfirmationService.getPendingEntry(user.id);
      if (pending) {
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
        // Data freshness warning — alert if products haven't been updated in 48+ hours
        const { query: dbQuery } = require('../models/db');
        const freshnessRes = await dbQuery(
          `SELECT MAX(updated_at) AS last_update FROM products WHERE user_id = $1`,
          [user.id]
        ).catch(() => null);
        const lastUpdate = freshnessRes?.rows?.[0]?.last_update;
        if (lastUpdate) {
          const hoursSince = (Date.now() - new Date(lastUpdate).getTime()) / 3600000;
          if (hoursSince >= 48) {
            const daysSince = Math.floor(hoursSince / 24);
            WhatsAppService.sendMessage(from,
              `⚠️ These numbers are ${daysSince} day${daysSince === 1 ? '' : 's'} old.\n\n` +
              `If you've bought or sold stock since then, send me the update to keep this accurate.`
            ).catch(() => {});
          }
        }
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
        const pendingId = await ConfirmationService.savePending(user.id, 'daily_entry', data, text);
        const confirmMsg = ConfirmationService.buildConfirmationMessage('daily_entry', data);
        await WhatsAppService.sendMessage(from, confirmMsg);
        await MessageModel.updateLog(msgLogId, {
          intent: 'daily_entry',
          parsedData: { revenue: data.revenue, totalExpenses: data.totalExpenses, profit: data.profit },
          status: 'pending_confirm',
        }).catch(() => {});
        break;
      }

      case 'inventory_in': {
        const hasProducts = Array.isArray(data.products) && data.products.length > 0;
        if (!hasProducts && (!data.item || !data.quantity)) {
          await WhatsAppService.sendMessage(from,
            "I couldn't quite get the item details. Try:\n\"received 50 bags rice at 900 each\"");
          await MessageModel.updateLog(msgLogId, { intent: 'inventory_in', status: 'parse_error' }).catch(() => {});
          break;
        }
        await ConfirmationService.savePending(user.id, 'inventory_in', data, text);
        const confirmMsgIn = ConfirmationService.buildConfirmationMessage('inventory_in', data);
        await WhatsAppService.sendMessage(from, confirmMsgIn);
        await MessageModel.updateLog(msgLogId, { intent: 'inventory_in', parsedData: data, status: 'pending_confirm' }).catch(() => {});
        break;
      }

      case 'inventory_out': {
        const hasProductsOut = Array.isArray(data.products) && data.products.length > 0;
        if (!hasProductsOut && (!data.item || !data.quantity)) {
          await WhatsAppService.sendMessage(from,
            "I couldn't quite get the details. Try:\n\"sold 12 bags rice today\"");
          await MessageModel.updateLog(msgLogId, { intent: 'inventory_out', status: 'parse_error' }).catch(() => {});
          break;
        }
        await ConfirmationService.savePending(user.id, 'inventory_out', data, text);
        const confirmMsgOut = ConfirmationService.buildConfirmationMessage('inventory_out', data);
        await WhatsAppService.sendMessage(from, confirmMsgOut);
        await MessageModel.updateLog(msgLogId, { intent: 'inventory_out', parsedData: data, status: 'pending_confirm' }).catch(() => {});
        break;
      }

      case 'stock_zero': {
        const rawProductName = data.product_name;
        if (!rawProductName) {
          await WhatsAppService.sendMessage(from,
            `Which product finished? Just send the name — e.g. *Milo* — and I'll mark it as out of stock. 🔴`);
          await MessageModel.updateLog(msgLogId, { intent: 'stock_zero', status: 'needs_product' }).catch(() => {});
          break;
        }
        const foundProduct = await ProductService.findProductFuzzy(user.id, rawProductName).catch(() => null);
        if (!foundProduct) {
          await WhatsAppService.sendMessage(from,
            `I don't have *${rawProductName}* in your stock records yet.\n\n` +
            `To add it first, send:\n_"I have [number] ${rawProductName}"_\nor\n_"received [number] ${rawProductName} at [price] each"_ 📦`);
          await MessageModel.updateLog(msgLogId, { intent: 'stock_zero', status: 'product_not_found' }).catch(() => {});
          break;
        }
        const currentStock = await ProductModel.getCurrentStock(foundProduct.id);
        if (currentStock === 0) {
          await WhatsAppService.sendMessage(from,
            `🔴 *${foundProduct.product_name}* is already out of stock. Nothing to update.`);
          break;
        }
        const pendingData = {
          product_name:  foundProduct.product_name,
          product_id:    foundProduct.id,
          current_stock: currentStock,
        };
        await ConfirmationService.savePending(user.id, 'stock_zero', pendingData, text);
        const confirmMsgZero = ConfirmationService.buildConfirmationMessage('stock_zero', pendingData);
        await WhatsAppService.sendMessage(from, confirmMsgZero);
        await MessageModel.updateLog(msgLogId, { intent: 'stock_zero', parsedData: pendingData, status: 'pending_confirm' }).catch(() => {});
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

      case 'greeting': {
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
        await MessageModel.updateLog(msgLogId, { intent: 'greeting', status: 'processed' }).catch(() => {});
        break;
      }

      case 'question': {
        // Gemini classified this as a question — route to Claude for full financial coaching
        // (covers follow-ups that don't match the rule-based business_question pattern)
        await handleBusinessQuestion(user, from, text);
        await UserModel.touchLastEntry(user.id).catch(() => {});
        await MessageModel.updateLog(msgLogId, { intent: 'question', status: 'processed' }).catch(() => {});
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

  if (entry_type === 'inventory_out') {
    const hasProducts = Array.isArray(parsedData.products) && parsedData.products.length > 0;
    if (hasProducts) {
      const date = todayWAT();
      const summary = await ProductService.processProductTransactions(user.id, user, parsedData.products, null, date, WhatsAppService).catch(() => []);
      const lines = summary.length > 0
        ? summary.map(s => `📦 ${s.name}: ${s.stock} ${s.unit} remaining  ${s.emoji} ${s.status.replace('_', ' ').toLowerCase()}`)
        : parsedData.products.map(p => `📦 ${p.product_name}: -${p.quantity || '?'} ${p.unit || 'units'} sold`);
      await WhatsAppService.sendMessage(from, `✅ Sale recorded!\n\n${lines.join('\n')}`);
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
}

// ─────────────────────────────────────────────
// Internal: handle daily_entry messages
// ─────────────────────────────────────────────
async function handleDailyEntry(user, from, data, rawMessage, entryMethod = 'text') {
  const { revenue, totalExpenses, expenseBreakdown, profit, margin, customers, notes } = data;

  // Save to PostgreSQL
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
  });

  // Update last_entry_date and streak
  const newStreak = await UserModel.touchLastEntry(user.id);

  // Attribute any pending retention nudge to this entry (non-blocking)
  trackOutcome(user.id).catch(() => {});

  // Process product-level transactions extracted by Gemini
  let stockSummary = [];
  if (Array.isArray(data.products) && data.products.length > 0) {
    const prodDate = todayWAT();
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
