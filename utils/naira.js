/**
 * utils/naira.js
 * Currency helpers for Nigerian Naira.
 *
 * Handles the "k" shorthand that Nigerian SME owners use naturally:
 * "30k" → 30000, "1.5k" → 1500
 */

'use strict';

/**
 * Format a number as Nigerian Naira with thousands separator.
 * e.g. 45000 → "₦45,000"
 *      1234567.5 → "₦1,234,567.50"
 */
function formatNaira(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '₦0';
  const num = parseFloat(amount);
  if (Number.isInteger(num)) {
    return '₦' + num.toLocaleString('en-NG');
  }
  return '₦' + num.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Parse a Nigerian-style amount string into a number.
 * Handles:
 *   "30k"    → 30000
 *   "30,000" → 30000
 *   "1.5k"   → 1500
 *   "45000"  → 45000
 *   "₦30k"   → 30000
 */
function parseAmount(str) {
  if (!str) return 0;
  // Strip ₦, spaces, commas
  let clean = String(str).replace(/[₦,\s]/g, '').toLowerCase().trim();
  if (clean.endsWith('k')) {
    return parseFloat(clean.slice(0, -1)) * 1000;
  }
  return parseFloat(clean) || 0;
}

/**
 * Calculate margin percentage safely (avoids division by zero).
 * Returns 0 when revenue is 0.
 */
function calcMargin(profit, revenue) {
  if (!revenue || revenue === 0) return 0;
  return parseFloat(((profit / revenue) * 100).toFixed(2));
}

module.exports = { formatNaira, parseAmount, calcMargin };
