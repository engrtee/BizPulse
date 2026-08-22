/**
 * routes/webhook.js
 * Meta WhatsApp Business Cloud API webhook.
 *
 * GET  /webhook  → Verification handshake (Meta calls this once when you configure the webhook)
 * POST /webhook  → Receives all inbound WhatsApp messages
 *
 * Message routing logic:
 *   1. Dedup by whatsapp_message_id, look up the user
 *   2. Route to Kemi (src/agent/agentLoop.js) for text/voice/image
 *   3. Kemi's tools write to PostgreSQL
 *   4. Reply instantly on WhatsApp
 */

'use strict';

const express         = require('express');
const router          = express.Router();
const axios           = require('axios');
const crypto          = require('crypto');

const UserModel       = require('../models/user');
const { MessageModel, query } = require('../models/db');
const { normalizePhone } = require('../utils/phone');

const GeminiService      = require('../services/gemini');
const WhatsAppService    = require('../services/whatsapp');
const ConfirmationService = require('../services/confirmationService');
const OnboardingModel     = require('../models/onboarding');
const SellerModel         = require('../models/seller'); // Reseller Ordering Agent — separate product, see src/reseller-agent/

// One explicit disambiguation question for a brand-new number, shared by the
// text/audio/image first-contact paths below (bizpulse-v1-build-prompt.md —
// the reseller agent shares this WhatsApp number with BizPulse, so a truly
// new sender is ambiguous between "wants to register as a trader" and "wants
// to order from a seller" until they say which).
const DISAMBIGUATION_PROMPT =
  `👋 Hi! Are you here to:\n\n` +
  `1️⃣ Track your own business with BizPulse\n` +
  `2️⃣ Order something from a seller\n\n` +
  `Reply *1* or *2*.`;

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
  // Verify Meta signature before processing anything
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appSecret) {
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) {
      console.warn('[Webhook] ⚠️  Missing X-Hub-Signature-256 header — rejected');
      return res.sendStatus(403);
    }
    const expected = 'sha256=' + crypto
      .createHmac('sha256', appSecret)
      .update(req.rawBody || '')
      .digest('hex');
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        console.warn('[Webhook] ❌ Signature mismatch — rejected');
        return res.sendStatus(403);
      }
    } catch {
      return res.sendStatus(403);
    }
  }

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

      // ── Batch 1 (A2-3/A2-9): STOP / DISPUTE compliance intercept ──────────
      // Fires only for numbers already tracked as a trader's customer contact
      // (see models/customer.js) — a registered trader's own number won't
      // match this, so it can't hijack a trader's own conversation with Kemi.
      // Runs before dedup/onboarding so a customer reply is never swallowed
      // into the "what's your name?" registration flow.
      const CustomerModel = require('../models/customer');
      const knownCustomer = await CustomerModel.findAnyByPhone(from).catch(() => null);
      if (knownCustomer) {
        const upperText = text.toUpperCase();

        if (upperText === 'STOP') {
          await CustomerModel.markOptedOutByPhone(from);
          await WhatsAppService.sendMessage(from,
            `You've been removed from payment reminders. You won't receive any more messages like this.`
          );
          return;
        }

        if (upperText === 'DISPUTE') {
          const disputedRes = await query(
            `SELECT d.*, u.whatsapp_number AS trader_whatsapp, u.name AS trader_name
             FROM debtors d
             JOIN customers c ON c.id = d.customer_id
             JOIN users u ON u.id = d.user_id
             WHERE c.phone = $1 AND d.status IN ('pending', 'partial')
             ORDER BY d.last_reminder_sent_at DESC NULLS LAST
             LIMIT 1`,
            [from]
          );
          const debt = disputedRes.rows[0];
          if (debt) {
            await query(`UPDATE debtors SET disputed = true, disputed_at = NOW() WHERE id = $1`, [debt.id]);
            await WhatsAppService.sendMessage(from,
              `Thanks for letting us know — we've flagged this for ${debt.trader_name || 'the business'} to review.`
            );
            await WhatsAppService.sendMessage(debt.trader_whatsapp,
              `⚠️ ${debt.debtor_name} disputed the ₦${Number(debt.amount).toLocaleString('en-NG')} debt reminder — please review it.`
            ).catch(() => {});
          } else {
            await WhatsAppService.sendMessage(from,
              `Thanks for letting us know — we couldn't find an active reminder to flag, but we've noted your message.`
            );
          }
          return;
        }
      }
      // ────────────────────────────────────────────────────────────────────
    } else if (msg.type === 'audio') {
      // ── Audio / voice note — transcribe then pass to Kemi ──
      entryMethod = 'voice';
      const mediaId = msg.audio?.id;

      // ── Reseller Agent: voice isn't supported yet on either side of that
      // product — keep a registered seller/linked customer from falling into
      // BizPulse's own voice/onboarding pipeline, which doesn't apply to them.
      const resellerVoiceSeller = await SellerModel.findByWhatsapp(from);
      const resellerVoiceLink   = resellerVoiceSeller ? null : await SellerModel.getLinkedSellerId(from);
      if (resellerVoiceSeller || resellerVoiceLink) {
        await WhatsAppService.sendMessage(from,
          `Voice notes aren't supported yet — could you type that instead? 🙏`
        ).catch(() => {});
        return;
      }
      // ────────────────────────────────────────────────────────────────────

      console.log(`[Webhook] Voice note from ${from}, media_id: ${mediaId}`);

      const voiceUser = await UserModel.findByWhatsapp(from);
      if (!voiceUser) {
        const voiceSession = await OnboardingModel.getSession(from);
        if (voiceSession) {
          await WhatsAppService.sendMessage(from,
            `Almost there! Please reply to my last question as a text message to complete setup. 😊`);
        } else {
          await OnboardingModel.createSession(from, 'disambiguation');
          await WhatsAppService.sendMessage(from, DISAMBIGUATION_PROMPT);
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

      // ── Reseller Agent: route BEFORE BizPulse's own photo pipeline, which
      // would otherwise misread an unrelated photo as a stock notebook shot ──
      const resellerImageSeller = await SellerModel.findByWhatsapp(from);
      if (resellerImageSeller) {
        const dedup = await MessageModel.logInbound(from, null, caption || '[image]', wasMsgId)
          .catch(() => ({ id: null, duplicate: false }));
        if (!dedup.duplicate) {
          await WhatsAppService.sendMessage(from,
            `I can only handle text commands right now — for stock updates, just type them ` +
            `(e.g. "Item 3 restock 20").`
          );
          await MessageModel.updateLog(dedup.id, { intent: 'reseller_seller_image_unsupported', status: 'processed' }).catch(() => {});
        }
        return;
      }

      const resellerImageSellerId = await SellerModel.getLinkedSellerId(from);
      if (resellerImageSellerId) {
        const dedup = await MessageModel.logInbound(from, null, caption || '[image]', wasMsgId)
          .catch(() => ({ id: null, duplicate: false }));
        if (dedup.duplicate) return;

        const { recordPaymentReceiptHandler } = require('../src/reseller-agent/toolHandlers');
        try {
          const result = await recordPaymentReceiptHandler({
            sellerId: resellerImageSellerId, customerPhone: from, mediaId,
          });
          if (result.recorded) {
            await WhatsAppService.sendMessage(from,
              `Got it — thanks for the payment proof! I've let the seller know so she can confirm. 🙏`
            );
            const paidSeller = await SellerModel.findById(resellerImageSellerId);
            if (paidSeller) {
              await WhatsAppService.sendMessage(paidSeller.whatsapp_number,
                `💰 A customer sent payment proof for order #${result.order.id}. Check your dashboard to confirm.`
              ).catch(() => {});
            }
          } else {
            await WhatsAppService.sendMessage(from,
              `I don't see an order of yours waiting on payment right now — want to check your order ` +
              `status or place a new order?`
            );
          }
          await MessageModel.updateLog(dedup.id, { intent: 'reseller_payment_receipt', status: 'processed' }).catch(() => {});
        } catch (err) {
          console.error('[Webhook] Reseller payment-receipt processing failed:', err.message);
          await WhatsAppService.sendMessage(from,
            `Had trouble processing that just now — please try again shortly.`
          ).catch(() => {});
          await MessageModel.updateLog(dedup.id, { intent: 'reseller_payment_receipt', status: 'failed' }).catch(() => {});
        }
        return;
      }
      // ────────────────────────────────────────────────────────────────────

      const photoUser = await UserModel.findByWhatsapp(from);
      if (!photoUser) {
        const photoSession = await OnboardingModel.getSession(from);
        if (photoSession) {
          await WhatsAppService.sendMessage(from,
            `Almost there! Please reply to my last question as a text message to complete setup. 😊`);
        } else {
          await OnboardingModel.createSession(from, 'disambiguation');
          await WhatsAppService.sendMessage(from, DISAMBIGUATION_PROMPT);
        }
        return;
      }

      const promptText = caption ||
        'I sent you a photo of my stock notebook or receipt. Please read every item and quantity you can see and log them for me.';

      // Dedup BEFORE any processing — Meta redelivers on timeout/non-2xx, and runAgent
      // can write sales/stock via Kemi tools, so this must happen before it runs
      // (mirrors the text branch dedup at logResult below).
      const photoLogResult = await MessageModel.logInbound(from, photoUser.id, promptText, wasMsgId)
        .catch(() => ({ id: null, duplicate: false }));
      if (photoLogResult.duplicate) {
        console.log(`[Webhook] ⏭ Duplicate image message_id ${wasMsgId} — skipping`);
        return;
      }
      const photoMsgLogId = photoLogResult.id;

      await WhatsAppService.sendMessage(from,
        `📸 Got your photo, ${photoUser.name.split(' ')[0]}! Reading it now...`
      ).catch(() => {});

      try {
        const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
        const imageBase64   = buffer.toString('base64');
        const imageMimeType = (mimeType || 'image/jpeg').split(';')[0];

        const { runAgent } = require('../src/agent/agentLoop');
        const kemisResponse = await runAgent(from, promptText, { imageBase64, imageMimeType });
        await WhatsAppService.sendMessage(from, kemisResponse);

        await MessageModel.updateLog(photoMsgLogId, { intent: 'kemi_image', status: 'processed' }).catch(() => {});
      } catch (err) {
        console.error('[Webhook] Image processing failed:', err.message);
        await WhatsAppService.sendMessage(from,
          `📸 Had trouble reading that photo, ${photoUser.name.split(' ')[0]}.\n\n` +
          `You can type your stock instead:\n_"I have 20 bags rice, 10 cartons indomie"_`);
        await MessageModel.updateLog(photoMsgLogId, { intent: 'kemi_image', status: 'failed' }).catch(() => {});
      }
      return;
    }

    // ── Reseller Agent: registered seller or already-linked customer? ──────
    // Runs before BizPulse's own trader lookup so the two products never
    // fight over the same inbound message. Handles its own dedup (Fix 5)
    // since both roles below can write (stock/order changes).
    if (await tryResellerRouting(from, text, wasMsgId)) return;
    // ────────────────────────────────────────────────────────────────────

    // ── Look up user ──
    const user = await UserModel.findByWhatsapp(from);
    if (!user) {
      // Route to WhatsApp-native conversational registration
      const session = await OnboardingModel.getSession(from);
      if (session) {
        await handleOnboarding(from, text, session);
      } else {
        await OnboardingModel.createSession(from, 'disambiguation');
        await WhatsAppService.sendMessage(from, DISAMBIGUATION_PROMPT);
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

    // ── "Others" biz_type clarification ──────────────────────────────────────
    // If this user's biz_type is still "Other" or "Others", ask them to specify
    // before routing to Kemi. Uses pending_entries to track the waiting state.
    if (/^others?$/i.test((user.biz_type || '').trim())) {
      const pending = await ConfirmationService.getPendingEntry(user.id);

      if (pending && pending.entry_type === 'biz_type_clarification') {
        // User is responding to the clarification question
        const rawResponse = text.trim();
        const isMetaReply = /^(yes|y|no|n|cancel|help|\?)$/i.test(rawResponse);
        if (rawResponse.length < 3 || isMetaReply) {
          await WhatsAppService.sendMessage(from,
            `Please describe your business briefly.\n\n` +
            `Just reply with what you sell — e.g.:\n` +
            `"I sell perfume oils"\n` +
            `"I sell phone accessories"\n` +
            `"I sell provisions"`
          );
          await MessageModel.updateLog(msgLogId, { intent: 'biz_type_prompt', status: 'processed' }).catch(() => {});
          return;
        }
        // Clean up common prefixes
        const cleaned = rawResponse
          .replace(/^(i sell |i run |i do |we sell |we run )/i, '')
          .trim();
        const newBizType = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        await UserModel.updateBizType(user.id, newBizType);
        await ConfirmationService.confirmEntry(pending.id);
        await WhatsAppService.sendMessage(from,
          `✅ Got it — *${newBizType}*!\n\n` +
          `Now I can give you proper insights and examples for your business. 📊\n\n` +
          `Ready to track today? Send your numbers:\n` +
          `_"Made 50k today, spent 15k on stock"_`
        );
        await MessageModel.updateLog(msgLogId, { intent: 'biz_type_update', status: 'processed' }).catch(() => {});
        return;
      }

      if (!pending) {
        // First time encountering this user with "Other" biz_type — ask for clarification
        await ConfirmationService.savePending(user.id, 'biz_type_clarification', {}, text);
        await WhatsAppService.sendMessage(from,
          `I need to know more about your business to help you properly.\n\n` +
          `What exactly do you sell?\n\n` +
          `Just tell me — for example:\n` +
          `"I sell perfume oils"\n` +
          `"I sell phone accessories"\n` +
          `"I sell provisions"\n\n` +
          `One reply and I can start tracking your stock properly. 📦`
        );
        await MessageModel.updateLog(msgLogId, { intent: 'biz_type_prompt', status: 'processed' }).catch(() => {});
        return;
      }
      // If pending exists but is a different type → fall through to Kemi
    }
    // ─────────────────────────────────────────────────────────────────────────

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
// Internal: Reseller Ordering Agent routing (separate product, see src/reseller-agent/)
// ─────────────────────────────────────────────
/**
 * Routes an inbound text/voice-transcribed message to the reseller ordering
 * agent when the sender is either a registered seller or a customer already
 * linked to one. Returns true if it fully handled the message (caller should
 * return immediately) — false if neither applies, so the caller should fall
 * through to BizPulse's own trader lookup.
 *
 * Read-only identity checks happen first with no side effects; dedup (Fix 5)
 * only runs once we know we're actually going to handle — and write to —
 * this message, so an unrelated BizPulse trader's first message is never
 * poisoned by a whatsapp_message_id row this function didn't need to create.
 */
async function tryResellerRouting(from, text, wasMsgId) {
  const seller = await SellerModel.findByWhatsapp(from);
  const linkedSellerId = seller ? null : await SellerModel.getLinkedSellerId(from);
  if (!seller && !linkedSellerId) return false;

  const dedup = await MessageModel.logInbound(from, null, text, wasMsgId)
    .catch(() => ({ id: null, duplicate: false }));
  if (dedup.duplicate) {
    console.log(`[Webhook] ⏭ Duplicate reseller message_id ${wasMsgId} — skipping`);
    return true;
  }

  if (seller) {
    const { runSellerAgent } = require('../src/reseller-agent/sellerAgentLoop');
    const reply = await runSellerAgent(seller, text, { whatsappMessageId: wasMsgId });
    await WhatsAppService.sendMessage(from, reply);
    await MessageModel.updateLog(dedup.id, { intent: 'reseller_seller_agent', status: 'processed' }).catch(() => {});
    return true;
  }

  await SellerModel.touchCustomerSeen(from);
  const { runCustomerAgent } = require('../src/reseller-agent/agentLoop');
  const reply = await runCustomerAgent(from, linkedSellerId, text, { whatsappMessageId: wasMsgId });
  await WhatsAppService.sendMessage(from, reply);
  await MessageModel.updateLog(dedup.id, { intent: 'reseller_customer_agent', status: 'processed' }).catch(() => {});
  return true;
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

  // ── Reseller Agent: disambiguation gate + seller-identification steps ────
  // A brand-new number is ambiguous between "wants to register on BizPulse"
  // and "wants to order from a seller" (this product shares BizPulse's
  // WhatsApp number) — see DISAMBIGUATION_PROMPT above and tryResellerRouting.
  if (step === 'disambiguation') {
    const choice = text.trim();
    if (choice === '1' || /\b(business|track|bizpulse)\b/i.test(choice)) {
      await OnboardingModel.updateSession(from, 'name', {});
      await WhatsAppService.sendMessage(from,
        `👋 Welcome to *BizPulse* — your WhatsApp business tracker.\n\n` +
        `I help Nigerian business owners track sales, expenses, and stock — ` +
        `all from WhatsApp. No app needed.\n\n` +
        `*What's your name?* (Just your first name is fine 😊)`
      );
      return;
    }
    if (choice === '2' || /\b(order|seller|buy|shop)\b/i.test(choice)) {
      await OnboardingModel.updateSession(from, 'reseller_seller_id', {});
      await WhatsAppService.sendMessage(from, `Which seller are you shopping from today? 🙂`);
      return;
    }
    await WhatsAppService.sendMessage(from,
      `Sorry, just reply *1* to track your business, or *2* to order from a seller.`
    );
    return;
  }

  if (step === 'reseller_seller_id') {
    const { identifySeller } = require('../src/reseller-agent/sellerMatcher');
    const { match, candidates } = await identifySeller(text);

    if (match) {
      await SellerModel.linkCustomer(from, match.id);
      await OnboardingModel.deleteSession(from);
      await WhatsAppService.sendMessage(from,
        `Got it — you're shopping from *${match.business_name}*! What would you like to order? 🛍️\n\n` +
        `_Tip: next time, just mention their name or code (${match.code}) and you'll skip this step!_`
      );
      return;
    }
    if (candidates.length > 0) {
      const names = candidates.map(c => c.business_name).join(' or ');
      await WhatsAppService.sendMessage(from, `Did you mean *${names}*? Reply with the one you meant.`);
      return;
    }
    await WhatsAppService.sendMessage(from,
      `Hmm, I couldn't find that seller. Could you tell me their name or code again?\n\n` +
      `_Tip: next time, just include their code or tap their link to skip this step!_`
    );
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

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

module.exports = router;
