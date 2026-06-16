/**
 * models/inventory.js
 * PostgreSQL queries for the inventory / stock table.
 * CRITICAL FIX: Inventory fuzzy matching prevents duplicates.
 */

'use strict';

const { query } = require('./db');

/**
 * Normalize an item name for fuzzy matching.
 * Lowercase, trim, strip plural 's' (only for words > 3 chars).
 */
function normalizeItemName(name) {
  const trimmed = (name || '').trim().toLowerCase();
  return trimmed.length > 3 && trimmed.endsWith('s') && !trimmed.endsWith('ss')
    ? trimmed.slice(0, -1)
    : trimmed;
}

const InventoryModel = {
  /**
   * Get all stock items for a user
   */
  async getAll(userId) {
    const res = await query(
      `SELECT * FROM inventory
       WHERE user_id = $1
       ORDER BY item_name ASC`,
      [userId]
    );
    return res.rows;
  },

  /**
   * DEPRECATED: Use getItemFuzzy() instead.
   * Kept for backward compatibility — exact case-insensitive lookup only.
   */
  async getItem(userId, itemName) {
    const res = await query(
      `SELECT * FROM inventory
       WHERE user_id = $1 AND LOWER(item_name) = LOWER($2) LIMIT 1`,
      [userId, itemName]
    );
    return res.rows[0] || null;
  },

  /**
   * Find an existing inventory item using FUZZY MATCHING.
   * Handles case differences and plural/singular (e.g., "laptop" vs "laptops").
   * 
   * CRITICAL: Only searches — never deletes or modifies (INSERT-only rule preserved).
   */
  async getItemFuzzy(userId, itemName) {
    const normalized = normalizeItemName(itemName);
    if (!normalized) return null;

    const res = await query(
      `SELECT * FROM inventory
       WHERE user_id = $1
         AND (
           LOWER(item_name) = $2
           OR LOWER(REGEXP_REPLACE(item_name, 's$', '')) = $2
         )
       LIMIT 1`,
      [userId, normalized]
    );
    
    return res.rows[0] || null;
  },

  /**
   * Upsert a stock movement (direction: 'received' | 'sold').
   * NOW uses fuzzy matching to find existing items FIRST.
   */
  async applyMovement(userId, itemName, direction, qty, unitPrice) {
    // Use FUZZY matching to find existing item
    const existing = await InventoryModel.getItemFuzzy(userId, itemName);

    if (existing) {
      const currentBal = parseFloat(existing.current_balance) || 0;
      const newBalance =
        direction === 'received'
          ? currentBal + qty
          : Math.max(0, currentBal - qty);

      const res = await query(
        `UPDATE inventory
         SET current_balance = $1,
             total_received  = CASE WHEN $5 THEN total_received + $6 ELSE total_received END,
             unit_price      = COALESCE($2, unit_price),
             last_updated    = NOW()
         WHERE id = $4
         RETURNING *`,
        [newBalance, unitPrice || null, userId, existing.id, direction === 'received', qty]
      );
      return res.rows[0];
    } else {
      // First time this item is seen — INSERT (never overwrites)
      const initialBalance = direction === 'received' ? qty : 0;
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
   * Return items needing attention (low or out of stock).
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

  /**
   * Update the low-stock threshold for an item.
   */
  async setThreshold(userId, itemName, threshold) {
    await query(
      `UPDATE inventory SET low_stock_threshold = $1
       WHERE user_id = $2 AND LOWER(item_name) = LOWER($3)`,
      [threshold, userId, itemName]
    );
  },

  /**
   * MIGRATION HELPER: Find duplicate inventory items (same normalized name).
   * Used by migration script to show admins duplicates before merging.
   */
  async findDuplicates(userId) {
    const res = await query(
      `SELECT
         LOWER(REGEXP_REPLACE(item_name, 's$', '')) AS normalized_name,
         COUNT(*) as count,
         ARRAY_AGG(id) as ids,
         ARRAY_AGG(item_name) as names,
         ARRAY_AGG(current_balance) as balances,
         ARRAY_AGG(total_received) as total_received,
         ARRAY_AGG(unit_price) as prices
       FROM inventory
       WHERE user_id = $1
       GROUP BY normalized_name
       HAVING COUNT(*) > 1
       ORDER BY count DESC`,
      [userId]
    );
    return res.rows;
  },
};

module.exports = InventoryModel;
