'use strict';

require('dotenv').config();
const cron     = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');

const { query }              = require('../../models/db');
const { getDailySummaryPack } = require('./stockIntelligence');
const { appendMessage, getRollingContext, clearOldHistory } = require('./memory');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 300;

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function getWhatsAppService() {
  return require('../../services/whatsapp');
}

/**
 * STAGE 1 — Data assembly (pure SQL, no AI).
 * Returns a structured JSON pack for one trader.
 */
async function assembleDataPack(whatsappNumber) {
  return getDailySummaryPack(whatsappNumber);
}

/**
 * STAGE 2 — Narration (Claude, no tools).
 * Takes the data pack and returns a 4-7 line WhatsApp-ready message.
 */
async function narrateDigest(dataPack, languagePreference) {
  const client = getClient();
  if (!client) {
    // Fallback narration if Claude is unavailable
    const rev = Number(dataPack.today?.total_revenue || 0).toLocaleString('en-NG');
    return `📊 Today: ₦${rev} in sales. Full detail is logged. 💪`;
  }

  const langInstruction = languagePreference && languagePreference !== 'auto'
    ? `Language preference: ${languagePreference}. Mirror this exactly.`
    : 'Match whatever language/pidgin this trader uses. When unsure, use warm Nigerian English.';

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: `You are Kemi, BizPulse assistant. A trader's daily data pack is below. Write their evening WhatsApp summary.

Rules:
- 4-7 lines maximum
- Lead with the headline number — make it feel significant ("₦47,200 today — your best Tuesday this month")
- Include one stock insight only if urgent_restock or stockouts_today is non-empty
- Include goal progress if goal_progress has an entry with a target
- End with one warm closing line or question
- ${langInstruction}
- No markdown. No bullets. Short sentences.
- 1-2 emoji maximum.`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role:    'user',
        content: JSON.stringify(dataPack),
      },
    ],
  });

  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

/**
 * Run the two-stage digest for a single trader and send via WhatsApp.
 */
async function runDigestForTrader(whatsappNumber) {
  try {
    // Stage 1 — SQL data pack
    const dataPack = await assembleDataPack(whatsappNumber);

    // Skip if trader had zero activity today
    if (!dataPack.today?.total_revenue && !dataPack.today?.transaction_count) {
      console.log(`[Digest] ⏭ No activity today for ${whatsappNumber} — skipping`);
      return;
    }

    // Stage 2 — Claude narration
    const context  = await getRollingContext(whatsappNumber);
    const message  = await narrateDigest(dataPack, context.language_preference);

    // Send via WhatsApp
    const WA = getWhatsAppService();
    await WA.sendMessage(whatsappNumber, message);

    // Log the digest as an assistant message so Kemi remembers it
    await appendMessage(whatsappNumber, 'assistant', message);

    console.log(`[Digest] ✅ Sent to ${whatsappNumber}`);
  } catch (err) {
    console.error(`[Digest] ❌ Failed for ${whatsappNumber}:`, err.message);
  }
}

/**
 * Run the digest for every active trader (messaged in last 7 days).
 */
async function runDailyDigest() {
  console.log('[Digest] 🌙 Starting evening digest run...');

  const res = await query(
    `SELECT whatsapp_number FROM users
     WHERE whatsapp_number IS NOT NULL
       AND (
         last_entry_date   >= CURRENT_DATE - 7
         OR last_message_date >= CURRENT_DATE - 7
       )`,
  );

  console.log(`[Digest] Processing ${res.rows.length} active traders`);

  for (const row of res.rows) {
    await runDigestForTrader(row.whatsapp_number);
  }

  console.log('[Digest] ✅ Evening digest run complete.');
}

// ── Cron schedules ────────────────────────────────────────────────────────────

// 8:00 PM WAT — evening digest for all active traders
cron.schedule('0 20 * * *', async () => {
  console.log('[Digest] 🕗 8pm WAT digest firing:', new Date().toISOString());
  try {
    await runDailyDigest();
  } catch (err) {
    console.error('[Digest] Fatal error in digest run:', err.message);
  }
}, { timezone: 'Africa/Lagos' });

// 3:00 AM WAT — purge conversation_history older than 7 days
cron.schedule('0 3 * * *', async () => {
  try {
    const deleted = await clearOldHistory();
    if (deleted > 0) console.log(`[Digest] 🗑 Cleared ${deleted} old history rows`);
  } catch (err) {
    console.error('[Digest] History cleanup failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });

// 15-minute refresh of stock_intelligence_mv
cron.schedule('*/15 * * * *', async () => {
  try {
    await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY stock_intelligence_mv`);
  } catch (err) {
    // Silently ignore — MV may not exist on first boot before migration runs
    if (!err.message.includes('does not exist')) {
      console.error('[Digest] MV refresh failed:', err.message);
    }
  }
});

console.log('[Digest] Cron jobs scheduled: 8pm digest, 3am history cleanup, 15min MV refresh.');

/**
 * Test-friendly digest: Stage 1 + Stage 2 without sending via WhatsApp.
 * Returns null if the trader had zero activity today.
 */
async function generateDigest(whatsappNumber) {
  const dataPack = await assembleDataPack(whatsappNumber);
  if (!dataPack.today?.total_revenue && !dataPack.today?.transaction_count) {
    return null;
  }
  const context = await getRollingContext(whatsappNumber);
  return narrateDigest(dataPack, context.language_preference);
}

module.exports = { runDailyDigest, runDigestForTrader, assembleDataPack, narrateDigest, generateDigest };
