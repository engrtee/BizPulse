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

You are BizPulse — a personal business data assistant for Nigerian SMEs.
The user runs a "${user.biz_type || 'retail'}" business.
Their name is ${user.name}.

Read this WhatsApp message and return a JSON object.
Message: "${message}"

Classify as EXACTLY ONE of these types:

1. daily_entry — they are logging sales, revenue, income, or expenses for the day
   Return: { "type": "daily_entry", "revenue": number, "totalExpenses": number, "expenseBreakdown": {category: amount}, "customers": number, "notes": string }

2. inventory_in — they received, bought, or restocked physical goods
   Return: { "type": "inventory_in", "item": string, "quantity": number, "unitPrice": number, "totalValue": number }

3. inventory_out — they sold specific inventory items (not revenue logging)
   Return: { "type": "inventory_out", "item": string, "quantity": number }

4. customer_log — they are only reporting a customer count, with no financial figures
   Return: { "type": "customer_log", "count": number, "notes": string }

5. greeting — hello, good morning, how are you, general pleasantries
   Return: { "type": "greeting", "message": string }
   The message must be a warm, encouraging reply (2-3 sentences max) as their personal business assistant. Reference their business type or name naturally.

6. question — asking for advice, explanation, or help about their business, BizPulse features, or finances
   Return: { "type": "question", "message": string }
   The message must be a helpful, specific answer (2-3 sentences max) grounded in Nigerian business context.

7. unknown — completely off-topic, cannot be classified
   Return: { "type": "unknown" }

Expense categories to use: Stock / Inventory, Rent, Staff Wages, Transport, Utilities, Marketing, Packaging, Equipment, Food & Supplies, Professional Fees, Data / Internet, Uncategorised

════ CRITICAL REVENUE RULES ════
Only count money as revenue if it has already been physically received today.

DO NOT count as revenue (set to 0, add to notes):
- Money "agreed" or "approved" but not yet paid
- Future retainers or recurring contracts not yet received
- "Balance on delivery" — only count when explicitly collected
- "They said they will pay" / "promise to pay"
- "Starting next month" payments
- Signed contracts where no cash has changed hands yet

DO count as revenue:
- Cash or transfer received today
- Deposits or part-payments received today
- Balances explicitly collected today ("collect balance", "they paid")
- Debt payments received today ("she paid what she owed")

When income is mentioned but NOT yet received, add it to notes as:
"pending_income: [amount] - [description]"

Example:
"MTN invoice 250k, Zenith agreed 180k retainer"
→ revenue: 250000 (MTN paid/invoiced today)
→ notes: "pending_income: 180000 - Zenith Bank retainer agreed but not yet received"

════ INVENTORY vs REVENUE RULES ════
Message is INVENTORY IN (type: inventory_in) when:
- Contains words: "received", "receive", "new stock", "restock", "from supplier",
  "from warehouse", "buy stock", "stock arrive", "delivery arrive", "got stock"
- Pattern: "[quantity] [item] at [price] each" with no sale keywords
- The person is describing goods coming INTO their business

Message is REVENUE (type: daily_entry) when:
- Contains: "sell", "sold", "customer buy", "customer pay", "sale", "I move"
- Or: lists items with prices where they are clearly the seller

CRITICAL: "received 5 iPhone at 850000 each" → inventory_in, revenue=0 (NOT a sale)
CRITICAL: "sell iPhone 1 piece 980000" → daily_entry, revenue=980000

When ambiguous between purchase and sale — default to inventory_in.

════ WHOLESALE / FMCG REVENUE RULES ════
Nigerian traders — especially FMCG, wholesale, and market traders — often list
sales WITHOUT using the word "sell". Treat these as daily_entry (revenue):

Pattern examples (these are SALES, not purchases):
- "indomie 80 carton 3800 each = 304000"
- "peak milk 30 carton 7200 each = 216000"
- "ankara 4 yards 4500 each = 18000"
- "yam 35 tubers 1200 each"

Recognize as REVENUE when:
- Message lists item + quantity + price (quantity × price format)
- No inventory keywords (received/bought/restock/from supplier) are present
- The items listed are typical goods this business TYPE sells (not raw materials)
- A total is provided that matches quantity × price

In these cases: revenue = total provided by user (or calculated from qty × price)

════ GENERAL RULES ════
- All amounts must be numbers. "k" = thousands (30k = 30000). "m" = millions (1.5m = 1500000).
- Natural language is normal: "Today was good, made 45k from customers, paid 10k stock and 3k transport" → daily_entry
- If revenue AND expenses are mentioned together, it is ALWAYS daily_entry, never customer_log.
- If revenue is not mentioned, set revenue to 0.
- If no expenses, set totalExpenses to 0 and expenseBreakdown to {}.
- Return ONLY valid JSON. No markdown, no explanation, no code blocks.
`;

  try {
    const model = getClient().getGenerativeModel({ model: 'gemini-2.5-flash' });
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
    const model = getClient().getGenerativeModel({ model: 'gemini-2.5-flash' });
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

/**
 * Transcribe a WhatsApp voice note using Gemini multimodal.
 * Returns the plain-text transcript so it can be fed into parseWithAI()
 * exactly like a typed message.
 *
 * @param {Buffer} audioBuffer  Raw audio bytes downloaded from Meta
 * @param {string} mimeType     e.g. 'audio/ogg; codecs=opus'
 * @param {object} user         User record (for biz_type context)
 * @returns {{ transcript: string, confidence: number }}
 */
async function transcribeAudio(audioBuffer, mimeType, user) {
  const prompt = `
You are transcribing a voice note from a Nigerian small business owner.
They may speak in Nigerian English, Pidgin English, or mix with Yoruba/Igbo/Hausa.
The user runs a "${user.biz_type || 'retail'}" business.

Common Nigerian speech patterns to recognise:
- "Na" means "is/was": "Sales today na 45k" = revenue ₦45,000
- "I sell am" = I sold it
- "K" after number = thousands: "45k" = 45,000
- "I buy" can mean "I spent on" / "I purchased"
- "Nepa" = electricity/utility, "Gen" = generator, "Keke" = tricycle (transport)
- "Oga" = boss/landlord, "Mama put" = small food vendor
- Mixed English/Pidgin is completely normal

Your tasks:
1. Transcribe the voice note as accurately as possible in plain text.
2. Estimate confidence from 0.0 (unintelligible) to 1.0 (crystal clear).

Return ONLY valid JSON — no markdown, no explanation:
{ "transcript": "exact words spoken", "confidence": 0.95 }
`;

  try {
    const model = getClient().getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimeType || 'audio/ogg; codecs=opus',
          data: audioBuffer.toString('base64'),
        },
      },
      { text: prompt },
    ]);
    const text   = result.response.text().trim();
    const clean  = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(clean);
    return {
      transcript: String(parsed.transcript || '').trim(),
      confidence: parseFloat(parsed.confidence) || 0,
    };
  } catch (err) {
    console.error('[Gemini] transcribeAudio error:', err.message);
    return { transcript: '', confidence: 0 };
  }
}

module.exports = { parseWithAI, generateRecommendation, transcribeAudio };
