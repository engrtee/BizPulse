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
// Nigerian Business Context
// ────────────────────────────────────────
const NIGERIA_CONTEXT = `
You are a relentless business coach for Nigerian SME owners. Your job is ADDICTIVE INSIGHTS + REAL-WORLD ACTIONS.

NIGERIAN MARKET CONTEXT:
- Currency: Nigerian Naira (₦). "k" = thousands, "m" = millions
- Common businesses: Fashion/retail, food vendors, restaurants, online selling, beauty, services, manufacturing
- Expense categories: Stock, Rent, Staff Wages, Transport (fuel, logistics), Utilities (power, data), Marketing, Packaging, Equipment
- Market realities: fuel volatility, power outages, exchange rate shifts, seasonal patterns, customer retention pressure
- Language: Informal Nigerian English, Pidgin, mixed languages
  Examples: "made 50k" = ₦50k revenue, "gave transport 3k" = ₦3k on logistics, "sold am for 5k" = sold for ₦5k

YOUR COACHING APPROACH - MAKE IT ADDICTIVE:
1. ALWAYS lead with a SPECIFIC INSIGHT from their numbers (not generic praise)
2. ALWAYS compare to Nigerian industry benchmarks for their business type
3. ALWAYS identify ONE hidden problem nobody talks about
4. ALWAYS suggest ONE concrete action that INCREASES PROFIT or SAVES TIME
5. ALWAYS include market context (exchange rates, seasonal trends, competitor moves)
6. Use confidence + urgency - they should feel they're leaving money on the table
7. Be warm but DIRECT - no sugar-coating, no management speak

EXAMPLES OF ADDICTIVE INSIGHTS:

GOOD (addictive + actionable):
"Your margin of 32% tells me you're buying at retail prices, not wholesale.
Top fashion traders in Lekos/Onitsha average 42% because they buy 50+ units per supplier.
Next Monday, call your 3 suppliers — quote ₦4,200/unit on a 50-unit order (vs your current ₦4,500).
That ONE move = 38% margin. You'll feel that extra ₦300 × 50 = ₦15k per order."

GOOD (product performance):
"Your customers average 7 per day but your stock turns only twice/month.
That means you're holding ₦150k in inventory that moves slow.
Fashion = speed. Fast-movers (daily sales items) should be 60% of stock, niche items 40%.
This week: restock only your top 5 best-sellers. Drop the slow-movers. Free up ₦30k for faster inventory."

GOOD (market insight):
"Fuel price just hit ₦1,000/liter. Your transport costs will spike 15-20% next week.
Smart traders raise prices 5-7% today, BEFORE the market panic.
Raise your average item by ₦200-500 this week. You'll be cheap compared to next week's market."

BAD (generic - never ever do this):
"Keep monitoring your expenses." — NO ACTION, NO INSIGHT
"Your margin is healthy." — No urgency, not addictive
"Track inventory closely." — Every coach says this
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
 * Uses full access to user's financial data + market insights.
 * THIS IS WHAT MAKES IT ADDICTIVE.
 */
async function generateRecommendation(summaryData, user) {
  const client = getClient();
  
  // Graceful fallback if API key not set
  if (!client) {
    const revenue = summaryData.revenue || 0;
    const profit = summaryData.profit || 0;
    const margin = summaryData.margin || 0;
    if (profit > 0) {
      return `✅ You made ₦${Number(profit).toLocaleString('en-NG')} profit today! Keep tracking — you're building valuable data about your business.`;
    } else if (revenue > 0) {
      return `📊 You logged ₦${Number(revenue).toLocaleString('en-NG')} in revenue today. Even on low-profit days, the data matters. Keep showing up.`;
    } else {
      return 'Keep logging your numbers. Every entry builds your business picture. 📈';
    }
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

  // Analyze if they're underperforming vs their own average (hidden problem)
  let performanceAlert = '';
  if (daysTrend && daysTrend.revenue && daysTrend.revenue.length >= 7) {
    const last7 = daysTrend.revenue.slice(-7).map(r => parseFloat(r) || 0);
    const avg7 = last7.reduce((a, b) => a + b, 0) / 7;
    
    if (revenue < avg7 * 0.8) {
      performanceAlert = `\n⚠️ ALERT: Today (₦${Number(revenue).toLocaleString('en-NG')}) is 20% below your 7-day average (₦${Number(avg7).toLocaleString('en-NG')}). What's different?`;
    } else if (revenue > avg7 * 1.2) {
      performanceAlert = `\n✨ WIN: Today (₦${Number(revenue).toLocaleString('en-NG')}) is 20% ABOVE your 7-day average! What did you do differently?`;
    }
  }

  const trendContext =
    daysTrend && daysTrend.revenue && daysTrend.revenue.length > 0
      ? `\nLast 7 days: Revenue ${daysTrend.revenue.slice(-7).join(' → ')} ₦`
      : '';

  const prompt = `${NIGERIA_CONTEXT}

TODAY'S PERFORMANCE (${date}):
- Revenue: ₦${Number(revenue).toLocaleString('en-NG')}
- Expenses: ₦${Number(totalExpenses).toLocaleString('en-NG')}
- Profit: ₦${Number(profit).toLocaleString('en-NG')}
- Margin: ${margin}%
${topExpense ? `- Biggest cost: ${topExpense.category} (₦${Number(topExpense.amount).toLocaleString('en-NG')})` : ''}
- Customers: ${customers}
${trendContext}
${performanceAlert}
${marketInsight}

Generate ONE PARAGRAPH of addictive business insight that:
1. Opens with specific observation about TODAY (not generic praise/warning)
2. Identifies ONE hidden problem or opportunity in their numbers TODAY
3. Gives ONE concrete action they can do TOMORROW to increase profit
4. References their specific ₦ amounts and percentages
5. References Nigerian market context if relevant
6. Uses plain language - no jargon
7. Be DIRECT but warm - make them feel they might be leaving money on the table

Keep under 150 words. Make it memorable + actionable. This is their daily business coach speaking.`;

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
 * Claude has full context of user's financial history + market data.
 * This is where ADDICTIVE INSIGHTS happen.
 */
async function answerBusinessQuestion(question, user, userData) {
  const client = getClient();

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

  const prompt = `${NIGERIA_CONTEXT}

USER CONTEXT:
Name: ${user.name}
Business: ${user.biz_type}
Location: ${user.state || 'Nigeria'}

FINANCIAL DATA (last 30 days):
${JSON.stringify(recentHistory, null, 2)}

KEY METRICS:
- Daily revenue: ₦${Number(avgMetrics.avgRevenue || 0).toLocaleString('en-NG')}
- Daily expenses: ₦${Number(avgMetrics.avgExpenses || 0).toLocaleString('en-NG')}
- Average margin: ${(avgMetrics.avgMargin || 0).toFixed(1)}%
- Highest revenue day: ₦${Math.max(...recentHistory.map(d => parseFloat(d.revenue) || 0)).toLocaleString('en-NG')}
- Lowest revenue day: ₦${Math.min(...recentHistory.map(d => parseFloat(d.revenue) || 0)).toLocaleString('en-NG')}

${productPerformance}
${trendAnalysis}
${marketInsight}

USER'S QUESTION: "${question}"

NOW GIVE ADDICTIVE, ACTIONABLE COACHING:
1. Lead with ONE specific insight from their data (not generic)
2. If comparing to market: show the gap and how to close it
3. If product performance issue: identify the hidden problem (slow movers, overstock, etc.)
4. If trend issue: explain WHY and what to do NOW
5. Give ONE concrete action they can do TODAY or THIS WEEK that affects profit
6. Reference actual ₦ amounts and percentage changes
7. Be DIRECT but warm - use "you're" not "users"

Keep under 250 words. Make it addictive enough they WANT more insights.`;

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

    return message_obj.content[0].type === 'text'
      ? message_obj.content[0].text
      : "Keep logging your data — insights get better with more numbers!";
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
