'use strict';

const { query } = require('./db');
const { normalizePhone } = require('../utils/phone');

/**
 * models/customer.js
 * A trader's named contacts, captured on-demand (Batch 1, A2-3/A2-9) — only
 * when a reminder is actually requested and no phone is on file yet. This is
 * the consent record for outbound WhatsApp template messages to a trader's
 * customer: the trader supplying the number IS the request-to-contact event.
 */
const CustomerModel = {
  async findByPhone(userId, phone) {
    const normalized = normalizePhone(phone);
    const res = await query(
      `SELECT * FROM customers WHERE user_id = $1 AND phone = $2 LIMIT 1`,
      [userId, normalized]
    );
    return res.rows[0] || null;
  },

  /** Global lookup, no user scoping — used by the webhook STOP/DISPUTE
   *  intercept, which only knows the inbound phone number, not the trader. */
  async findAnyByPhone(phone) {
    const normalized = normalizePhone(phone);
    const res = await query(
      `SELECT * FROM customers WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [normalized]
    );
    return res.rows[0] || null;
  },

  async findOrCreate(userId, name, phone) {
    const normalized = normalizePhone(phone);
    const res = await query(
      `INSERT INTO customers (user_id, name, phone)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, phone)
       DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name), updated_at = NOW()
       RETURNING *`,
      [userId, name || null, normalized]
    );
    return res.rows[0];
  },

  /** A STOP reply means stop messaging that number, full stop — regardless
   *  of which trader relationship it belongs to. Global by design. */
  async markOptedOutByPhone(phone) {
    const normalized = normalizePhone(phone);
    const res = await query(
      `UPDATE customers SET opted_out = true, opted_out_at = NOW(), updated_at = NOW()
       WHERE phone = $1
       RETURNING *`,
      [normalized]
    );
    return res.rows;
  },
};

module.exports = CustomerModel;
