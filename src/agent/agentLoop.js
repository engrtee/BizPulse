'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const { TOOLS }                = require('./tools');
const { buildSystemPrompt }    = require('./systemPrompt');
const {
  getConversationHistory,
  appendMessage,
  getRollingContext,
  getHistoryCount,
  generateRollingSummary,
} = require('./memory');
const {
  logSaleHandler,
  logRestockHandler,
  logExpenseHandler,
  getStockLevelHandler,
  getStockIntelligenceHandler,
  getSalesSummaryHandler,
  searchProductsHandler,
  correctLastEntryHandler,
  logDebtHandler,
  settleDebtHandler,
  getDebtsHandler,
  setGoalHandler,
  comparePeriodsHandler,
} = require('./toolHandlers');

const MODEL         = 'claude-sonnet-4-6';
const MAX_TOKENS    = 1024;
const MAX_ITER      = 8;
const RETRY_DELAY   = 2000; // ms

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// Tools that write to the DB — run sequentially to avoid race conditions
const WRITE_TOOLS = new Set([
  'log_sale', 'log_restock', 'log_expense', 'correct_last_entry',
  'log_debt', 'settle_debt', 'set_goal',
]);

/**
 * Route a tool call to the correct handler.
 */
async function dispatch(toolName, input, whatsappNumber) {
  const handlers = {
    log_sale:              () => logSaleHandler(          { ...input, whatsappNumber }),
    log_restock:           () => logRestockHandler(       { ...input, whatsappNumber }),
    log_expense:           () => logExpenseHandler(       { ...input, whatsappNumber }),
    get_stock_level:       () => getStockLevelHandler(    { ...input, whatsappNumber }),
    get_stock_intelligence:() => getStockIntelligenceHandler(whatsappNumber),
    get_sales_summary:     () => getSalesSummaryHandler(  { ...input, whatsappNumber }),
    search_products:       () => searchProductsHandler(   { ...input, whatsappNumber }),
    correct_last_entry:    () => correctLastEntryHandler( { ...input, whatsappNumber }),
    log_debt:              () => logDebtHandler(          { ...input, whatsappNumber }),
    settle_debt:           () => settleDebtHandler(       { ...input, whatsappNumber }),
    get_debts:             () => getDebtsHandler(         { ...input, whatsappNumber }),
    set_goal:              () => setGoalHandler(          { ...input, whatsappNumber }),
    compare_periods:       () => comparePeriodsHandler(   { ...input, whatsappNumber }),
  };
  if (!handlers[toolName]) throw new Error(`Unknown tool: ${toolName}`);
  return handlers[toolName]();
}

/** One Claude API call with a single retry on 5xx / timeout. */
async function callClaude(client, params) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    const isRetryable = err.status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    if (!isRetryable) throw err;
    console.warn('[Kemi] Claude call failed, retrying in 2s...', err.message);
    await new Promise(r => setTimeout(r, RETRY_DELAY));
    return client.messages.create(params);
  }
}

/**
 * Main agent entry point.
 * Receives one WhatsApp message from a trader, runs the agentic loop,
 * and returns Kemi's final text response.
 *
 * @param {string} whatsappNumber  Sender in 234XXXXXXXXXX format
 * @param {string} incomingMessage Raw message text
 * @returns {Promise<string>}      Kemi's reply to send back via WhatsApp
 */
async function runAgent(whatsappNumber, incomingMessage, opts = {}) {
  try {
    const client = getClient();

    // 1. Look up user (best-effort — Kemi can still reply if lookup fails)
    let user = {};
    try {
      const UserModel = require('../../models/user');
      user = await UserModel.findByWhatsapp(whatsappNumber) || {};
    } catch (e) {
      console.error('[Kemi] User lookup failed:', e.message);
    }

    // 2. Load conversation history (last 20 turns)
    const history = await getConversationHistory(whatsappNumber);

    // 3. Load rolling context (language pref, summary, top products)
    const context = await getRollingContext(whatsappNumber);

    // 4. Persist the incoming message (text only — images are not stored in history)
    await appendMessage(whatsappNumber, 'user', incomingMessage);

    // 5. Build the user content block — attach image if provided
    let userContent = incomingMessage;
    if (opts.imageBase64) {
      userContent = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: opts.imageMimeType || 'image/jpeg',
            data: opts.imageBase64,
          },
        },
        { type: 'text', text: incomingMessage },
      ];
    }

    // 6. Build messages array: history + this message
    const messages = [
      ...history,
      { role: 'user', content: userContent },
    ];

    // 7. Build system prompt with cache_control on the static persona block
    const system = buildSystemPrompt(user, context);

    // 8. Agentic loop — max MAX_ITER iterations
    let iterations = 0;

    while (iterations < MAX_ITER) {
      iterations++;

      const response = await callClaude(client, {
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools:      TOOLS,
        messages,
        tool_choice: { type: 'auto' },
      });

      // Append assistant's response to the in-memory messages array
      messages.push({ role: 'assistant', content: response.content });

      // If Claude is done, stop looping
      if (response.stop_reason !== 'tool_use') break;

      // Find all tool_use blocks in this response
      const toolBlocks = response.content.filter(b => b.type === 'tool_use');
      if (toolBlocks.length === 0) break;

      // Execute tools — writes run sequentially, reads can run in parallel
      const writeBlocks = toolBlocks.filter(b => WRITE_TOOLS.has(b.name));
      const readBlocks  = toolBlocks.filter(b => !WRITE_TOOLS.has(b.name));

      const toolResults = [];

      // Sequential writes
      for (const tb of writeBlocks) {
        try {
          const result = await dispatch(tb.name, tb.input, whatsappNumber);
          toolResults.push({
            type:        'tool_result',
            tool_use_id: tb.id,
            content:     JSON.stringify(result),
          });
        } catch (err) {
          console.error(`[Kemi] Tool ${tb.name} failed:`, err.message);
          toolResults.push({
            type:        'tool_result',
            tool_use_id: tb.id,
            content:     JSON.stringify({ error: true, message: err.message }),
            is_error:    true,
          });
        }
      }

      // Parallel reads
      const readResults = await Promise.all(
        readBlocks.map(async tb => {
          try {
            const result = await dispatch(tb.name, tb.input, whatsappNumber);
            return {
              type:        'tool_result',
              tool_use_id: tb.id,
              content:     JSON.stringify(result),
            };
          } catch (err) {
            console.error(`[Kemi] Tool ${tb.name} failed:`, err.message);
            return {
              type:        'tool_result',
              tool_use_id: tb.id,
              content:     JSON.stringify({ error: true, message: err.message }),
              is_error:    true,
            };
          }
        })
      );

      toolResults.push(...readResults);

      // Append tool results as the next user turn
      messages.push({ role: 'user', content: toolResults });
    }

    if (iterations >= MAX_ITER) {
      console.warn(`[Kemi] MAX_ITER (${MAX_ITER}) hit for ${whatsappNumber}. Last messages:`,
        JSON.stringify(messages.slice(-4)));
      return 'I dey process that, abeg give me small time and try again. 🙏';
    }

    // 8. Extract final text response from the last assistant message
    const lastAssistant = messages
      .filter(m => m.role === 'assistant')
      .pop();

    const responseText = (Array.isArray(lastAssistant?.content)
      ? lastAssistant.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('')
      : String(lastAssistant?.content || '')
    ).trim();

    if (!responseText) {
      return 'E get small issue, abeg try again in a moment 🙏';
    }

    // 9. Persist Kemi's reply
    await appendMessage(whatsappNumber, 'assistant', responseText);

    // 10. Fire-and-forget rolling summary when history exceeds 40 rows
    const count = await getHistoryCount(whatsappNumber);
    if (count > 40) {
      generateRollingSummary(whatsappNumber, messages)
        .catch(err => console.error('[Kemi] Rolling summary failed:', err.message));
    }

    return responseText;

  } catch (err) {
    console.error(`[Kemi] runAgent failed for ${whatsappNumber} | msg: "${incomingMessage}" | err:`, err.message, err.stack);
    return 'E get small issue, abeg try again in a moment 🙏';
  }
}

module.exports = { runAgent, dispatch };
