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

// Lazy-required to avoid circular dependency at module load time
function getLearningService() {
  return require('./learningService');
}

// ── Non-blocking inference logger ────────────────────────────────────────────
// Writes one row to ai_inference_log after every Gemini call.
// Never throws — a log failure must never affect the user response.
function logInference({ userId, callType, model, inputText, outputText, parsedType, latencyMs }) {
  const { query } = require('../models/db');
  query(
    `INSERT INTO ai_inference_log
       (user_id, call_type, model, input_text, output_text, parsed_type, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      userId   || null,
      callType,
      model,
      inputText.slice(0, 4000),   // cap at 4k chars — system prompt is separate
      outputText.slice(0, 8000),
      parsedType || null,
      latencyMs  || null,
    ]
  ).catch(e => console.error('[Gemini] logInference failed:', e.message));
}

// ── Unit extraction from raw message ─────────────────────────────────────────
// Gemini normalises units based on training data (e.g. rice → cups).
// This function scans the ORIGINAL message text for recognised unit words
// next to a quantity number and returns the verbatim unit the user typed.
// It runs AFTER the AI parse and overrides whatever the AI returned.
const UNIT_WORDS = [
  'bags', 'bag', 'cartons', 'carton', 'tins', 'tin', 'tubers', 'tuber',
  'yards', 'yard', 'packs', 'pack', 'pieces', 'piece', 'bottles', 'bottle',
  'crates', 'crate', 'bundles', 'bundle', 'rolls', 'roll',
  'sachets', 'sachet', 'wraps', 'wrap', 'dozens', 'dozen', 'pairs', 'pair',
  'cups', 'cup', 'litres', 'litre', 'liters', 'liter',
  'kg', 'kgs', 'grams', 'gram', 'tons', 'ton', 'tonnes', 'tonne',
  'boxes', 'box', 'trays', 'tray', 'buckets', 'bucket',
  'sheets', 'sheet', 'reams', 'ream', 'units', 'unit',
];

function extractUnitFromMessage(rawMessage, quantity) {
  if (!quantity || !rawMessage) return null;
  const lowerMsg = rawMessage.toLowerCase().replace(/,/g, ' ');
  const qty      = parseFloat(quantity);
  if (!qty || isNaN(qty)) return null;

  // Escape the quantity for use in regex (handles decimals like 1.5)
  const escapedQty = String(qty).replace('.', '\\.');

  for (const unit of UNIT_WORDS) {
    // Match "{qty} {unit}" — e.g. "5 bags" or "5bags"
    const re = new RegExp(`\\b${escapedQty}\\s+${unit}\\b`, 'i');
    if (re.test(lowerMsg)) return unit;
  }
  return null;
}

function applyExtractedUnits(rawMessage, products) {
  if (!Array.isArray(products) || !rawMessage) return products;
  return products.map(p => {
    if (!p.quantity) return p;
    const extracted = extractUnitFromMessage(rawMessage, p.quantity);
    return extracted ? { ...p, unit: extracted } : p;
  });
}

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
  const learnedContext = await getLearningService().getLearnedContext().catch(() => '');

  const todayWAT     = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const yesterdayWAT = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  const prompt = `
${NIGERIA_CONTEXT}
${learnedContext}

You are BizPulse — a personal business data assistant for Nigerian SMEs.
The user runs a "${user.biz_type || 'retail'}" business.
Their name is ${user.name}.

Read this WhatsApp message and return a JSON object.
Message: "${message}"

Classify as EXACTLY ONE of these types:

1. daily_entry — they are logging sales, revenue, income, or expenses for the day
   Return: { "type": "daily_entry", "revenue": number, "totalExpenses": number, "expenseBreakdown": {category: amount}, "expenseItems": [ { "name": string, "amount": number } ], "customers": number, "notes": string, "products": [ { "product_name": string, "transaction_type": "sale"|"stock_in", "quantity": number|null, "unit_price": number|null, "total_amount": number, "unit": string, "channel": "retail"|"wholesale" } ] }
   expenseBreakdown groups expenses by category (e.g. {"Stock / Inventory": 8000}) — used for charts.
   expenseItems lists each individual expense separately (e.g. [{"name":"Tomatoes","amount":6000},{"name":"Palm oil","amount":2000}]) — used for confirmation display.
   If no expenses, set expenseBreakdown to {} and expenseItems to [].
   The products array must list every named item with a quantity or price. Include stock received in the same message too (transaction_type: "stock_in"). Set products to [] if no specific products are named.
   channel: set to "wholesale" if the message contains keywords like "wholesale", "bulk", "bulk order", "for traders", "market price", "trade price". Otherwise set to "retail".

2. inventory_in — they received, bought, or restocked physical goods
   Return: { "type": "inventory_in", "item": string, "quantity": number, "unitPrice": number, "totalValue": number, "products": [ { "product_name": string, "transaction_type": "stock_in", "quantity": number, "unit_price": number|null, "total_amount": number, "unit": string, "channel": "retail" } ] }

3. inventory_out — they sold specific inventory items (not revenue logging)
   Return: { "type": "inventory_out", "item": string, "quantity": number, "sale_type": "cash"|"credit", "debtor_name": string|null, "products": [ { "product_name": string, "transaction_type": "sale", "quantity": number, "unit_price": number|null, "total_amount": number|null, "unit": string, "channel": "retail"|"wholesale" } ] }
   sale_type = "credit" when message contains: "on credit", "they go pay", "will pay later", "owe me", "collect and pay", "pay me later", "balance later", "go pay", "dey owe", "e go pay", "she go pay", "he go pay", "credit sale"
   debtor_name = the name of the buyer if mentioned, else null

4. opening_stock — they are declaring what stock they currently have (not a sale or purchase)
   Trigger phrases: "I have", "I get", "my stock is", "currently have", "na this I get",
   "for my shop I have", "I have in my store", "my products are"
   Return: { "type": "opening_stock", "products": [ { "product_name": string, "quantity": number|null, "unit": string } ] }
   Example: "I have 20 oud oil 15 rose and 5 musk" → opening_stock with 3 products
   Do NOT classify as opening_stock if the message also contains prices in a sale/purchase context.

5. stock_zero — user is reporting a product has completely run out or wants it marked as out of stock
   Trigger phrases (Nigerian Pidgin and English):
   "[product] don finish", "[product] e don finish o", "[product] don comot", "[product] don comot finish",
   "[product] finish", "[product] finished", "[product] is finished", "[product] don exhaust",
   "[product] abeg update", "[product] done", "[product] no more", "[product] don go",
   "e don finish o" (no product = null), "e don finish", "it has finished", "it don finish"
   Return: { "type": "stock_zero", "product_name": string|null }
   If no product name is identifiable, set product_name to null.
   Examples:
   "milo don finish" → { "type": "stock_zero", "product_name": "milo" }
   "e don finish o" → { "type": "stock_zero", "product_name": null }
   "milo e don finish o" → { "type": "stock_zero", "product_name": "milo" }
   "milo abeg update" → { "type": "stock_zero", "product_name": "milo" }
   "rice don comot finish" → { "type": "stock_zero", "product_name": "rice" }
   Do NOT classify as stock_zero if the message also contains revenue figures or is clearly a sale/purchase.

6. customer_log — they are only reporting a customer count, with no financial figures
   Return: { "type": "customer_log", "count": number, "notes": string }

7. debt_payment — someone is paying back money they owe the user
   Trigger phrases: "[Name] paid me", "[Name] don pay", "she settle the balance", "they paid their debt", "he paid back", "Emeka pay me", "Ngozi don settle", "received payment from", "they cleared their debt", "balance don pay"
   Return: { "type": "debt_payment", "debtor_name": string, "amount": number, "notes": string }
   debtor_name: the person's name who is paying. amount: how much they paid.
   Example: "Ngozi paid me 25k" → { "type": "debt_payment", "debtor_name": "Ngozi", "amount": 25000 }
   Example: "Emeka settle 15k balance" → { "type": "debt_payment", "debtor_name": "Emeka", "amount": 15000 }
   Do NOT classify as debt_payment if the money is from a new customer paying on the spot (that is daily_entry revenue).

8. greeting — hello, good morning, how are you, general pleasantries
   Return: { "type": "greeting", "message": string }
   The message must be a warm, encouraging reply (2-3 sentences max) as their personal business assistant. Reference their business type or name naturally.

9. question — asking for advice, explanation, or help about their business, BizPulse features, or finances
   Return: { "type": "question", "message": string }
   The message must be a helpful, specific answer (2-3 sentences max) grounded in Nigerian business context.

10. unknown — completely off-topic, cannot be classified
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

CRITICAL — inventory_out vs daily_entry:
- "sold 30 laptops at 200k each" → inventory_out (specific product + quantity named)
- "sold 5 bags rice" → inventory_out (specific product + quantity named)
- "made 45k today" → daily_entry (aggregate revenue, no specific product)
- "sales was 200k, expenses 30k" → daily_entry (aggregate with expenses)
When a specific product name AND quantity is mentioned with "sold/sell", classify as inventory_out NOT daily_entry.

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

════ PRODUCT EXTRACTION RULES ════
Always populate the products array for daily_entry, inventory_in, and inventory_out.

For each distinct product mentioned:
- product_name: the item name as the user wrote it (do NOT normalise — keep raw)
- transaction_type: "sale" if they sold it, "stock_in" if they received/bought it
- quantity: number of units (null if not mentioned)
- unit_price: price per unit (null if not mentioned)
- total_amount: quantity × unit_price, or the total stated by user
- unit: "bags", "cartons", "pieces", "yards", "bottles", "units" etc. (default "units")

Examples:
- "sold 3 bags of rice at 25k each" → { product_name: "rice", transaction_type: "sale", quantity: 3, unit_price: 25000, total_amount: 75000, unit: "bags" }
- "received 10 ankara at 4500 each" → { product_name: "ankara", transaction_type: "stock_in", quantity: 10, unit_price: 4500, total_amount: 45000, unit: "yards" }
- "indomie 80 carton 3800 each = 304000" → { product_name: "indomie", transaction_type: "sale", quantity: 80, unit_price: 3800, total_amount: 304000, unit: "cartons" }
- "sold shoes for 15k" (no quantity) → { product_name: "shoes", transaction_type: "sale", quantity: null, unit_price: null, total_amount: 15000, unit: "units" }

If only total revenue is mentioned with no product breakdown (e.g. "made 45k today"), return products: [].

════ CRITICAL UNIT RULES ════
The unit field MUST contain the EXACT word the user typed next to the quantity.
Extract it from the user's own words. NEVER use cooking or standard measurement units.

HOW TO EXTRACT THE UNIT — look at the word directly next to the number:
"5 bags of rice"     → unit: "bags"     ← the word next to 5 is "bags"
"20 cartons indomie" → unit: "cartons"
"10 tins sardine"    → unit: "tins"
"3 tubers of yam"    → unit: "tubers"
"50 yards ankara"    → unit: "yards"
"30 packs water"     → unit: "packs"

ABSOLUTELY FORBIDDEN substitutions:
"5 bags of rice"  → unit: "cups"   ← WRONG. Rice is NOT measured in cups here
"5 bags of rice"  → unit: "kg"     ← WRONG. Never convert to weight
"3 cartons"       → unit: "boxes"  ← WRONG. Never rename
"3 tubers of yam" → unit: "pieces" ← WRONG. Never normalize

If no unit word appears in the message → unit: "units"

════ INGREDIENT vs RESALE CONTEXT ════
The same item (e.g. tomatoes, palm oil, yam) can be either:
  a) An ingredient/raw material the user buys to make something else (→ put in expenseItems, NOT products)
  b) A finished good the user buys and resells directly (→ put in products as stock_in)

Use the business type to decide:

FOOD / RESTAURANT business type:
  Tomatoes, pepper, palm oil, onions, seasoning, crayfish, stock fish,
  flour, eggs, butter, sugar, vegetable oil, spices → INGREDIENTS (expenseItems only)
  The finished dish (pepper soup, fried rice, jollof, shawarma, cake) → products (sale)

RETAIL / FMCG / WHOLESALE business type:
  The same tomatoes, palm oil, yam, rice, flour → RESALE GOODS (products as stock_in)
  Because a market trader buys to resell, not to cook.

FASHION / TAILORING business type:
  Thread, buttons, zips, interfacing, lining → raw materials (expenseItems only)
  Ankara, lace, george (if bought to resell as fabric) → products (stock_in)
  Finished gown, dress, suit → products (sale)

When biz_type is ambiguous or not listed above: use context clues.
If the user says "I use [item] to make [other item]" → ingredient (expenseItems).
If the user says "I sell [item]" or quantity × price implies resale → product.

════ DATE RULES ════
Today's date (WAT): ${todayWAT}
Yesterday's date:   ${yesterdayWAT}

If the message refers to a past date, add "entry_date": "YYYY-MM-DD" to the response.
- "yesterday" → entry_date: "${yesterdayWAT}"
- "last Monday" / "on Monday" → calculate the most recent Monday before today
- "2 days ago" → subtract 2 days from today
- "on [weekday]" → most recent occurrence of that weekday before today
Omit "entry_date" completely when referring to today or when no past date is mentioned.
Maximum backdating: 7 days. If older → add to notes but do NOT set entry_date.

════ GENERAL RULES ════
- All amounts must be numbers. "k" = thousands (30k = 30000). "m" = millions (1.5m = 1500000).
- Natural language is normal: "Today was good, made 45k from customers, paid 10k stock and 3k transport" → daily_entry
- If revenue AND expenses are mentioned together, it is ALWAYS daily_entry, never customer_log.
- If revenue is not mentioned, set revenue to 0.
- If no expenses, set totalExpenses to 0 and expenseBreakdown to {}.
- Return ONLY valid JSON. No markdown, no explanation, no code blocks.
`;

  const t0 = Date.now();
  try {
    const modelName = 'gemini-2.5-flash';
    const model = getClient().getGenerativeModel({ model: modelName });
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
      parsed.products      = Array.isArray(parsed.products)      ? parsed.products      : [];
      parsed.expenseItems  = Array.isArray(parsed.expenseItems)  ? parsed.expenseItems  : [];
      parsed.products      = applyExtractedUnits(message, parsed.products);
    }
    if (parsed.type === 'inventory_in' || parsed.type === 'inventory_out') {
      parsed.products = Array.isArray(parsed.products) ? parsed.products : [];
      parsed.products = applyExtractedUnits(message, parsed.products);
    }
    if (parsed.type === 'opening_stock') {
      parsed.products = Array.isArray(parsed.products) ? parsed.products : [];
      parsed.products = applyExtractedUnits(message, parsed.products);
    }
    if (parsed.type === 'stock_zero') {
      parsed.product_name = parsed.product_name || null;
    }
    if (parsed.type === 'inventory_out') {
      parsed.sale_type    = parsed.sale_type === 'credit' ? 'credit' : 'cash';
      parsed.debtor_name  = parsed.debtor_name || null;
    }
    if (parsed.type === 'debt_payment') {
      parsed.amount      = parseFloat(parsed.amount) || 0;
      parsed.debtor_name = parsed.debtor_name || 'Unknown';
    }

    // Log for training dataset — non-blocking, never affects response
    logInference({
      userId:     user?.id,
      callType:   'parse',
      model:      modelName,
      inputText:  message,
      outputText: clean,
      parsedType: parsed.type,
      latencyMs:  Date.now() - t0,
    });

    return parsed;
  } catch (err) {
    console.error('[Gemini] parseWithAI error:', err.message);
    logInference({
      userId:     user?.id,
      callType:   'parse',
      model:      'gemini-2.5-flash',
      inputText:  message,
      outputText: 'ERROR: ' + err.message,
      parsedType: 'error',
      latencyMs:  Date.now() - t0,
    });
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

/**
 * Analyse a photo (shelf, invoice, handwritten list) using Gemini Vision.
 * Returns a structured product array with confidence levels.
 *
 * @param {Buffer} imageBuffer  Raw image bytes downloaded from Meta
 * @param {string} mimeType     e.g. 'image/jpeg'
 * @param {object} user         User record (for biz_type context)
 * @param {string} intent       'opening_stock' | 'stock_in' | 'sale'
 * @returns {{ products: Array, rawResponse: string }}
 */
async function analyzePhoto(imageBuffer, mimeType, user, intent = 'opening_stock') {
  const intentDesc = {
    opening_stock: 'declaring current stock levels',
    stock_in:      'logging stock just received from a supplier',
    sale:          'recording sales made today',
  }[intent] || 'declaring current stock levels';

  const prompt = `You are analyzing a photo from a Nigerian small business owner.
They run a "${user.biz_type || 'retail'}" business and are ${intentDesc}.

The photo may show:
A) A shelf or storage area with products
B) A delivery receipt or invoice
C) A handwritten stock list
D) Products laid out on a table or floor

For shelf/storage photos:
  Identify all clearly visible products. Estimate quantities only if clearly countable.

For receipts and invoices:
  Extract all line items: product name, quantity, unit, price.
  Handle handwritten text carefully. Nigerian currency is ₦ (naira).

For handwritten stock lists:
  Extract all product names and quantities listed.

Nigerian products to recognise:
  Oud oil, Rose oil, Musk oil, Amber oil, Sandalwood oil,
  Ankara fabric, Lace fabric,
  Indomie noodles, Peak Milk, Cowbell Milk, Golden Morn, Caprisonne,
  Garri, Rice, Beans, Palm oil, Groundnut oil, Tomatoes, Pepper, Onions,
  Cabin Biscuits, Digestive biscuits, Crackers

Return ONLY valid JSON array — no explanation, no markdown:
[
  {
    "product": string,
    "quantity": number or null,
    "unit": string or null,
    "price": number or null,
    "confidence": "high" | "medium" | "low",
    "notes": string or null
  }
]

confidence:
  "high"   — clearly visible text/label, quantity countable
  "medium" — partially visible or slightly unclear
  "low"    — guessed or very unclear

If the image is too dark, blurry, or contains no product information: return []`;

  try {
    const model = getClient().getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: imageBuffer.toString('base64'),
        },
      },
      { text: prompt },
    ]);
    const text   = result.response.text().trim();
    const clean  = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(clean);
    return {
      products: Array.isArray(parsed) ? parsed : [],
      rawResponse: clean,
    };
  } catch (err) {
    console.error('[Gemini] analyzePhoto error:', err.message);
    return { products: [], rawResponse: '' };
  }
}

module.exports = { parseWithAI, generateRecommendation, transcribeAudio, analyzePhoto };
