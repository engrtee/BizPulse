/**
 * services/claude.js
 * Claude AI wrapper for BizPulse.
 *
 * Responsibilities:
 *   1. generateRecommendation(summaryData, user) → AI coaching JSON for 7pm email
 *   2. generateNudgeInsight(user, avgData)       → short coaching tip for inactive users
 *
 * generateRecommendation uses claude-sonnet-4-6 with COACHING_CONTEXT cached as system prompt.
 * generateNudgeInsight uses claude-haiku-4-5-20251001 (cheaper — 2-3 sentence output only).
 */

'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const MarketDataService = require('./marketData');

const MODEL       = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

let claudeClient = null;

function getClient() {
  if (!claudeClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('[Claude] ⚠️ ANTHROPIC_API_KEY not set — Claude features will use fallback messages');
      return null;
    }
    claudeClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return claudeClient;
}

// ── Coaching system prompt — cached as system block on every call ─────────
// cache_control is applied at the call site so the Anthropic SDK sends it
// as an ephemeral cache point, cutting input token cost for the daily batch.
const COACHING_CONTEXT = `You are a warm, knowledgeable business coach for small business owners around the world.

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

WHAT GOOD LOOKS LIKE:
Good — specific and actionable:
"Your margin is 38%, which is solid for a fashion retailer. Most similar businesses land between 35–45%. The thing worth watching: your stock costs are 44% of revenue. If supplier prices rise even 10%, that eats directly into your profit. One move this week — ask your top supplier for a bulk discount on your next order. Even 5% off saves real money over a month."

Bad — never do this:
"Monitor your expenses closely." — too generic, no action`;

/**
 * Generate a personalized AI recommendation for the daily 7pm summary.
 * Uses COACHING_CONTEXT as a cached system prompt to save input tokens
 * across the nightly batch (all users processed sequentially, cache window = 5 min).
 */
async function generateRecommendation(summaryData, user) {
  const client = getClient();

  // Graceful fallback if API key not set
  if (!client) {
    const profit  = summaryData.profit  || 0;
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
    topExpense,
    customers,
    date,
    daysTrend,
  } = summaryData;

  // Get market insights for context (local computation, not an LLM call)
  let marketInsight = '';
  try {
    const insight = await MarketDataService.getMarketInsight(user.biz_type || 'Business', {
      revenue,
      totalExpenses,
      margin,
    });
    marketInsight = `\n\nMARKET CONTEXT: ${insight.insight}`;
  } catch (e) {
    // optional
  }

  const fmt = (n) => Number(n).toLocaleString();

  let performanceAlert = '';
  if (daysTrend && daysTrend.revenue && daysTrend.revenue.length >= 7) {
    const last7 = daysTrend.revenue.slice(-7).map(r => parseFloat(r) || 0);
    const avg7  = last7.reduce((a, b) => a + b, 0) / 7;
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

  const userPrompt = `USER:
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
      model:      MODEL,
      max_tokens: 400,
      system: [
        {
          type:          'text',
          text:          COACHING_CONTEXT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
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
 * Generate a short coaching nudge for users who haven't logged today.
 * Used by the 7pm cron for users with no entries.
 * Uses Haiku (cheaper model) — output is 2-3 sentences only.
 * Returns a string insight, or null on failure.
 */
async function generateNudgeInsight(user, avgData) {
  const client = getClient();
  if (!client) return null;

  const { avgRevenue, avgMargin, dayCount } = avgData;

  const userPrompt = `USER: ${user.name.split(' ')[0]}
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
      model:      HAIKU_MODEL,
      max_tokens: 150,
      system: [
        {
          type:          'text',
          text:          COACHING_CONTEXT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
    });
    return msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : null;
  } catch (err) {
    console.error('[Claude] generateNudgeInsight failed:', err.constructor?.name, err.status || '', err.message);
    return null;
  }
}

module.exports = {
  generateRecommendation,
  generateNudgeInsight,
};
