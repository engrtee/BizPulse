/**
 * services/gemini.js
 * Two responsibilities:
 *   1. parseWithAI(message, user) → structured JSON from ambiguous WhatsApp text
 *   2. generateRecommendation(summaryData, user) → daily AI recommendation for email
 *
 * Nigeria-specific prompt context is baked into every call.
 */

'use strict';

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;

function getClient() {
  if (!genAI) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not set in .env');
    }
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

// ---------- Nigerian business context ----------
const NIGERIA_CONTEXT = `
You are a financial assistant for small business owners (SMEs) in Nigeria.
Key Nigerian market context you must apply:
- Currency is Nigerian Naira (₦). "k" means thousands: "30k" = 30,000.
- Common business types: Fashion/clothing traders, food vendors, retail/FMCG, restaurants,
  online sellers, service providers, manufacturers, beauty/personal care.
- Common expense categories: Stock/Inventory, Rent, Staff Wages, Transport (including fuel, keke, okada, logistics),
  Utilities (NEPA/generator/diesel/data), Marketing, Packaging, Equipment, Food & Supplies.
- Business challenges: fuel scarcity, NEPA outages, market day patterns, naira devaluation,
  logistics cost, customer retention, inventory shrinkage.
- Language is informal Nigerian English and Pidgin. Examples:
  "I sell am for 5k" = sold 1 item for ₦5,000
  "gave Emeka 5k for stock" = paid ₦5,000 for inventory
  "made 30k today" = revenue of ₦30,000
  "nepa no carry light" = electricity was out
  "I pack 10 bags" = sold/moved 10 bags
Always respond in plain English, not accounting jargon. Be warm and encouraging.
`;

/**
 * Use Gemini to parse an ambiguous WhatsApp message into structured JSON.
 * Called when rule-based parser returns needsAI: true.
 *
 * @param {string} message  Raw WhatsApp message
 * @param {object} user     User record (for biz_type context)
 * @returns {object}        Structured data matching the message type
 */
async function parseWithAI(message, user) {
  const prompt = `
${NIGERIA_CONTEXT}

The user runs a "${user.biz_type || 'retail'}" business in Nigeria.
Their name is ${user.name}.

Parse this WhatsApp business message and return a JSON object.

Message: "${message}"

Classify as ONE of these types and extract the listed fields:

1. daily_entry → { type, revenue, totalExpenses, expenseBreakdown (object: category→amount), customers, notes }
2. inventory_in → { type, item, quantity, unitPrice, totalValue }
3. inventory_out → { type, item, quantity }
4. customer_log → { type, count, notes }
5. unknown → { type }

Expense categories to use: Stock / Inventory, Rent, Staff Wages, Transport, Utilities, Marketing, Packaging, Equipment, Food & Supplies, Other

Rules:
- All amounts must be numbers (not strings). Convert "k" shorthand.
- If revenue is not mentioned, set revenue to 0.
- If no expenses, set totalExpenses to 0 and expenseBreakdown to {}.
- Return ONLY valid JSON. No markdown, no explanation, no code blocks.
`;

  try {
    const model = getClient().getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Strip any accidental markdown fences
    const clean = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(clean);

    // Validate profit/margin if daily entry
    if (parsed.type === 'daily_entry') {
      parsed.revenue       = parseFloat(parsed.revenue)       || 0;
      parsed.totalExpenses = parseFloat(parsed.totalExpenses) || 0;
      parsed.profit        = parsed.revenue - parsed.totalExpenses;
      parsed.margin        = parsed.revenue > 0
        ? parseFloat(((parsed.profit / parsed.revenue) * 100).toFixed(2))
        : 0;
      parsed.customers     = parseInt(parsed.customers, 10) || 0;
    }

    return parsed;
  } catch (err) {
    console.error('[Gemini] parseWithAI error:', err.message);
    // Fallback: return unknown so the caller can handle gracefully
    return { type: 'unknown' };
  }
}

/**
 * Generate a personalised daily AI recommendation for the evening email.
 *
 * @param {object} summaryData  { revenue, totalExpenses, profit, margin, healthScore, topExpense, expenseBreakdown, customers, date }
 * @param {object} user         User record (name, biz_type, state, streak)
 * @returns {object}            { risk: string, actions: string[] }
 */
async function generateRecommendation(summaryData, user) {
  const { revenue, totalExpenses, profit, margin, topExpense, expenseBreakdown, customers, date } = summaryData;
  const streak       = user.streak || 0;
  const bizType      = user.biz_type || 'Retail';
  const isProfitable = parseFloat(profit) >= 0;
  const topCat       = topExpense?.category || 'General expenses';
  const topAmt       = topExpense?.amount   || 0;
  const marginVal    = parseFloat(margin).toFixed(1);

  // Build an expense breakdown section if available
  const breakdownLines = expenseBreakdown && Object.keys(expenseBreakdown).length > 0
    ? Object.entries(expenseBreakdown)
        .sort(([,a],[,b]) => b - a)
        .map(([cat, amt]) => `  - ${cat}: ₦${Number(amt).toLocaleString('en-NG')}`)
        .join('\n')
    : '  (no breakdown available)';

  // Tailor the customer label by business type
  const isService = /service|consult|technology|advertising|education|photography|project/i.test(bizType);
  const custLabel = isService ? 'Clients Served' : 'Customers Today';

  const prompt = `A Nigerian ${bizType} business recorded:
Revenue: ₦${Number(revenue).toLocaleString('en-NG')}
Total Expenses: ₦${Number(totalExpenses).toLocaleString('en-NG')}
Net Profit: ₦${Number(profit).toLocaleString('en-NG')}
Profit Margin: ${marginVal}%
${custLabel}: ${customers}
Consecutive Days Tracked: ${streak}

Expense Breakdown:
${breakdownLines}

Top Expense Category: ${topCat} at ₦${Number(topAmt).toLocaleString('en-NG')}
The business is ${isProfitable ? 'profitable' : 'loss-making'} today.

${isService ? `Note: This is a service business — "Stock" costs are likely materials/supplies, not physical inventory. "Staff Wages" are a primary cost driver.` : ''}

Respond in this exact JSON format — no markdown, no code blocks, just JSON:
{
  "risk": "One specific sentence referencing their actual top expense (${topCat}) or margin (${marginVal}%) — not generic advice",
  "actions": [
    "Specific action referencing their business type (${bizType}) and actual numbers",
    "Specific action 2",
    "Specific action 3"
  ]
}

Rules:
- Reference the actual top expense category and margin percentage in the risk sentence.
- Reference their business type (${bizType}) in at least one action.
- Use Nigerian business context (naira, local market conditions).
- Keep the total response under 120 words.
- Actions must be actionable this week, not generic.
- Never give generic advice like "monitor your expenses" — always reference the actual numbers.`;

  try {
    const model = getClient().getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const clean = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[Gemini] generateRecommendation error:', err.message);
    // Safe fallback
    return {
      risk: 'Monitor your expense categories closely to protect your profit margin.',
      actions: [
        'Review your top expense category and see if costs can be reduced.',
        'Follow up with repeat customers to encourage another purchase.',
        'Set a daily revenue target and track it every morning.',
      ],
    };
  }
}

module.exports = { parseWithAI, generateRecommendation };
