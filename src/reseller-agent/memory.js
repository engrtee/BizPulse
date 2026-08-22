'use strict';

/**
 * src/reseller-agent/memory.js
 * Conversation history + agent-decision audit log for the reseller ordering
 * agent. Deliberately simpler than Kemi's src/agent/memory.js — no rolling-
 * summary/Haiku-compression layer in V1 (just the last HISTORY_LIMIT turns,
 * loaded plain). Documented simplification, not an oversight: order-taking
 * conversations are short-lived compared to a trader's ongoing bookkeeping
 * relationship with Kemi.
 */

const { query } = require('../../models/db');

const HISTORY_LIMIT = 15;

async function getConversationHistory(customerPhone) {
  const res = await query(
    `SELECT role, content FROM reseller_conversation_history
     WHERE customer_phone = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [customerPhone, HISTORY_LIMIT]
  );
  return res.rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

async function appendMessage(customerPhone, role, content) {
  const trimmed = (content == null ? '' : String(content)).slice(0, 8000);
  await query(
    `INSERT INTO reseller_conversation_history (customer_phone, role, content)
     VALUES ($1, $2, $3)`,
    [customerPhone, role, trimmed]
  );
}

/** Audit trail per Section 4 — what the agent parsed/decided each turn, for
 * debugging parse accuracy and the before/after time-saved metrics (Section 6). */
async function logAgentDecision({ sellerId, customerPhone, whatsappMessageId, rawMessage, toolCalls, responseText }) {
  try {
    await query(
      `INSERT INTO reseller_agent_log
         (seller_id, customer_phone, whatsapp_message_id, raw_message, parsed_tool_calls, agent_response_text)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sellerId || null, customerPhone || null, whatsappMessageId || null, rawMessage || null,
       JSON.stringify(toolCalls || []), responseText || null]
    );
  } catch (e) {
    console.error('[ResellerAgent] logAgentDecision failed:', e.message);
  }
}

module.exports = { getConversationHistory, appendMessage, logAgentDecision };
