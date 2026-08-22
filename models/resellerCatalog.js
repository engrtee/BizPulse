/**
 * models/resellerCatalog.js
 * Reseller Ordering Agent — numbered catalog items (Section 2: "each product the
 * seller posts gets a short reference tag... the primary guardrail that makes
 * chat parsing tractable and reliable").
 */

'use strict';

const { query } = require('./db');

const ResellerCatalogModel = {
  async getById(id) {
    const res = await query(`SELECT * FROM reseller_catalog_items WHERE id = $1`, [id]);
    return res.rows[0] || null;
  },

  async getByItemNumber(sellerId, itemNumber) {
    const res = await query(
      `SELECT * FROM reseller_catalog_items
       WHERE seller_id = $1 AND item_number = $2 AND is_active = TRUE`,
      [sellerId, itemNumber]
    );
    return res.rows[0] || null;
  },

  async getActiveBySeller(sellerId) {
    const res = await query(
      `SELECT * FROM reseller_catalog_items
       WHERE seller_id = $1 AND is_active = TRUE
       ORDER BY item_number ASC`,
      [sellerId]
    );
    return res.rows;
  },

  /** Atomically assigns the next per-seller item number (same race-safe UPSERT
   * pattern as receipt_counters), then creates the catalog row. */
  async create({ sellerId, name, description, priceNaira, variantInfo, sourceType, openingStock }) {
    const counterRes = await query(
      `INSERT INTO reseller_catalog_counters (seller_id, next_number)
       VALUES ($1, 2)
       ON CONFLICT (seller_id) DO UPDATE SET next_number = reseller_catalog_counters.next_number + 1
       RETURNING next_number - 1 AS assigned_number`,
      [sellerId]
    );
    const itemNumber = counterRes.rows[0].assigned_number;

    // current_stock is only meaningful for seller_owned (Tier 1) items — a
    // supplier_dependent (Tier 2) item has no first-party stock figure at all.
    const stock = sourceType === 'seller_owned' ? (parseFloat(openingStock) || 0) : null;

    const res = await query(
      `INSERT INTO reseller_catalog_items
         (seller_id, item_number, name, description, price_naira, variant_info,
          source_type, current_stock, total_ever_received)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING *`,
      [sellerId, itemNumber, name, description || null, priceNaira || 0,
       variantInfo || null, sourceType, stock]
    );
    return res.rows[0];
  },

  async setStock(catalogItemId, newStock) {
    const res = await query(
      `UPDATE reseller_catalog_items
       SET current_stock = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [catalogItemId, newStock]
    );
    return res.rows[0];
  },

  async restock(catalogItemId, quantity) {
    const res = await query(
      `UPDATE reseller_catalog_items
       SET current_stock = COALESCE(current_stock, 0) + $2,
           total_ever_received = COALESCE(total_ever_received, 0) + $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [catalogItemId, quantity]
    );
    return res.rows[0];
  },

  async markSoldOut(catalogItemId) {
    const res = await query(
      `UPDATE reseller_catalog_items
       SET current_stock = 0, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [catalogItemId]
    );
    return res.rows[0];
  },
};

module.exports = ResellerCatalogModel;
