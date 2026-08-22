'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const { SELLER_TOOLS } = require('./sellerTools');
const { buildSellerSystemPrompt } = require('./sellerSystemPrompt');
const { getConversationHistory, appendMessage, logAgentDecision } = require('./memory');
const {
  updateStockHandler,
  restockHandler,
  markSoldOutHandler,
  addCatalogItemHandler,
  getPendingOrdersHandler,
} = require('./sellerToolHandlers');
const ResellerCatalogModel = require('../../models/resellerCatalog');

const MODEL       = 'claude-sonnet-4-6';
const MAX_TOKENS  = 1024;
const MAX_ITER    = 6;
const RETRY_DELAY = 2000; // ms

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const WRITE_TOOLS = new Set(['update_stock', 'restock', 'mark_sold_out', 'add_catalog_item']);

async function dispatch(toolName, input, sellerId) {
  const handlers = {
    update_stock:       () => updateStockHandler({ ...input, sellerId }),
    restock:             () => restockHandler({ ...input, sellerId }),
    mark_sold_out:       () => markSoldOutHandler({ ...input, sellerId }),
    add_catalog_item:    () => addCatalogItemHandler({ ...input, sellerId }),
    get_pending_orders:  () => getPendingOrdersHandler({ sellerId }),
  };
  if (!handlers[toolName]) throw new Error(`Unknown tool: ${toolName}`);
  return handlers[toolName]();
}

async function callClaude(client, params) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    const isRetryable = err.status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    if (!isRetryable) throw err;
    console.warn('[ResellerAgent] Seller-loop Claude call failed, retrying in 2s...', err.message);
    await new Promise(r => setTimeout(r, RETRY_DELAY));
    return client.messages.create(params);
  }
}

/**
 * Main entry point for the SELLER-facing side of the reseller ordering agent
 * (her own WhatsApp inventory-command channel, per Section 2).
 *
 * Reuses the same reseller_conversation_history/reseller_agent_log tables as
 * the customer-facing loop (src/reseller-agent/memory.js), keyed here by the
 * seller's own WhatsApp number instead of a customer's — a deliberate reuse,
 * not a new table, since the schema (phone → role/content) fits either side.
 *
 * @param {object} seller          Row from reseller_sellers
 * @param {string} incomingMessage Raw message text
 * @param {object} opts            { whatsappMessageId }
 */
async function runSellerAgent(seller, incomingMessage, opts = {}) {
  try {
    const client = getClient();
    const sellerPhone = seller.whatsapp_number;

    const catalogItems = await ResellerCatalogModel.getActiveBySeller(seller.id);
    const history = await getConversationHistory(sellerPhone);

    await appendMessage(sellerPhone, 'user', incomingMessage);

    const messages = [...history, { role: 'user', content: incomingMessage }];
    const system = buildSellerSystemPrompt(seller, catalogItems);

    let iterations = 0;
    const toolCallLog = [];

    while (iterations < MAX_ITER) {
      iterations++;

      const response = await callClaude(client, {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: SELLER_TOOLS,
        messages,
        tool_choice: { type: 'auto' },
      });

      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'tool_use') break;

      const toolBlocks = response.content.filter(b => b.type === 'tool_use');
      if (toolBlocks.length === 0) break;

      const writeBlocks = toolBlocks.filter(b => WRITE_TOOLS.has(b.name));
      const readBlocks  = toolBlocks.filter(b => !WRITE_TOOLS.has(b.name));
      const toolResults = [];

      for (const tb of writeBlocks) {
        try {
          const result = await dispatch(tb.name, tb.input, seller.id);
          toolCallLog.push({ name: tb.name, input: tb.input, result });
          toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) });
        } catch (err) {
          console.error(`[ResellerAgent] Seller tool ${tb.name} failed:`, err.message);
          toolResults.push({
            type: 'tool_result', tool_use_id: tb.id,
            content: JSON.stringify({ error: true, message: err.message }), is_error: true,
          });
        }
      }

      const readResults = await Promise.all(readBlocks.map(async tb => {
        try {
          const result = await dispatch(tb.name, tb.input, seller.id);
          toolCallLog.push({ name: tb.name, input: tb.input, result });
          return { type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) };
        } catch (err) {
          console.error(`[ResellerAgent] Seller tool ${tb.name} failed:`, err.message);
          return {
            type: 'tool_result', tool_use_id: tb.id,
            content: JSON.stringify({ error: true, message: err.message }), is_error: true,
          };
        }
      }));

      toolResults.push(...readResults);
      messages.push({ role: 'user', content: toolResults });
    }

    let responseText;
    if (iterations >= MAX_ITER) {
      console.warn(`[ResellerAgent] Seller-loop MAX_ITER (${MAX_ITER}) hit for ${sellerPhone}`);
      responseText = 'Give me a moment and try that again. 🙏';
    } else {
      const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
      responseText = (Array.isArray(lastAssistant?.content)
        ? lastAssistant.content.filter(b => b.type === 'text').map(b => b.text).join('')
        : String(lastAssistant?.content || '')
      ).trim() || 'Something went wrong on my end — please try again.';
    }

    await appendMessage(sellerPhone, 'assistant', responseText);
    await logAgentDecision({
      sellerId: seller.id,
      customerPhone: null,
      whatsappMessageId: opts.whatsappMessageId,
      rawMessage: incomingMessage,
      toolCalls: toolCallLog,
      responseText,
    });

    return responseText;
  } catch (err) {
    console.error(`[ResellerAgent] runSellerAgent failed for seller ${seller?.id}:`, err.message, err.stack);
    return 'Something went wrong on my end — please try again in a moment.';
  }
}

module.exports = { runSellerAgent };
