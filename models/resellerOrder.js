/**
 * models/resellerOrder.js
 * Reseller Ordering Agent — order + order-line reads and lifecycle-status updates.
 *
 * Order CREATION (order + items + stock decrement, written atomically) lives in
 * src/reseller-agent/toolHandlers.js's place_order handler via withTransaction,
 * mirroring how BizPulse's own logSaleHandler keeps its atomic multi-table write
 * inline rather than behind a model method (see src/agent/toolHandlers.js).
 */

'use strict';

const { query } = require('./db');

const TIMESTAMP_COLUMN_FOR_STATUS = {
  confirmed: 'confirmed_at',
  paid: 'paid_at',
  delivered: 'delivered_at',
  cancelled: 'cancelled_at',
};

const ResellerOrderModel = {
  async getById(orderId) {
    const res = await query(`SELECT * FROM reseller_orders WHERE id = $1`, [orderId]);
    return res.rows[0] || null;
  },

  async getItemsForOrder(orderId) {
    const res = await query(
      `SELECT * FROM reseller_order_items WHERE order_id = $1 ORDER BY id ASC`,
      [orderId]
    );
    return res.rows;
  },

  async getOrdersForCustomer(sellerId, customerPhone, limit = 10) {
    const res = await query(
      `SELECT * FROM reseller_orders
       WHERE seller_id = $1 AND customer_phone = $2
       ORDER BY created_at DESC LIMIT $3`,
      [sellerId, customerPhone, limit]
    );
    return res.rows;
  },

  /** Orders a seller still needs to act on — verify, or acknowledge a payment receipt. */
  async getPendingForSeller(sellerId) {
    const res = await query(
      `SELECT * FROM reseller_orders
       WHERE seller_id = $1
         AND status IN ('pending_verification', 'awaiting_payment', 'payment_received')
       ORDER BY created_at ASC`,
      [sellerId]
    );
    return res.rows;
  },

  async listForSeller(sellerId, limit = 50) {
    const res = await query(
      `SELECT * FROM reseller_orders WHERE seller_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [sellerId, limit]
    );
    return res.rows;
  },

  /**
   * Move an order to a new status, stamping the matching timestamp column
   * (confirmed_at/paid_at/delivered_at/cancelled_at) when one applies.
   * @param {object} extra  { notes, paymentReceiptMediaId } — both optional
   */
  async updateStatus(orderId, status, extra = {}) {
    const timestampCol = TIMESTAMP_COLUMN_FOR_STATUS[status] || null;

    const sets = ['status = $2'];
    const params = [orderId, status];
    let idx = 3;
    if (timestampCol) sets.push(`${timestampCol} = NOW()`);
    if (extra.notes !== undefined) {
      sets.push(`notes = $${idx++}`);
      params.push(extra.notes);
    }
    if (extra.paymentReceiptMediaId !== undefined) {
      sets.push(`payment_receipt_media_id = $${idx++}`);
      params.push(extra.paymentReceiptMediaId);
    }

    const res = await query(
      `UPDATE reseller_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return res.rows[0];
  },
};

module.exports = ResellerOrderModel;
