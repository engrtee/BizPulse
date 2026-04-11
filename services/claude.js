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

const MODEL = 'claude-sonnet-4-6';

let claudeClient = null;

function getClient() {
  if (!claudeClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('[Claude] ⚠️ ANTHROPIC_API_KEY not set — Claude features will use fallback messages');
      return null; // Return null instead of throwing — will trigger fallback
    }
    claudeClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return claudeClient;
}

// ────────────────────────────────────────
// Business Coaching Context
// ────────────────────────────────────────
const COACHING_CONTEXT = `
You are a warm, knowledgeable business coach for small business owners around the world.

YOUR ROLE:
Give specific, practical insights based on the owner's actual numbers. You are like a trusted advisor who knows their business — not a generic consultant.

ADAPT TO LOCATION:
- Use the user's state/country to determine the local currency, market conditions, and relevant context
- Nigeria → Naira (₦), "k" = thousands. Common pressures: fuel costs, power, exchange rates
- Ghana → Cedis (GH₵). Common pressures: import costs, mobile money trends
- Kenya → Shillings (KES). Common pressures: M-Pesa, logistics
- UK/Europe → £/€. Common pressures: VAT, overheads, online competition
- US/Canada → $/CAD. Common pressures: platform fees, shipping, margins
- Other regions → infer currency and context from location
- If location is unknown → give universal advice using their actual numbers

LANGUAGE ADAPTATION:
- Nigerian users may write in Pidgin: "made 50k" = local currency equivalent of 50,000
- Match the formality level of the user's question — informal question = informal response
- Always write in plain English. No accounting jargon.

YOUR COACHING STYLE:
1. Lead with ONE specific insight from their actual numbers (never generic)
2. Explain what the number means in plain language — why it matters
3. Compare to what similar businesses in their sector typically see, if you know it
4. Give ONE concrete action they can take this week — specific, doable, tied to their numbers
5. Be warm and direct — like a smart friend who happens to know business
6. Celebrate genuine wins. Name real problems clearly but without panic.
7. Keep it conversational — this is a WhatsApp chat, not a business report

WHAT GOOD LOOKS LIKE:

Good — specific and actionable:
"Your margin is 38%, which is solid for a fashion retailer. Most similar businesses land between 35–45%.
The thing worth watching: your stock costs are 44% of revenue. If supplier prices rise even 10%, that eats directly into your profit.
One move this week — ask your top supplier for a bulk discount on your next order. Even 5% off saves real money over a month."

Good — practical with local context:
"You served 14 customers on a day you made [X revenue]. That's [X per customer] average spend.
If you could get each customer to add one more item — even a small one — that average goes up without needing new customers.
Worth trying: suggest a matching product at checkout this week and see if it changes your numbers."

Bad — never do this:
"Monitor your expenses closely." — too generic, no action
"Your margin looks healthy." — says nothing
"You need to track inventory." — not advice, it's a task

END EVERY RESPONSE with one follow-up question the user can ask to go deeper.
Keep responses under 350 words. Warm, clear, and useful every time.
`;


/**
 * Parse a WhatsApp message using Claude.
 * Returns: { type, data } where type is one of:
 *   - daily_entry, inventory_in, inventory_out, customers, stock_check, question, unknown
 *   - data contains type-specific fields
 */
async function parseWithAI(message, user) {
  const client = getClient();
  if (!client) {
    return { type: 'unknown', data: {}, confidence: 0 };
  }

  const prompt = `${COACHING_CONTEXT}

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
      model: MODEL,
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
    console.error('[Claude] parseWithAI failed:', err.constructor?.name, err.status || '', err.message);
    return { type: 'unknown', data: {}, confidence: 0 };
  }
}

/**
 * Generate a personalized AI recommendation for the daily 7pm summary.
 * Uses full access to user's financial data + market insights.
 * THIS IS WHAT MAKES IT ADDICTIVE.
 */
async function generateRecommendation(summaryData, user) {
  const client = getClient();
  
  // Graceful fallback if API key not set
  if (!client) {
    const profit = summaryData.profit || 0;
    const revenue = summaryData.revenue || 0;
    return {
      risk: profit > 0
        ? `You made ₦${Number(profit).toLocaleString('en-NG')} profit today — keep tracking to protect that margin.`
        : revenue > 0
          ? `You logged ₦${Number(revenue).toLocaleString('en-NG')} revenue but expenses are eating into profit.`
          : 'No revenue logged today — make sure to record tomorrow\'s numbers.',
      actions: [
        'Review your top expense category and see if any costs can be reduced this week.',
        'Follow up with repeat customers to encourage another purchase.',
        'Set a daily revenue target and track it every morning.',
      ],
    };
  }

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

  // Get market insights for context
  let marketInsight = '';
  try {
    const insight = await MarketDataService.getMarketInsight(user.biz_type || 'Business', {
      revenue,
      totalExpenses,
      margin,
    });
    marketInsight = `\n\nMARKET CONTEXT: ${insight.insight}`;
  } catch (e) {
    // Optional
  }

  const fmt = (n) => Number(n).toLocaleString();

  // Analyze if they're underperforming vs their own average
  let performanceAlert = '';
  if (daysTrend && daysTrend.revenue && daysTrend.revenue.length >= 7) {
    const last7 = daysTrend.revenue.slice(-7).map(r => parseFloat(r) || 0);
    const avg7 = last7.reduce((a, b) => a + b, 0) / 7;

    if (revenue < avg7 * 0.8) {
      performanceAlert = `\nNote: Today's revenue is 20% below the 7-day average (${fmt(avg7)}).`;
    } else if (revenue > avg7 * 1.2) {
      performanceAlert = `\nNote: Today's revenue is 20% above the 7-day average (${fmt(avg7)}) — a good day!`;
    }
  }

  const trendContext =
    daysTrend && daysTrend.revenue && daysTrend.revenue.length > 0
      ? `\nLast 7 days revenue trend: ${daysTrend.revenue.slice(-7).join(' → ')}`
      : '';

  const prompt = `${COACHING_CONTEXT}

USER:
- Name: ${user.name.split(' ')[0]}
- Business type: ${user.biz_type || 'Small business'}
- Location: ${user.state || 'unknown'} (use the appropriate local currency for this location)

TODAY'S NUMBERS (${date}):
- Revenue: ${fmt(revenue)}
- Expenses: ${fmt(totalExpenses)}
- Profit: ${fmt(profit)}
- Margin: ${margin}%
${topExpense ? `- Biggest expense: ${topExpense.category} (${fmt(topExpense.amount)})` : ''}
- Customers served: ${customers}
${trendContext}
${performanceAlert}
${marketInsight}

Return ONLY this JSON (no markdown, no explanation):
{
  "risk": "One clear sentence about the main thing to watch in today's numbers — use the actual figures and local currency symbol",
  "actions": [
    "Specific, doable action this week — reference actual numbers with local currency",
    "Specific action 2",
    "Specific action 3"
  ]
}

Rules:
- Use the correct local currency symbol based on user location
- risk and actions must reference real numbers from today — no generic advice
- Warm, clear tone — not alarmist
- Total response under 150 words`;

  try {
    const message_obj = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text  = message_obj.content[0].type === 'text' ? message_obj.content[0].text : '';
    const clean = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[Claude] generateRecommendation failed:', err.constructor?.name, err.status || '', err.message);
    return {
      risk: 'Review your top expense category — it may be squeezing your margin.',
      actions: [
        'Compare this week\'s expenses to last week and find one category to cut.',
        'Reach out to 3 repeat customers today for a follow-up sale.',
        'Set a revenue target for tomorrow before you open for business.',
      ],
    };
  }
}

/**
 * Answer a business question using Claude.
 * Claude has full context of user's financial history + market data.
 * This is where ADDICTIVE INSIGHTS happen.
 */
async function answerBusinessQuestion(question, user, userData) {
  const client = getClient();
  if (!client) {
    return (
      `I need my AI brain to answer this properly, ${user.name.split(' ')[0]}! 🧠\n\n` +
      `It looks like the AI service isn't configured yet. Once it's set up, I can give you specific insights based on your actual numbers.\n\n` +
      `In the meantime, send "summary" to see your latest numbers, or "stock?" to check your inventory.`
    );
  }

  // userData should contain: { history: [...], inventory: [...], avgMetrics: {...} }
  const { history = [], inventory = [], avgMetrics = {} } = userData;

  const recentHistory = history.slice(0, 30).map((d) => ({
    date: d.date,
    revenue: d.revenue,
    expenses: d.total_expenses,
    profit: d.profit,
    margin: d.margin,
  }));

  // GET MARKET INSIGHTS - Real-time context
  let marketInsight = '';
  try {
    const insight = await MarketDataService.getMarketInsight(user.biz_type, {
      revenue: avgMetrics.avgRevenue || 0,
      totalExpenses: avgMetrics.avgExpenses || 0,
      margin: avgMetrics.avgMargin || 0,
    });
    marketInsight = `\nMARKET BENCHMARK FOR ${user.biz_type.toUpperCase()}:\n${insight.insight}`;
  } catch (e) {
    // Market data optional
  }

  // CALCULATE PRODUCT PERFORMANCE METRICS
  let productPerformance = '';
  if (inventory && inventory.length > 0) {
    const totalStockValue = inventory.reduce((sum, i) => sum + (parseFloat(i.current_balance) * (parseFloat(i.unit_price) || 0)), 0);
    const totalEverReceived = inventory.reduce((sum, i) => sum + parseFloat(i.total_received || 0), 0);
    const avgTurnover = totalEverReceived > 0 ? (avgMetrics.avgRevenue / (totalStockValue || 1)) : 0;
    
    productPerformance = `
PRODUCT PERFORMANCE ANALYSIS:
- Total inventory value: ₦${Number(totalStockValue).toLocaleString('en-NG')}
- Avg items per day: ${Math.round(totalEverReceived / 30)}
- Inventory turnover ratio: ${avgTurnover.toFixed(2)}x per day
- Top 5 items: ${inventory.slice(0, 5).map(i => i.item_name).join(', ')}
${inventory.some(i => parseFloat(i.current_balance) === 0) ? '⚠️ WARNING: You have OUT-OF-STOCK items' : ''}
${inventory.some(i => parseFloat(i.current_balance) < (parseFloat(i.total_received) * 0.2)) ? '⚠️ WARNING: Multiple items below 20% threshold' : ''}`;
  }

  // TREND ANALYSIS
  let trendAnalysis = '';
  if (recentHistory.length >= 7) {
    const last7 = recentHistory.slice(-7);
    const prev7 = recentHistory.slice(-14, -7);
    
    const last7Avg = last7.reduce((sum, d) => sum + parseFloat(d.revenue), 0) / 7;
    const prev7Avg = prev7.length > 0 ? prev7.reduce((sum, d) => sum + parseFloat(d.revenue), 0) / 7 : last7Avg;
    
    const trend = ((last7Avg - prev7Avg) / prev7Avg) * 100;
    const trendDirection = trend > 5 ? '📈 UP' : trend < -5 ? '📉 DOWN' : '➡️ FLAT';
    
    trendAnalysis = `\nTREND ANALYSIS (last 14 days):
${trendDirection} Revenue trend: ${Math.abs(trend).toFixed(1)}%
- Last 7 days avg: ₦${Number(last7Avg).toLocaleString('en-NG')}
- Previous 7 days avg: ₦${Number(prev7Avg).toLocaleString('en-NG')}`;
  }

  const fmtN = (n) => Number(n || 0).toLocaleString();

  const prompt = `${COACHING_CONTEXT}

USER:
- Name: ${user.name.split(' ')[0]}
- Business: ${user.biz_type || 'Small business'}
- Location: ${user.state || 'unknown'} — use the correct local currency for this location

FINANCIAL DATA (last 30 days):
${JSON.stringify(recentHistory, null, 2)}

KEY AVERAGES:
- Daily revenue: ${fmtN(avgMetrics.avgRevenue)}
- Daily expenses: ${fmtN(avgMetrics.avgExpenses)}
- Average margin: ${(avgMetrics.avgMargin || 0).toFixed(1)}%
- Best day: ${fmtN(Math.max(0, ...recentHistory.map(d => parseFloat(d.revenue) || 0)))}
- Lowest day: ${fmtN(Math.min(0, ...recentHistory.map(d => parseFloat(d.revenue) || 0)))}

${productPerformance}
${trendAnalysis}
${marketInsight}

THEIR QUESTION: "${question}"

HOW TO ANSWER:
1. Lead with one specific insight from their actual numbers — not generic
2. Explain what the number means in plain language
3. If relevant, compare to what similar businesses typically see
4. Give ONE concrete action for this week — tied to their actual figures
5. Use the correct currency symbol for their location throughout
6. Be warm, direct, and conversational — this is a WhatsApp chat
7. Do not overwhelm with multiple problems at once

Keep under 350 words. End with one follow-up question they can ask to go deeper.`;

  try {
    const message_obj = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    return message_obj.content[0].type === 'text'
      ? message_obj.content[0].text
      : "Keep logging your data — insights get better with more numbers!";
  } catch (err) {
    console.error('[Claude] answerBusinessQuestion failed:', err.constructor?.name, err.status || '', err.message);
    return (
      `Sorry, I hit a snag analyzing your data, ${user.name.split(' ')[0]}. 🔄\n\n` +
      `Try asking again in a moment — or rephrase your question.\n\n` +
      `You can also send "summary" to see your latest numbers right now.`
    );
  }
}

/**
 * Generate a short coaching nudge for users who haven't logged today.
 * Used by the 7pm cron for users with no entries.
 * Returns a 2-3 sentence insight based on their historical averages, or null on failure.
 */
async function generateNudgeInsight(user, avgData) {
  const client = getClient();
  if (!client) return null;

  const { avgRevenue, avgMargin, dayCount } = avgData;

  const prompt = `${COACHING_CONTEXT}

USER: ${user.name.split(' ')[0]}
Business: ${user.biz_type || 'Small business'}
Location: ${user.state || 'unknown'} — use the correct local currency

THEIR RECENT AVERAGES (last ${dayCount} days logged):
- Average daily revenue: ${Number(avgRevenue).toLocaleString()}
- Average margin: ${avgMargin.toFixed(1)}%

Write ONE short coaching insight — 2 to 3 sentences only.
Rules:
- Reference their actual average numbers with local currency
- Give one specific thing worth thinking about or checking today
- Make logging feel worthwhile ("the more you log, the sharper this gets")
- Warm and encouraging, not pushy or guilt-tripping
- Plain sentences only — no emojis, no bullet points, no headers`;

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : null;
  } catch (err) {
    console.error('[Claude] generateNudgeInsight failed:', err.constructor?.name, err.status || '', err.message);
    return null;
  }
}

module.exports = {
  parseWithAI,
  generateRecommendation,
  answerBusinessQuestion,
  generateNudgeInsight,
};
