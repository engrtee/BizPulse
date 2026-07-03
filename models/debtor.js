'use strict';

const { query } = require('./db');

const DebtorModel = {
  async create({ userId, debtorName, amount, productName, notes }) {
    const res = await query(
      `INSERT INTO debtors (user_id, debtor_name, amount, product_name, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, debtorName, amount, productName || null, notes || null]
    );
    return res.rows[0];
  },

  async findPending(userId, debtorName) {
    const res = await query(
      `SELECT * FROM debtors
       WHERE user_id = $1
         AND status IN ('pending', 'partial')
         AND LOWER(debtor_name) LIKE '%' || LOWER($2) || '%'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, debtorName]
    );
    return res.rows[0] || null;
  },

  async getPendingAll(userId) {
    const res = await query(
      `SELECT * FROM debtors
       WHERE user_id = $1 AND status IN ('pending', 'partial')
       ORDER BY created_at DESC`,
      [userId]
    );
    return res.rows;
  },

  /**
   * Append-only ledger (A1-3, Batch 1): INSERT a debt_payments row, then
   * recompute (never blindly increment) debtors.amount_paid/status/paid_at
   * from SUM(debt_payments) — debt_payments is the source of truth, the
   * columns on debtors are just a cache always rebuilt from it.
   */
  async markPaid(debtorId, amountPaid) {
    await query(
      `INSERT INTO debt_payments (debtor_id, amount) VALUES ($1, $2)`,
      [debtorId, amountPaid]
    );
    const res = await query(
      `UPDATE debtors d
       SET amount_paid = sub.total_paid,
           status       = CASE WHEN sub.total_paid >= d.amount THEN 'paid' ELSE 'partial' END,
           paid_at      = CASE WHEN sub.total_paid >= d.amount THEN NOW() ELSE NULL END
       FROM (
         SELECT debtor_id, COALESCE(SUM(amount), 0) AS total_paid
         FROM debt_payments
         WHERE debtor_id = $1
         GROUP BY debtor_id
       ) sub
       WHERE d.id = $1 AND sub.debtor_id = d.id
       RETURNING *`,
      [debtorId]
    );
    return res.rows[0];
  },

  async getTotalOwed(userId) {
    const res = await query(
      `SELECT COALESCE(SUM(amount - amount_paid), 0) AS total_owed
       FROM debtors
       WHERE user_id = $1 AND status IN ('pending', 'partial')`,
      [userId]
    );
    return parseFloat(res.rows[0]?.total_owed) || 0;
  },
};

module.exports = DebtorModel;
