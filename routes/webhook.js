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
const { MessageModel }= require('../models/db');
const { normalizePhone } = require('../utils/phone');

const GeminiService      = require('../services/gemini');
const WhatsAppService    = require('../services/whatsapp');
const ConfirmationService = require('../services/confirmationService');
const OnboardingModel     = require('../models/onboarding');

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

module.exports = router;
