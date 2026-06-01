'use strict';

const { query } = require('../../models/db');
const Anthropic  = require('@anthropic-ai/sdk');

const MODEL       = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/**
 * Return the last 20 conversation turns as a Claude messages array.
 * Ordered oldest-first so Claude sees the conversation in chronological order.
 */
async function getConversationHistory(whatsappNumber) {
  const res = await query(
    `SELECT role, content
     FROM conversation_history
     WHERE whatsapp_number = $1
     ORDER BY created_at ASC
     LIMIT 15`,
    [whatsappNumber]
  );
  return res.rows.map(r => ({ role: r.role, content: r.content }));
}

/**
 * Insert one message row into conversation_history.
 */
async function appendMessage(whatsappNumber, role, content) {
  await query(
    `INSERT INTO conversation_history (whatsapp_number, role, content)
     VALUES ($1, $2, $3)`,
    [whatsappNumber, role, String(content).slice(0, 8000)]
  );
}

/**
 * Return trader_facts for this number. If no row exists, return safe defaults.
 */
async function getRollingContext(whatsappNumber) {
  const res = await query(
    `SELECT language_preference, business_type, top_products,
            typical_lead_time_days, rolling_summary
     FROM trader_facts
     WHERE whatsapp_number = $1`,
    [whatsappNumber]
  );
  if (res.rows.length === 0) {
    return {
      language_preference:    'auto',
      business_type:          null,
      top_products:           [],
      typical_lead_time_days: 2,
      rolling_summary:        null,
    };
  }
  const r = res.rows[0];
  return {
    language_preference:    r.language_preference    || 'auto',
    business_type:          r.business_type          || null,
    top_products:           Array.isArray(r.top_products) ? r.top_products : [],
    typical_lead_time_days: r.typical_lead_time_days || 2,
    rolling_summary:        r.rolling_summary        || null,
  };
}

/**
 * Upsert any subset of trader_facts fields for this number.
 * @param {object} updates  Plain object of column → value pairs to save
 */
async function updateRollingContext(whatsappNumber, updates) {
  const allowed = [
    'language_preference', 'business_type', 'top_products',
    'typical_lead_time_days', 'rolling_summary', 'summary_updated_at',
  ];
  const fields  = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return;

  const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values     = fields.map(f => updates[f]);

  await query(
    `INSERT INTO trader_facts (whatsapp_number, ${fields.join(', ')}, updated_at)
     VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')}, NOW())
     ON CONFLICT (whatsapp_number) DO UPDATE
       SET ${setClauses}, updated_at = NOW()`,
    [whatsappNumber, ...values]
  );
}

/**
 * Return the total number of stored conversation rows for this trader.
 */
async function getHistoryCount(whatsappNumber) {
  const res = await query(
    `SELECT COUNT(*) AS cnt FROM conversation_history
     WHERE whatsapp_number = $1`,
    [whatsappNumber]
  );
  return parseInt(res.rows[0]?.cnt, 10) || 0;
}

/**
 * Compress the last 40 messages into a 5-bullet rolling summary via Claude.
 * Stores the result in trader_facts.rolling_summary.
 * Prunes conversation_history to the most recent 20 rows.
 * Fire-and-forget — caller must not await unless testing.
 */
async function generateRollingSummary(whatsappNumber, messages) {
  const client = getClient();
  if (!client) return;

  try {
    // Strip tool_use / tool_result blocks — keep only text turns
    const simplified = messages.slice(-40)
      .map(m => {
        const text = Array.isArray(m.content)
          ? m.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim()
          : String(m.content || '').trim();
        return text ? { role: m.role, content: text } : null;
      })
      .filter(Boolean);

    // Merge consecutive same-role turns (can arise after stripping tool blocks)
    const deduped = [];
    for (const msg of simplified) {
      const last = deduped[deduped.length - 1];
      if (last && last.role === msg.role) {
        last.content += '\n' + msg.content;
      } else {
        deduped.push({ ...msg });
      }
    }

    if (deduped.length === 0) return;

    // Claude requires conversation to start with 'user' and end with 'user'
    if (deduped[0].role !== 'user') deduped.unshift({ role: 'user', content: '[conversation start]' });
    if (deduped[deduped.length - 1].role !== 'user') {
      deduped.push({ role: 'user', content: 'Summarise the conversation above.' });
    }

    const response = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 300,
      system: [
        {
          type: 'text',
          text: 'You are summarising a WhatsApp business conversation. Return exactly 5 bullet points covering: (1) the trader\'s language preference, (2) any open questions, (3) what they sell, (4) patterns you noticed, (5) any unresolved issues. Plain text, no markdown.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: deduped,
    });

    const summary = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    await updateRollingContext(whatsappNumber, {
      rolling_summary:    summary,
      summary_updated_at: new Date().toISOString(),
    });

    // Keep only the 20 most recent rows for this trader
    await query(
      `DELETE FROM conversation_history
       WHERE whatsapp_number = $1
         AND id NOT IN (
           SELECT id FROM conversation_history
           WHERE whatsapp_number = $1
           ORDER BY created_at DESC
           LIMIT 20
         )`,
      [whatsappNumber]
    );
  } catch (err) {
    console.error('[Memory] generateRollingSummary failed:', err.message);
  }
}

/**
 * Delete conversation_history rows older than 7 days for all traders.
 * Scheduled daily by digest.js cron.
 */
async function clearOldHistory() {
  const res = await query(
    `DELETE FROM conversation_history
     WHERE created_at < NOW() - INTERVAL '7 days'`
  );
  return res.rowCount || 0;
}

module.exports = {
  getConversationHistory,
  appendMessage,
  getRollingContext,
  updateRollingContext,
  getHistoryCount,
  generateRollingSummary,
  clearOldHistory,
};
