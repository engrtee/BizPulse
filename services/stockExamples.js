'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// In-memory cache keyed by lowercased trimmed biz_type
const _cache = {};

// ── Hardcoded examples for known Nigerian business categories ─────────────────

const HARDCODED = [
  {
    regex: /\b(food|foodstuff|spice|rice|garri|tomato|stap)/i,
    examples:
      'a. 50 bags of rice at ₦400,000 each\n' +
      'b. 49 bags of garri at ₦30,000 each\n' +
      'c. 20 cartons of tomato paste at ₦18,000 each',
  },
  {
    regex: /\b(stationery|exercise book|a4 paper|ballpoint|office supply)/i,
    examples:
      'a. 4 cartons of exercise books at ₦12,000 each\n' +
      'b. 10 reams of A4 paper at ₦7,500 each\n' +
      'c. 6 boxes of ballpoint pens at ₦3,500 each',
  },
  {
    regex: /\b(perfume|fragrance|oud|musk|rose oil|scent|essential oil)/i,
    examples:
      'a. 20 bottles of oud oil at ₦8,500 each\n' +
      'b. 15 bottles of rose oil at ₦6,000 each\n' +
      'c. 12 bottles of musk oil at ₦5,500 each',
  },
  {
    regex: /\b(fashion|fabric|cloth|tailor|ankara|lace|george|ready.?made|wear|dres)/i,
    examples:
      'a. 8 pieces of ankara fabric at ₦4,500 each\n' +
      'b. 5 yards of lace at ₦22,000 each\n' +
      'c. 12 ready-made tops at ₦6,000 each',
  },
  {
    regex: /\b(phone|accessory|accessories|electronic|gadget|cable|screen|charging)/i,
    examples:
      'a. 30 phone cases at ₦2,500 each\n' +
      'b. 20 charging cables at ₦1,800 each\n' +
      'c. 15 screen protectors at ₦1,200 each',
  },
  {
    regex: /\b(provision|fmcg|retail|trading|store|shop|indomie|noodle|sugar|malt|milk|cabin)/i,
    examples:
      'a. 6 cartons of Indomie noodles at ₦9,500 each\n' +
      'b. 4 cartons of Malta Guinness at ₦8,200 each\n' +
      'c. 10 bags of sugar at ₦75,000 each',
  },
  {
    regex: /\b(cosmetic|beauty|cream|relaxer|hair attach|makeup|lotion|salon|nail)/i,
    examples:
      'a. 24 tubes of Fair & White cream at ₦3,200 each\n' +
      'b. 15 bottles of relaxer at ₦4,500 each\n' +
      'c. 30 packs of hair attachments at ₦2,800 each',
  },
  {
    regex: /\b(shoe|footwear|sandal|loafer|heel|slipper|boot)/i,
    examples:
      'a. 20 pairs of men\'s loafers at ₦12,000 each\n' +
      'b. 15 pairs of ladies\' heels at ₦9,500 each\n' +
      'c. 10 pairs of children\'s sandals at ₦4,500 each',
  },
];

const FALLBACK_EXAMPLES =
  'a. 6 cartons of Indomie noodles at ₦9,500 each\n' +
  'b. 4 cartons of Malta Guinness at ₦8,200 each\n' +
  'c. 10 bags of sugar at ₦75,000 each';

const AI_SYSTEM_PROMPT =
  'You are a Nigerian market trade expert who knows exactly what physical goods traders ' +
  'sell and at what price ranges in Nigerian naira.\n\n' +
  'You generate realistic, specific opening stock examples for Nigerian small business owners ' +
  'using BizPulse, a WhatsApp stock tracking tool.\n\n' +
  'Rules:\n' +
  '- Always use Nigerian naira (₦) prices\n' +
  '- Use realistic Nigerian market prices as of 2025\n' +
  '- Use the exact format: lettered list a. b. c. with quantity, product name, and unit price\n' +
  '- Generate exactly 3 items\n' +
  '- Items must be the most common physical goods a trader in this business would stock\n' +
  '- Use specific product names, not generic ones\n' +
  '- Never use vague terms like "items" or "goods"\n' +
  '- Return only the 3 example lines, nothing else, no preamble, no explanation';

const AI_USER_TEMPLATE = (bizType) =>
  `Business type: ${bizType}\n\n` +
  'Generate 3 opening stock examples for this trader.\n' +
  'Format exactly like this:\n' +
  'a. 50 bags of rice at ₦400,000 each\n' +
  'b. 49 bags of garri at ₦30,000 each\n' +
  'c. 20 cartons of tomato paste at ₦18,000 each';

/**
 * Call Claude Haiku to generate business-specific stock examples.
 * Falls back to the provisions example on any error.
 */
async function generateStockExamplesWithAI(bizType) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[StockExamples] ANTHROPIC_API_KEY not set — using fallback examples');
    return FALLBACK_EXAMPLES + '\nAdjust the product names to match what you sell.';
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: [
        {
          type:          'text',
          text:          AI_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: AI_USER_TEMPLATE(bizType) }],
    });

    const raw   = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
    const lines = raw.split('\n').map(l => l.trim()).filter(l => /^[abc]\.\s+/i.test(l));
    if (lines.length >= 3) {
      return lines.slice(0, 3).join('\n');
    }
    console.warn('[StockExamples] AI returned fewer than 3 valid lines for:', bizType);
  } catch (err) {
    console.error('[StockExamples] AI generation failed:', err.message);
  }

  return FALLBACK_EXAMPLES + '\nAdjust the product names to match what you sell.';
}

/**
 * Get business-specific opening stock examples.
 *
 * Priority:
 *   1. Hardcoded list (instant, no API call)
 *   2. In-memory cache (previously AI-generated)
 *   3. Claude Haiku AI generation → cached → returned
 *
 * Always resolves — never throws.
 *
 * @param  {string} bizType  User's business type string (any case)
 * @returns {Promise<string>} Three lettered example lines (a. b. c.)
 */
async function getStockExamples(bizType) {
  const b = (bizType || '').trim();

  // 1. Hardcoded fast path
  for (const entry of HARDCODED) {
    if (entry.regex.test(b)) return entry.examples;
  }

  // 2. In-memory cache
  const key = b.toLowerCase();
  if (_cache[key]) return _cache[key];

  // 3. AI generation (async — awaited by the WhatsApp send function)
  const examples   = await generateStockExamplesWithAI(b);
  _cache[key]      = examples;
  return examples;
}

module.exports = { getStockExamples };
