/**
 * utils/formatter.js
 * Date helpers, health score labels, and general formatting utilities.
 */

'use strict';

/**
 * Return a Nigerian date string: "Wednesday, 21 March 2026"
 */
function formatDate(date = new Date()) {
  return new Date(date).toLocaleDateString('en-NG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
}

/**
 * Return today's date in YYYY-MM-DD (WAT timezone)
 */
function todayWAT() {
  return new Date()
    .toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // en-CA gives YYYY-MM-DD
}

/**
 * Calculate a simple health score (0–100) from margin.
 * Used in the email and frontend summary.
 *
 * Score bands:
 *   >= 30%  → 80–100  Excellent
 *   >= 15%  → 60–79   Good
 *   >= 5%   → 40–59   Fair
 *   < 5%    → 0–39    Needs Attention
 *
 * PHASE 2: business health score extends here
 *   (add cash flow velocity, stock turnover, customer retention rate)
 */
function calcHealthScore(margin) {
  const m = parseFloat(margin) || 0;
  if (m >= 30) return Math.min(100, 80 + Math.round((m - 30) * 0.67));
  if (m >= 15) return 60 + Math.round((m - 15) * 1.33);
  if (m >= 5)  return 40 + Math.round((m - 5) * 2);
  if (m >= 0)  return Math.max(0, Math.round(m * 8));
  return 0; // negative margin
}

/**
 * Return a label + emoji + CSS colour key for the health score.
 */
function healthLabel(score) {
  if (score >= 80) return { label: 'Excellent',       emoji: '🟢', key: 'excellent' };
  if (score >= 60) return { label: 'Good',            emoji: '🟡', key: 'good' };
  if (score >= 40) return { label: 'Fair',            emoji: '🟠', key: 'fair' };
  return              { label: 'Needs Attention',  emoji: '🔴', key: 'needs-attention' };
}

/**
 * Find the top expense category from an array of expense_breakdown objects.
 * Returns { category, amount } or null.
 */
function topExpenseCategory(breakdowns) {
  const totals = {};
  for (const b of breakdowns) {
    if (!b || typeof b !== 'object') continue;
    for (const [cat, amt] of Object.entries(b)) {
      totals[cat] = (totals[cat] || 0) + parseFloat(amt || 0);
    }
  }
  let top = null;
  for (const [cat, amt] of Object.entries(totals)) {
    if (!top || amt > top.amount) top = { category: cat, amount: amt };
  }
  return top;
}

/**
 * Return a time-of-day greeting appropriate for WAT.
 */
function greeting(firstName) {
  const hour = new Date().toLocaleString('en-NG', {
    hour: 'numeric',
    hour12: false,
    timeZone: 'Africa/Lagos',
  });
  const h = parseInt(hour, 10);
  if (h < 12) return `Good morning ${firstName}`;
  if (h < 17) return `Good afternoon ${firstName}`;
  return `Good evening ${firstName}`;
}

module.exports = { formatDate, todayWAT, calcHealthScore, healthLabel, topExpenseCategory, greeting };
