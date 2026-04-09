/**
 * services/marketData.js
 * Fetches real-time market data for Nigerian context.
 *
 * Provides:
 * - Current Naira exchange rates
 * - Market benchmarks by business type
 * - Industry trends and insights
 */

'use strict';

require('dotenv').config();
const axios = require('axios');

// Cache market data for 6 hours to avoid excessive API calls
const dataCache = {
  exchangeRate: { data: null, timestamp: 0 },
  benchmarks: { data: null, timestamp: 0 },
};

const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Get current Naira to USD exchange rate from an API.
 * Falls back to recent approximate values if API fails.
 */
async function getExchangeRate() {
  const now = Date.now();

  // Return cached if still fresh
  if (dataCache.exchangeRate.data && now - dataCache.exchangeRate.timestamp < CACHE_DURATION) {
    return dataCache.exchangeRate.data;
  }

  try {
    // Try exchangerate-api.com (free tier available)
    const res = await axios.get('https://api.exchangerate-api.com/v4/latest/NGN', {
      timeout: 5000,
    });

    const usdRate = res.data.rates?.USD || 1648; // Fallback to approximate
    dataCache.exchangeRate = {
      data: { nairaToUSD: usdRate, timestamp: now },
      timestamp: now,
    };

    return dataCache.exchangeRate.data;
  } catch (err) {
    console.warn('[MarketData] Exchange rate fetch failed, using approximate:', err.message);
    // Return approximate recent rate
    return { nairaToUSD: 1600, timestamp: now, approximated: true };
  }
}

/**
 * Get industry benchmarks for Nigerian SMEs.
 * Returns average profit margins + expense ratios by business type.
 */
async function getBenchmarks() {
  const now = Date.now();

  // Return cached if still fresh
  if (dataCache.benchmarks.data && now - dataCache.benchmarks.timestamp < CACHE_DURATION) {
    return dataCache.benchmarks.data;
  }

  // Hardcoded Nigerian SME benchmarks based on typical market ranges
  // (In production, this could fetch from an external database)
  const benchmarks = {
    fashion_retail: {
      avgMargin: 40,
      avgExpenseRatio: 60,
      topExpenses: ['stock', 'rent', 'transport'],
      description: 'Fashion retail/clothing traders',
    },
    food_restaurant: {
      avgMargin: 35,
      avgExpenseRatio: 65,
      topExpenses: ['stock', 'gas/utilities', 'labor'],
      description: 'Food vendors/restaurants/bukas',
    },
    online_business: {
      avgMargin: 45,
      avgExpenseRatio: 55,
      topExpenses: ['stock', 'shipping/logistics', 'marketing'],
      description: 'Online sellers/e-commerce',
    },
    services: {
      avgMargin: 50,
      avgExpenseRatio: 50,
      topExpenses: ['transport', 'equipment', 'marketing'],
      description: 'Service providers/consulting',
    },
    retail: {
      avgMargin: 35,
      avgExpenseRatio: 65,
      topExpenses: ['stock', 'rent', 'utilities'],
      description: 'Retail/FMCG stores',
    },
    default: {
      avgMargin: 38,
      avgExpenseRatio: 62,
      topExpenses: ['stock', 'rent', 'transport'],
      description: 'General SME',
    },
  };

  dataCache.benchmarks = {
    data: benchmarks,
    timestamp: now,
  };

  return benchmarks;
}

/**
 * Get tailored benchmark for a specific business type.
 */
async function getBenchmarkForBusiness(businessType) {
  const benchmarks = await getBenchmarks();
  const normalized = (businessType || '').toLowerCase().replace(/\s+/g, '_');

  return benchmarks[normalized] || benchmarks.default;
}

/**
 * Get actionable market insight.
 * Returns context-specific advice based on business type.
 */
async function getMarketInsight(businessType, currentMetrics) {
  const benchmark = await getBenchmarkForBusiness(businessType);
  const exchangeRate = await getExchangeRate();

  // Compare user's metrics to benchmark
  const marginDiff = (currentMetrics.margin || 0) - benchmark.avgMargin;
  const expenseRatioDiff = ((currentMetrics.totalExpenses / currentMetrics.revenue) * 100 || 0) - benchmark.avgExpenseRatio;

  let insight = '';

  if (marginDiff < -5) {
    insight = `Your ${currentMetrics.margin}% margin is ${Math.abs(marginDiff).toFixed(1)}% below market average (${benchmark.avgMargin}%) for ${benchmark.description}. Focus on negotiating input costs or increasing prices slightly.`;
  } else if (marginDiff > 5) {
    insight = `Excellent! Your ${currentMetrics.margin}% margin is ${marginDiff.toFixed(1)}% above market average for your sector. Consider reinvesting profits into growth.`;
  } else {
    insight = `Your margin of ${currentMetrics.margin}% is competitive for ${benchmark.description}.`;
  }

  return {
    insight,
    benchmark,
    exchangeRate,
    comparison: {
      yourMargin: currentMetrics.margin,
      benchmarkMargin: benchmark.avgMargin,
      difference: marginDiff,
    },
  };
}

module.exports = {
  getExchangeRate,
  getBenchmarks,
  getBenchmarkForBusiness,
  getMarketInsight,
};
