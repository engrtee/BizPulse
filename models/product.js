/**
 * models/product.js
 * All PostgreSQL queries for the products and product_transactions tables.
 * Task 2 — Product-level performance tracking.
 */

'use strict';

const { query } = require('./db');

const ProductModel = {

  // ── Product CRUD ────────────────────────────────────────────────────────

  /** Find product by normalized name (exact match). */
  async findByNormalized(userId, normalizedName) {
    const res = await query(
      `SELECT * FROM products
       WHERE user_id = $1
         AND LOWER(product_name_normalized) = LOWER($2)
         AND is_active = true
       LIMIT 1`,
      [userId, normalizedName]
    );
    return res.rows[0] || null;
  },

  /** All candidate products for a user (for fuzzy matching in JS). */
  async getAllForUser(userId) {
    const res = await query(
      `SELECT id, product_name, product_name_normalized, unit,
              current_stock, total_ever_received,
              last_purchase_price, last_sale_price
       FROM products
       WHERE user_id = $1 AND is_active = true
       ORDER BY product_name`,
      [userId]
    );
    return res.rows;
  },

  /** Insert a new product. Returns the created row. */
  async create(userId, productName, normalizedName, unit = 'units') {
    const res = await query(
      `INSERT INTO products (user_id, product_name, product_name_normalized, unit)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, product_name_normalized) DO UPDATE
         SET product_name = EXCLUDED.product_name,
             updated_at   = NOW()
       RETURNING *`,
      [userId, productName, normalizedName, unit]
    );
    return res.rows[0];
  },

  /** Apply a stock change and update prices. */
  async applyStockChange(productId, { delta, purchasePrice, salePrice }) {
    const clauses = [];
    const params  = [productId];
    let   idx     = 2;

    if (delta > 0) {
      clauses.push(`current_stock       = GREATEST(current_stock + $${idx}, 0)`);
      clauses.push(`total_ever_received = total_ever_received + $${idx++}`);
      params.push(delta);
    } else if (delta < 0) {
      clauses.push(`current_stock = GREATEST(current_stock + $${idx++}, 0)`);
      params.push(delta); // negative
    }

    if (purchasePrice != null) {
      clauses.push(`last_purchase_price = $${idx++}`);
      params.push(purchasePrice);
    }
    if (salePrice != null) {
      clauses.push(`last_sale_price = $${idx++}`);
      params.push(salePrice);
    }

    if (!clauses.length) return;
    clauses.push(`updated_at = NOW()`);

    await query(
      `UPDATE products SET ${clauses.join(', ')} WHERE id = $1`,
      params
    );
  },

  /** Fetch one product by id. */
  async getById(productId) {
    const res = await query(
      `SELECT * FROM products WHERE id = $1`,
      [productId]
    );
    return res.rows[0] || null;
  },

  // ── Product transactions ────────────────────────────────────────────────

  /** Record a product transaction (sale or stock_in). */
  async recordTransaction({ userId, productId, type, quantity, unitPrice, totalAmount, dailyEntryId, date, channel }) {
    await query(
      `INSERT INTO product_transactions
         (user_id, product_id, transaction_type, quantity, unit_price,
          total_amount, transaction_date, daily_entry_id, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, productId, type, quantity || null, unitPrice || null,
       totalAmount || 0, date, dailyEntryId || null, channel || 'retail']
    );
  },

  // ── Velocity & health ───────────────────────────────────────────────────

  /** Average units sold per day over last 7 days. */
  async getVelocity(productId) {
    const res = await query(
      `SELECT COALESCE(SUM(quantity), 0) / 7.0 AS velocity
       FROM product_transactions
       WHERE product_id    = $1
         AND transaction_type = 'sale'
         AND transaction_date >= CURRENT_DATE - INTERVAL '7 days'`,
      [productId]
    );
    return parseFloat(res.rows[0]?.velocity || 0);
  },

  /** Current stock level. */
  async getCurrentStock(productId) {
    const res = await query(
      `SELECT current_stock FROM products WHERE id = $1`,
      [productId]
    );
    return parseFloat(res.rows[0]?.current_stock || 0);
  },

  // ── Stock alert deduplication ───────────────────────────────────────────

  /** Returns true if an alert of this type was already sent today. */
  async alertAlreadySentToday(userId, productId, alertType) {
    const res = await query(
      `SELECT id FROM stock_alerts_sent
       WHERE user_id    = $1
         AND product_id = $2
         AND alert_date = CURRENT_DATE
         AND alert_type = $3`,
      [userId, productId, alertType]
    );
    return res.rows.length > 0;
  },

  /** Record that an alert was sent. */
  async recordAlert(userId, productId, alertType) {
    await query(
      `INSERT INTO stock_alerts_sent (user_id, product_id, alert_date, alert_type)
       VALUES ($1, $2, CURRENT_DATE, $3)
       ON CONFLICT DO NOTHING`,
      [userId, productId, alertType]
    );
  },

  // ── Dashboard queries ───────────────────────────────────────────────────

  /** All products for a user with health status and velocity. */
  async getWithHealth(userId) {
    const res = await query(
      `SELECT
         p.*,
         COALESCE(
           (SELECT SUM(pt.quantity) / 7.0
            FROM product_transactions pt
            WHERE pt.product_id       = p.id
              AND pt.transaction_type = 'sale'
              AND pt.transaction_date >= CURRENT_DATE - INTERVAL '7 days'),
           0
         ) AS velocity_per_day
       FROM products p
       WHERE p.user_id   = $1
         AND p.is_active = true
       ORDER BY p.current_stock ASC`,
      [userId]
    );
    return res.rows;
  },

  /** 7-day and 30-day revenue + units sold per product. */
  async getPerformance(userId) {
    const res = await query(
      `SELECT
         p.id,
         p.product_name,
         p.unit,
         p.current_stock,
         p.last_purchase_price,
         p.last_sale_price,
         COALESCE(SUM(pt.total_amount) FILTER (
           WHERE pt.transaction_type = 'sale'
             AND pt.transaction_date >= CURRENT_DATE - INTERVAL '7 days'), 0) AS revenue_7d,
         COALESCE(SUM(pt.total_amount) FILTER (
           WHERE pt.transaction_type = 'sale'
             AND pt.transaction_date >= CURRENT_DATE - INTERVAL '30 days'), 0) AS revenue_30d,
         COALESCE(SUM(pt.quantity) FILTER (
           WHERE pt.transaction_type = 'sale'
             AND pt.transaction_date >= CURRENT_DATE - INTERVAL '7 days'), 0) AS units_sold_7d,
         COALESCE(SUM(pt.quantity) FILTER (
           WHERE pt.transaction_type = 'sale'
             AND pt.transaction_date >= CURRENT_DATE - INTERVAL '30 days'), 0) AS units_sold_30d
       FROM products p
       LEFT JOIN product_transactions pt ON pt.product_id = p.id
       WHERE p.user_id = $1 AND p.is_active = true
       GROUP BY p.id
       ORDER BY revenue_30d DESC`,
      [userId]
    );
    return res.rows;
  },

  /** Last N product transactions for a user (stock movements log). */
  async getRecentMovements(userId, limit = 20) {
    const res = await query(
      `SELECT pt.*, p.product_name, p.unit
       FROM product_transactions pt
       JOIN products p ON p.id = pt.product_id
       WHERE pt.user_id = $1
       ORDER BY pt.created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return res.rows;
  },

  /** Set opening stock balance directly (used for opening stock onboarding). */
  async setOpeningBalance(productId, quantity, purchasePrice) {
    await query(
      `UPDATE products
       SET current_stock       = $2,
           total_ever_received = GREATEST(total_ever_received, $2),
           last_purchase_price = COALESCE($3, last_purchase_price),
           updated_at          = NOW()
       WHERE id = $1`,
      [productId, quantity, purchasePrice || null]
    );
  },

  /** Per-channel (retail vs wholesale) revenue breakdown for the last 30 days. */
  async getChannelPerformance(userId) {
    const res = await query(
      `SELECT
         p.product_name,
         p.unit,
         p.current_stock,
         p.last_purchase_price,
         COALESCE(pt.channel, 'retail')                                                           AS channel,
         COALESCE(SUM(pt.quantity)    FILTER (WHERE pt.transaction_type = 'sale'), 0)             AS units_sold,
         COALESCE(SUM(pt.total_amount) FILTER (WHERE pt.transaction_type = 'sale'), 0)            AS revenue,
         COALESCE(SUM(pt.quantity)    FILTER (WHERE pt.transaction_type = 'sale' AND pt.transaction_date >= CURRENT_DATE - INTERVAL '7 days'), 0) AS units_7d,
         COALESCE(SUM(pt.total_amount) FILTER (WHERE pt.transaction_type = 'sale' AND pt.transaction_date >= CURRENT_DATE - INTERVAL '7 days'), 0) AS revenue_7d
       FROM products p
       LEFT JOIN product_transactions pt ON pt.product_id = p.id
         AND pt.transaction_date >= CURRENT_DATE - INTERVAL '30 days'
       WHERE p.user_id = $1 AND p.is_active = true
       GROUP BY p.id, p.product_name, p.unit, p.current_stock, p.last_purchase_price, COALESCE(pt.channel, 'retail')
       ORDER BY revenue DESC`,
      [userId]
    );
    return res.rows;
  },

  /** Today's product sales for the dashboard product table. */
  async getTodaySales(userId) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    const res = await query(
      `SELECT
         p.product_name,
         p.unit,
         p.current_stock,
         p.last_purchase_price,
         COALESCE(SUM(pt.quantity) FILTER (WHERE pt.transaction_type = 'sale'), 0)     AS sold_today,
         COALESCE(SUM(pt.total_amount) FILTER (WHERE pt.transaction_type = 'sale'), 0) AS revenue_today
       FROM products p
       LEFT JOIN product_transactions pt ON pt.product_id = p.id AND pt.transaction_date = $2
       WHERE p.user_id = $1 AND p.is_active = true
       GROUP BY p.id
       HAVING COALESCE(SUM(pt.quantity) FILTER (WHERE pt.transaction_type = 'sale'), 0) > 0
       ORDER BY revenue_today DESC`,
      [userId, today]
    );
    return res.rows;
  },
};

module.exports = ProductModel;
