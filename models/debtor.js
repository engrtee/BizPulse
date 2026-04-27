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

  async markPaid(debtorId, amountPaid) {
    const res = await query(
      `UPDATE debtors
       SET amount_paid = amount_paid + $2,
           status      = CASE WHEN amount_paid + $2 >= amount THEN 'paid' ELSE 'partial' END,
           paid_at     = CASE WHEN amount_paid + $2 >= amount THEN NOW() ELSE NULL END
       WHERE id = $1
       RETURNING *`,
      [debtorId, amountPaid]
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
