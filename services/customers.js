/**
 * services/customers.js
 * Handles standalone customer count messages and appends to Google Sheets.
 *
 * Standalone customer messages ("customers 15") are logged separately.
 * Customer counts bundled inside daily_entry messages are handled by the
 * transaction service directly.
 *
 * PHASE 2: debtor tracking extends here
 *   (named customers, purchase history, outstanding balances)
 */

'use strict';

const { query }      = require('../models/db');
const SheetsService  = require('./sheets');
const { todayWAT }   = require('../utils/formatter');

/**
 * Log a standalone customer count for today.
 *
 * @param {object} user   Full user record
 * @param {number} count  Number of customers served
 * @param {string} notes  Optional notes (e.g. "new customer Mama Ngozi")
 */
async function logCustomers(user, count, notes = '') {
  const date = todayWAT();

  // Upsert today's customer count row
  await query(
    `INSERT INTO customer_logs (user_id, date, count, notes)
     VALUES ($1, $2, $3, $4)`,
    [user.id, date, count, notes]
  );

  // Append to Google Sheets if connected
  if (user.sheet_id) {
    await SheetsService.appendCustomers(user, { date, count, notes })
      .catch((err) => console.error('[Sheets] appendCustomers error:', err.message));
  }

  return { date, count, notes };
}

/**
 * Get the total customer count for a given date from the DB.
 */
async function getDayCount(userId, date) {
  const res = await query(
    `SELECT COALESCE(SUM(count), 0) AS total
     FROM customer_logs
     WHERE user_id = $1 AND date = $2`,
    [userId, date]
  );
  return parseInt(res.rows[0].total, 10) || 0;
}

module.exports = { logCustomers, getDayCount };
