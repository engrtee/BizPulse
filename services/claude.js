/**
 * services/claude.js
 * Claude AI wrapper for BizPulse.
 *
 * Responsibilities:
 *   1. parseWithAI(message, user) → structured JSON from WhatsApp text
 *   2. generateRecommendation(summaryData, user) → AI coaching based on data
 *   3. answerBusinessQuestion(question, user, userData) → personalized business advice
 *
 * Uses full access to user's financial data for context-aware insights.
 */

'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const MarketDataService = require('./marketData');

let claudeClient = null;

function getClient() {
  if (!claudeClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set in .env');
    }
    claudeClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return claudeClient;
}

// ────────────────────────────────────────
// Nigerian Business Context
// ────────────────────────────────────────
const NIGERIA_CONTEXT = `
You are a business coach for Nigerian SME owners. You have deep expertise in:

NIGERIAN MARKET CONTEXT:
- Currency: Nigerian Naira (₦). "k" = thousands, "m" = millions
- Common businesses: Fashion/retail, food vendors, restaurants, online selling, beauty, services, manufacturing
- Expense categories: Stock, Rent, Staff Wages, Transport (fuel, logistics), Utilities (power, data), Marketing, Packaging, Equipment
- Market realities: fuel volatility, power outages, exchange rate shifts, seasonal patterns, customer retention pressure
- Language: Informal Nigerian English, Pidgin, mixed languages
  Examples: "made 50k" = ₦50k revenue, "gave transport 3k" = ₦3k on logistics, "sold am for 5k" = sold for ₦5k

YOUR APPROACH:
1. Always reference actual numbers from user's data (never generic)
2. Give specific, actionable advice for Nigerian context
3. Use plain English - NO jargon
4. Be warm, encouraging, personal
5. Challenge users to think bigger, but realistically
6. Ground advice in market research + their specific numbers

EXAMPLE (GOOD):
"Your margin of 32% is healthy, but for fashion retail in this environment, you're leaving money.
Top traders average 40-45% because they negotiate bulk discounts. You paid ₦4,500/item on average last week.
Try negotiating with your supplier for ₦4,200 on next order of 50+ units — that alone gets you to 38% margin."

EXAMPLE (BAD - never do this):
"Monitor inventory closely to protect margins." (Generic, not actionable)
`;

/**
 * Parse a WhatsApp message using Claude.
 * Returns: { type, data } where type is one of:
 *   - daily_entry, inventory_in, inventory_out, customers, stock_check, question, unknown
 *   - data contains type-specific fields
 */
async function parseWithAI(message, user) {
  const client = getClient();

  const prompt = `${NIGERIA_CONTEXT}

User: ${user.name}
Business type: ${user.biz_type || 'unknown'}
Message: "${message}"

Parse this message and return JSON with:
{
  "type": "daily_entry|inventory_in|inventory_out|customers|stock_check|question|unknown",
  "data": {
    // Type-specific fields:
    // For daily_entry: { revenue, totalExpenses, expenseBreakdown: {category: amount}, customers }
    // For inventory_in: { item, quantity, unitPrice }
    // For inventory_out: { item, quantity }
    // For customers: { count }
    // For question: { question_text }
    // For stock_check: {}
  },
  "confidence": 0.0-1.0
}

STRICT RULES:
- Parse "k" as thousands: "30k" = 30000
- Extract ALL expense amounts and categorize them
- Return ONLY valid JSON, no other text`;

  try {
    const message_obj = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const responseText = message_obj.content[0].type === 'text' ? message_obj.content[0].text : '';
    const parsed = JSON.parse(responseText);

    return {
      type: parsed.type || 'unknown',
      data: parsed.data || {},
      confidence: parsed.confidence || 0,
    };
  } catch (err) {
    console.error('[Claude] parseWithAI failed:', err.message);
    return { type: 'unknown', data: {}, confidence: 0 };
  }
}

/**
 * Generate a personalized AI recommendation for the daily 7pm summary.
 * Uses full access to user's financial data.
 */
async function generateRecommendation(summaryData, user) {
  const client = getClient();

  const {
    revenue,
    totalExpenses,
    profit,
    margin,
    healthScore,
    topExpense,
    customers,
    date,
    daysTrend, // { revenue: [...], margin: [...], profit: [...] }
  } = summaryData;

  const trendContext =
    daysTrend && daysTrend.revenue && daysTrend.revenue.length > 0
      ? `\nTrends (last 7 days):
- Revenue: ${daysTrend.revenue.join(', ')}
- Margin: ${daysTrend.margin.join(', ')}%
- Profit: ${daysTrend.profit.join(', ')}`
      : '';

  const prompt = `${NIGERIA_CONTEXT}

USER DATA:
Name: ${user.name}
Business: ${user.biz_type}
Today (${date}):
- Revenue: ₦${Number(revenue).toLocaleString('en-NG')}
- Expenses: ₦${Number(totalExpenses).toLocaleString('en-NG')}
- Profit: ₦${Number(profit).toLocaleString('en-NG')}
- Margin: ${margin}%
- Top expense: ${topExpense ? topExpense.category : 'N/A'}
- Customers: ${customers}
${trendContext}

Generate ONE PARAGRAPH of personalized business coaching that:
1. Opens with specific observation about TODAY (reference actual numbers)
2. Gives ONE concrete action they can take tomorrow or this week
3. Relates to their business type and Nigerian market
4. Is encouraging but honest
5. Uses plain language - no jargon

Keep it under 150 words. Be personal, not generic.`;

  try {
    const message_obj = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    return message_obj.content[0].type === 'text' ? message_obj.content[0].text : 'Keep logging to see patterns!';
  } catch (err) {
    console.error('[Claude] generateRecommendation failed:', err.message);
    return 'Your numbers today show you\'re tracking well. Keep the momentum!';
  }
}

/**
 * Answer a business question using Claude.
 * Claude has full context of user's financial history.
 */
async function answerBusinessQuestion(question, user, userData) {
  const client = getClient();

  // userData should contain: { history: [...], inventory: [...], customers: [...], etc }
  const { history = [], inventory = [], avgMetrics = {} } = userData;

  const recentHistory = history.slice(0, 30).map((d) => ({
    date: d.date,
    revenue: d.revenue,
    expenses: d.total_expenses,
    profit: d.profit,
    margin: d.margin,
  }));

  const prompt = `${NIGERIA_CONTEXT}

USER CONTEXT:
Name: ${user.name}
Business: ${user.biz_type}
Location: ${user.state || 'Nigeria'}

FINANCIAL HISTORY (last 30 days):
${JSON.stringify(recentHistory, null, 2)}

AVERAGES:
- Daily revenue: ₦${Number(avgMetrics.avgRevenue || 0).toLocaleString('en-NG')}
- Daily expenses: ₦${Number(avgMetrics.avgExpenses || 0).toLocaleString('en-NG')}
- Average margin: ${(avgMetrics.avgMargin || 0).toFixed(1)}%
${inventory && inventory.length > 0 ? `\nINVENTORY:\n${JSON.stringify(inventory.slice(0, 5), null, 2)}` : ''}

QUESTION FROM USER: "${question}"

Respond with personalized, specific business advice that:
1. References their actual numbers + data trends
2. Acknowledges Nigerian market realities
3. Gives 1-2 concrete action steps
4. Is in plain language (no jargon)
5. Is warm and encouraging

Keep under 200 words.`;

  try {
    const message_obj = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    return message_obj.content[0].type === 'text'
      ? message_obj.content[0].text
      : "I don't have enough data yet to give you specific advice. Keep logging your numbers!";
  } catch (err) {
    console.error('[Claude] answerBusinessQuestion failed:', err.message);
    return "I'm having trouble right now. Try again in a moment!";
  }
}

module.exports = {
  parseWithAI,
  generateRecommendation,
  answerBusinessQuestion,
};
