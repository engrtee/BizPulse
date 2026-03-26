/**
 * models/inventory.js
 * PostgreSQL queries for the inventory / stock table.
 * This is the fast lookup table — the canonical record lives in Google Sheets.
 */

'use strict';

const { query } = require('./db');

const InventoryModel = {
  /** Get all stock items for a user */
  async getAll(userId) {
    const res = await query(
      `SELECT * FROM inventory
       WHERE user_id = $1
       ORDER BY item_name ASC`,
      [userId]
    );
    return res.rows;
  },

  /** Get a single item by name (case-insensitive) */
  async getItem(userId, itemName) {
    const res = await query(
      `SELECT * FROM inventory
       WHERE user_id = $1 AND LOWER(item_name) = LOWER($2) LIMIT 1`,
      [userId, itemName]
    );
    return res.rows[0] || null;
  },

  /**
   * Upsert a stock movement.
   * direction: 'received' | 'sold'
   * qty: number of units
   * Tracks total_received for dynamic low-stock threshold (20% of ever received).
   */
  async applyMovement(userId, itemName, direction, qty, unitPrice) {
    const existing = await InventoryModel.getItem(userId, itemName);

    if (existing) {
      const newBalance =
        direction === 'received'
          ? existing.current_balance + qty
          : Math.max(0, existing.current_balance - qty);

      const res = await query(
        `UPDATE inventory
         SET current_balance = $1,
             total_received  = CASE WHEN $5 THEN total_received + $6 ELSE total_received END,
             unit_price      = COALESCE($2, unit_price),
             last_updated    = NOW()
         WHERE user_id = $3 AND LOWER(item_name) = LOWER($4)
         RETURNING *`,
        [newBalance, unitPrice || null, userId, itemName, direction === 'received', qty]
      );
      return res.rows[0];
    } else {
      // First time this item is seen — create it
      const initialBalance  = direction === 'received' ? qty : 0;
      const initialReceived = direction === 'received' ? qty : 0;
      const res = await query(
        `INSERT INTO inventory (user_id, item_name, current_balance, total_received, unit_price)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, itemName, initialBalance, initialReceived, unitPrice || 0]
      );
      return res.rows[0];
    }
  },

  /**
   * Return items that need attention:
   *   - Out of stock:  current_balance = 0 (most urgent)
   *   - Low stock:     current_balance < 20% of total_received (but > 0)
   * Falls back to legacy low_stock_threshold for old items with no total_received data.
   */
  async getLowStock(userId) {
    const res = await query(
      `SELECT *,
         (current_balance = 0)                                             AS is_out_of_stock,
         (current_balance > 0 AND total_received > 0
          AND current_balance < total_received * 0.20)                    AS is_low_stock
       FROM inventory
       WHERE user_id = $1
         AND (
           current_balance = 0
           OR (total_received > 0 AND current_balance < total_received * 0.20)
           OR (total_received = 0 AND current_balance > 0 AND current_balance <= low_stock_threshold)
         )
       ORDER BY current_balance ASC, item_name`,
      [userId]
    );
    return res.rows;
  },

  /** Update the low-stock threshold for an item */
  async setThreshold(userId, itemName, threshold) {
    await query(
      `UPDATE inventory SET low_stock_threshold = $1
       WHERE user_id = $2 AND LOWER(item_name) = LOWER($3)`,
      [threshold, userId, itemName]
    );
  },
};

module.exports = InventoryModel;
