/**
 * services/parser.js
 * Detect the intent of an incoming WhatsApp message and route it.
 *
 * Nigerian language patterns supported:
 *   - "k" shorthand: "30k" = 30,000
 *   - Pidgin: "I sell am for 5k" = sold 1 item for ₦5,000
 *   - Informal: "made 67k today spent 15k on stock"
 *   - Mixed: "sales 45000 rent 5000 stock 12k transport 2k"
 *
 * The parser first tries rule-based detection (fast, no API cost).
 * If the message is ambiguous, it flags it for Gemini to parse.
 *
 * Returns: { type, data, needsAI }
 *
 * Types:
 *   'daily_entry'   - revenue + expenses
 *   'inventory_in'  - received stock
 *   'inventory_out' - sold stock
 *   'stock_check'   - wants current stock levels
 *   'customer_log'  - customer count
 *   'summary'       - wants immediate summary
 *   'help'          - wants command list
 *   'unknown'       - send to Gemini for parsing
 */

'use strict';

const { parseAmount } = require('../utils/naira');

// Keywords that unambiguously signal intent
const INTENT_PATTERNS = {
  help:              /^(help|\?|commands?)$/i,
  stock_check:       /^(stock|inventory|stock\?|inventory\?)\??$/i,
  summary:           /^(summary|report|show me|my report|today's report)$/i,
  on_demand_summary: /^(show me|give me|send me).*(summary|report|numbers|total|revenue|profit)|(last\s+\d+\s+days?|last\s+week|last\s+month|this\s+month|this\s+week|today)/i,
  business_question: /^(is\s+my|should\s+i|how.*(my|our)?|what.*(my|our)?|why.*(my|our)?|can\s+i|do\s+i|am\s+i).*/i,
  inventory_in:      /\b(received|got|bought|purchased|stocked|restocked)\b.*\b(bags?|units?|pieces?|pcs|cartons?|crates?|rolls?|bottles?|packs?|dozens?|sets?|pairs?|items?|shirts?|trousers?|fabric|rice|beans|yam|maize|tomatoes?|pepper|flour|sugar|oil|sachet|gallon|kg|litre?s?|litres?|cans?|tins?)/i,
  inventory_out:     /\b(sold|sell|sold out|cleared)\b.*\b(\d+)\b.*\b(bags?|units?|pieces?|pcs|cartons?|crates?|rolls?|bottles?|packs?|dozens?|shirts?|trousers?|fabric|rice|beans|items?)/i,
  customer_log:      /\b(customers?|clients?|served|people today|new customer|customer today)\b/i,
};

// Expense category keywords → canonical labels
const EXPENSE_KEYWORDS = {
  'Stock / Inventory': /\b(stock|inventory|goods?|product|purchase|raw materials?|restocked?|supplies?)\b/i,
  'Rent':              /\b(rent|shop rent|store rent|oga rent)\b/i,
  'Staff Wages':       /\b(staff|salary|salaries|wages?|worker|employee|boy|girl|helped?)\b/i,
  'Transport':         /\b(transport|logistics?|delivery|dispatch|keke|okada|uber|bolt|tricycle|bike|fuel for trip)\b/i,
  'Utilities':         /\b(light|nepa|electricity|generator|gen|diesel|fuel|water|recharge|data|internet)\b/i,
  'Marketing':         /\b(marketing|advert|ads?|flyer|social media|instagram|facebook|promotion)\b/i,
  'Packaging':         /\b(packaging|bags?|nylons?|wraps?|boxes?|cartons?)\b/i,
  'Equipment':         /\b(equipment|machine|tools?|repair|fix|maintenance)\b/i,
  'Food & Supplies':   /\b(food|lunch|meals?|chop|eating|water|drinks?)\b/i,
  'Uncategorised':     /.*/,
};

/**
 * Parse informal Nigerian expense text into a structured breakdown object.
 * e.g. "rent 5000 stock 12k transport 2k" → { 'Rent': 5000, 'Stock / Inventory': 12000, 'Transport': 2000 }
 */
function extractExpenses(text) {
  const breakdown = {};

  // Pattern: word(s) followed by an amount
  // e.g. "rent 5000", "stock 12k", "gave Emeka 5k for stock"
  const chunks = text.matchAll(/([a-z\s]{2,30}?)\s+([\d,]+k?)\b/gi);
  for (const match of chunks) {
    const label = match[1].trim().toLowerCase();
    const amount = parseAmount(match[2]);
    if (amount <= 0) continue;

    // Skip if this looks like the revenue line
    if (/^(made|sales?|revenue|income|earned|collected|received|profit|turnover)/.test(label)) continue;

    // Map to canonical category
    let category = 'Uncategorised';
    for (const [cat, re] of Object.entries(EXPENSE_KEYWORDS)) {
      if (re.test(label)) { category = cat; break; }
    }

    breakdown[category] = (breakdown[category] || 0) + amount;
  }
  return breakdown;
}

/**
 * Try to extract a revenue figure from text.
 * Handles: "made 30k", "sales 45000", "revenue 50k", "I sell for 30k", "collected 20000"
 */
function extractRevenue(text) {
  const patterns = [
    /(?:made|earned|sales?|revenue|income|collected|sold for|received|profit from sales?)\s+([\d,]+k?)/i,
    /^([\d,]+k?)\s*(?:naira|ngn)?(?:\s+today)?$/i,  // bare number at start
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseAmount(m[1]);
  }
  return 0;
}

/**
 * Main parser — determines message type and extracts structured data.
 *
 * Only exact shortcut commands (help, stock?, summary) are handled rule-based.
 * Everything else — including all financial entries, natural language, greetings,
 * and questions — goes directly to Gemini for AI parsing. This ensures any
 * phrasing a Nigerian business owner uses is understood correctly.
 *
 * @param {string} message Raw WhatsApp message text
 * @returns {{ type: string, data: object, needsAI: boolean }}
 */
function parseMessage(message) {
  if (!message) return { type: 'unknown', data: {}, needsAI: true };

  const lower = message.trim().toLowerCase();

  // Exact shortcut commands — no AI cost needed
  if (INTENT_PATTERNS.help.test(lower))        return { type: 'help',           data: {}, needsAI: false };
  if (INTENT_PATTERNS.stock_check.test(lower)) return { type: 'stock_check',    data: {}, needsAI: false };
  if (INTENT_PATTERNS.summary.test(lower))     return { type: 'summary',        data: {}, needsAI: false };
  if (/^(debtors?|who owe me|who owes me|my debtors?|outstanding|owe me)\??$/i.test(lower)) {
    return { type: 'debtors_check', data: {}, needsAI: false };
  }

  // Natural summary requests — "summary of my numbers", "give me my summary", "business report" etc.
  // Runs before period-check so "last week summary" still gets the date-range handler below
  if (/\b(summary|report)\b/i.test(lower) && !/\b(last\s+\d+\s+days?|last\s+(week|month)|this\s+(month|week))\b/i.test(lower)) {
    return { type: 'summary', data: {}, needsAI: false };
  }

  // Period-based summary requests — "last 7 days", "last week", "this month", etc.
  // Check before business_question so "what were my sales last week?" gets date-range data
  if (/\b(last\s+\d+\s+days?|last\s+(week|month)|this\s+(month|week))\b/i.test(lower)) {
    return { type: 'on_demand_summary', data: {}, needsAI: false };
  }

  // Business coaching questions — routed to Claude with full financial history
  if (INTENT_PATTERNS.business_question.test(lower)) {
    return { type: 'business_question', data: {}, needsAI: false };
  }

  // Everything else goes to Gemini — handles any natural language
  return { type: 'unknown', data: {}, needsAI: true };
}

module.exports = { parseMessage, extractExpenses, extractRevenue };
