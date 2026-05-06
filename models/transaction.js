/**
 * models/transaction.js
 * All PostgreSQL queries for daily transaction entries.
 */

'use strict';

const { query } = require('./db');

const TransactionModel = {
  /** Insert a daily entry (revenue + expenses). Pass entryDate (YYYY-MM-DD) to backdate. */
  async create({ userId, revenue, totalExpenses, expenseBreakdown, profit, margin, customers, notes, rawMessage, entryMethod, entryDate }) {
    const params = [
      userId,
      revenue || 0,
      totalExpenses || 0,
      JSON.stringify(expenseBreakdown || {}),
      profit || 0,
      margin || 0,
      customers || 0,
      notes || null,
      rawMessage || null,
      entryMethod || 'text',
    ];
    let dateClause = `(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE`;
    if (entryDate) {
      params.push(entryDate);
      dateClause = `$${params.length}::DATE`;
    }
    const res = await query(
      `INSERT INTO transactions
         (user_id, date, revenue, total_expenses, expense_breakdown, profit, margin, customers, notes, raw_message, entry_method)
       VALUES ($1, ${dateClause}, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      params
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
         CASE WHEN SUM(revenue) > 0
           THEN ROUND((SUM(profit) / SUM(revenue)) * 100, 2)
           ELSE 0
         END                              AS margin
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
         CASE WHEN SUM(revenue) > 0
           THEN ROUND((SUM(profit) / SUM(revenue)) * 100, 2)
           ELSE 0
         END                              AS margin
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
  /** % of last N days that have expense breakdown data */
  async getCompleteness(userId, limit = 10) {
    const res = await query(
      `SELECT
         COUNT(*)                                              AS total_days,
         COUNT(CASE WHEN has_expenses THEN 1 END)             AS days_with_expenses
       FROM (
         SELECT date,
           BOOL_OR(total_expenses > 0) AS has_expenses
         FROM transactions
         WHERE user_id = $1
         GROUP BY date
         ORDER BY date DESC
         LIMIT $2
       ) sub`,
      [userId, limit]
    );
    const r       = res.rows[0];
    const total   = parseInt(r.total_days, 10)         || 0;
    const withExp = parseInt(r.days_with_expenses, 10) || 0;
    return {
      totalDays:        total,
      daysWithExpenses: withExp,
      percentage:       total > 0 ? Math.round((withExp / total) * 100) : 0,
    };
  },

  /** Raw (unaggregated) entries for a user — used in admin detail view and entry correction */
  async getRawByUser(userId, limit = 30) {
    const res = await query(
      `SELECT id, date, revenue, total_expenses, profit, margin, customers,
              notes, raw_message, entry_method, created_at
       FROM transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return res.rows;
  },

  /** Correct a single entry (admin manual override) */
  async correct(entryId, { revenue, totalExpenses, notes }) {
    const rev    = parseFloat(revenue)      || 0;
    const exp    = parseFloat(totalExpenses) || 0;
    const profit = rev - exp;
    const margin = rev > 0 ? parseFloat(((profit / rev) * 100).toFixed(2)) : 0;
    const res = await query(
      `UPDATE transactions
       SET revenue = $1, total_expenses = $2, profit = $3, margin = $4, notes = $5
       WHERE id = $6
       RETURNING id, revenue, total_expenses, profit, margin`,
      [rev, exp, profit, margin, notes || null, entryId]
    );
    return res.rows[0];
  },

  /** Revenue / expenses / profit for this month vs last month */
  async getMonthlyTotals(userId) {
    const res = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN date >= date_trunc('month', CURRENT_DATE)
                           THEN revenue ELSE 0 END), 0)        AS this_revenue,
         COALESCE(SUM(CASE WHEN date >= date_trunc('month', CURRENT_DATE)
                           THEN total_expenses ELSE 0 END), 0) AS this_expenses,
         COALESCE(SUM(CASE WHEN date >= date_trunc('month', CURRENT_DATE)
                           THEN profit ELSE 0 END), 0)         AS this_profit,
         COALESCE(SUM(CASE WHEN date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
                            AND date < date_trunc('month', CURRENT_DATE)
                           THEN revenue ELSE 0 END), 0)        AS last_revenue,
         COALESCE(SUM(CASE WHEN date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
                            AND date < date_trunc('month', CURRENT_DATE)
                           THEN total_expenses ELSE 0 END), 0) AS last_expenses,
         COALESCE(SUM(CASE WHEN date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
                            AND date < date_trunc('month', CURRENT_DATE)
                           THEN profit ELSE 0 END), 0)         AS last_profit
       FROM transactions
       WHERE user_id = $1`,
      [userId]
    );
    const r = res.rows[0];
    return {
      thisMonth: {
        revenue:  parseFloat(r.this_revenue)  || 0,
        expenses: parseFloat(r.this_expenses) || 0,
        profit:   parseFloat(r.this_profit)   || 0,
      },
      lastMonth: {
        revenue:  parseFloat(r.last_revenue)  || 0,
        expenses: parseFloat(r.last_expenses) || 0,
        profit:   parseFloat(r.last_profit)   || 0,
      },
    };
  },
};

module.exports = TransactionModel;
