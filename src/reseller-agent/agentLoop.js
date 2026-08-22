'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const { TOOLS } = require('./tools');
const { buildCustomerSystemPrompt } = require('./systemPrompt');
const { getConversationHistory, appendMessage, logAgentDecision } = require('./memory');
const {
  browseCatalogHandler,
  placeOrderHandler,
  checkOrderStatusHandler,
  switchSellerHandler,
} = require('./toolHandlers');
const SellerModel = require('../../models/seller');
const ResellerCatalogModel = require('../../models/resellerCatalog');

const MODEL       = 'claude-sonnet-4-6';
const MAX_TOKENS   = 1024;
const MAX_ITER      = 6;
const RETRY_DELAY   = 2000; // ms

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// place_order and switch_seller write; browse_catalog/check_order_status only read.
const WRITE_TOOLS = new Set(['place_order', 'switch_seller']);

async function dispatch(toolName, input, ctx) {
  const handlers = {
    browse_catalog:     () => browseCatalogHandler({ sellerId: ctx.sellerId }),
    place_order:        () => placeOrderHandler({ ...input, sellerId: ctx.sellerId, customerPhone: ctx.customerPhone }),
    check_order_status: () => checkOrderStatusHandler({ sellerId: ctx.sellerId, customerPhone: ctx.customerPhone }),
    switch_seller:      () => switchSellerHandler({ ...input, customerPhone: ctx.customerPhone }),
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
    console.warn('[ResellerAgent] Claude call failed, retrying in 2s...', err.message);
    await new Promise(r => setTimeout(r, RETRY_DELAY));
    return client.messages.create(params);
  }
}

/**
 * Main entry point for the CUSTOMER-facing side of the reseller ordering agent.
 * Called from routes/webhook.js once a customer phone is linked to a seller
 * (reseller_customer_seller_link). Seller identification itself happens before
 * this is ever invoked.
 *
 * @param {string} customerPhone   Sender in 234XXXXXXXXXX format
 * @param {number} sellerId        The linked seller's id
 * @param {string} incomingMessage Raw message text
 * @param {object} opts            { whatsappMessageId } — for the audit log
 * @returns {Promise<string>}      The agent's reply to send back via WhatsApp
 */
async function runCustomerAgent(customerPhone, sellerId, incomingMessage, opts = {}) {
  try {
    const client = getClient();

    const seller = await SellerModel.findById(sellerId);
    if (!seller) {
      return "Sorry, I've lost track of which seller you're shopping from — please tell me their name or code again.";
    }

    const catalogItems = await ResellerCatalogModel.getActiveBySeller(sellerId);
    const history = await getConversationHistory(customerPhone);

    await appendMessage(customerPhone, 'user', incomingMessage);

    const messages = [...history, { role: 'user', content: incomingMessage }];
    const system = buildCustomerSystemPrompt(seller, catalogItems);
    const ctx = { sellerId, customerPhone };

    let iterations = 0;
    const toolCallLog = [];

    while (iterations < MAX_ITER) {
      iterations++;

      const response = await callClaude(client, {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: TOOLS,
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
          const result = await dispatch(tb.name, tb.input, ctx);
          toolCallLog.push({ name: tb.name, input: tb.input, result });
          toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) });
        } catch (err) {
          console.error(`[ResellerAgent] Tool ${tb.name} failed:`, err.message);
          toolResults.push({
            type: 'tool_result', tool_use_id: tb.id,
            content: JSON.stringify({ error: true, message: err.message }), is_error: true,
          });
        }
      }

      const readResults = await Promise.all(readBlocks.map(async tb => {
        try {
          const result = await dispatch(tb.name, tb.input, ctx);
          toolCallLog.push({ name: tb.name, input: tb.input, result });
          return { type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) };
        } catch (err) {
          console.error(`[ResellerAgent] Tool ${tb.name} failed:`, err.message);
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
      console.warn(`[ResellerAgent] MAX_ITER (${MAX_ITER}) hit for ${customerPhone}`);
      responseText = "Sorry, give me a moment and try that again. 🙏";
    } else {
      const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
      responseText = (Array.isArray(lastAssistant?.content)
        ? lastAssistant.content.filter(b => b.type === 'text').map(b => b.text).join('')
        : String(lastAssistant?.content || '')
      ).trim() || "Sorry, something went wrong on my end — please try again.";
    }

    await appendMessage(customerPhone, 'assistant', responseText);
    await logAgentDecision({
      sellerId, customerPhone,
      whatsappMessageId: opts.whatsappMessageId,
      rawMessage: incomingMessage,
      toolCalls: toolCallLog,
      responseText,
    });

    return responseText;
  } catch (err) {
    console.error(`[ResellerAgent] runCustomerAgent failed for ${customerPhone}:`, err.message, err.stack);
    return "Sorry, something went wrong on my end — please try again in a moment.";
  }
}

module.exports = { runCustomerAgent, dispatch };
