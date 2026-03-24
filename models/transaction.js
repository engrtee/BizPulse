/**
 * models/transaction.js
 * All PostgreSQL queries for daily transaction entries.
 */

'use strict';

const { query } = require('./db');

const TransactionModel = {
  /** Insert a daily entry (revenue + expenses) */
  async create({ userId, revenue, totalExpenses, expenseBreakdown, profit, margin, customers, notes, rawMessage }) {
    const res = await query(
      `INSERT INTO transactions
         (user_id, revenue, total_expenses, expense_breakdown, profit, margin, customers, notes, raw_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        userId,
        revenue || 0,
        totalExpenses || 0,
        JSON.stringify(expenseBreakdown || {}),
        profit || 0,
        margin || 0,
        customers || 0,
        notes || null,
        rawMessage || null,
      ]
    );
    return res.rows[0];
  },

  /** Get today's entry for a user (to show in WhatsApp reply) */
  async getTodayEntry(userId) {
    const res = await query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND date = CURRENT_DATE
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    return res.rows[0] || null;
  },

  /** Get the most recent DATE that has entries, then return that day's aggregated totals */
  async getLatest(userId) {
    const res = await query(
      `SELECT
         date,
         COALESCE(SUM(revenue), 0)        AS revenue,
         COALESCE(SUM(total_expenses), 0) AS total_expenses,
         COALESCE(SUM(profit), 0)         AS profit,
         COALESCE(SUM(customers), 0)      AS customers,
         COALESCE(AVG(margin), 0)         AS margin
       FROM transactions
       WHERE user_id = $1
       GROUP BY date
       ORDER BY date DESC
       LIMIT 1`,
      [userId]
    );
    return res.rows[0] || null;
  },

  /** Get last N days of aggregated daily totals for the Entry History list */
  async getHistory(userId, limit = 10) {
    const res = await query(
      `SELECT
         date,
         COALESCE(SUM(revenue), 0)        AS revenue,
         COALESCE(SUM(total_expenses), 0) AS total_expenses,
         COALESCE(SUM(profit), 0)         AS profit,
         COALESCE(SUM(customers), 0)      AS customers,
         COALESCE(AVG(margin), 0)         AS margin
       FROM transactions
       WHERE user_id = $1
       GROUP BY date
       ORDER BY date DESC
       LIMIT $2`,
      [userId, limit]
    );
    return res.rows;
  },

  /** Get merged expense breakdown for a date (all entries combined) */
  async getDailyExpenseBreakdown(userId, date) {
    const rows = await query(
      `SELECT expense_breakdown FROM transactions
       WHERE user_id = $1 AND date = $2`,
      [userId, date]
    );
    const merged = {};
    for (const r of rows.rows) {
      const b = r.expense_breakdown || {};
      for (const [cat, amt] of Object.entries(b)) {
        merged[cat] = (merged[cat] || 0) + parseFloat(amt || 0);
      }
    }
    return merged;
  },

  /** Accumulate totals for a given date (for the cron job) */
  async getDailyTotals(userId, date) {
    const res = await query(
      `SELECT
         COALESCE(SUM(revenue), 0)        AS revenue,
         COALESCE(SUM(total_expenses), 0) AS total_expenses,
         COALESCE(SUM(profit), 0)         AS profit,
         COALESCE(SUM(customers), 0)      AS customers
       FROM transactions
       WHERE user_id = $1 AND date = $2`,
      [userId, date]
    );
    return res.rows[0];
  },

  /** Pull all expense_breakdown JSONs for a date so cron can find top category */
  async getExpenseBreakdowns(userId, date) {
    const res = await query(
      `SELECT expense_breakdown FROM transactions
       WHERE user_id = $1 AND date = $2`,
      [userId, date]
    );
    return res.rows.map((r) => r.expense_breakdown);
  },
};

module.exports = TransactionModel;
