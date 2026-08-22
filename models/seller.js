/**
 * models/seller.js
 * Reseller Ordering Agent — seller accounts + the customer→seller session-memory link.
 *
 * Separate product from BizPulse's trader model (models/user.js) — sellers here are
 * resellers/dropshippers whose customers place orders over WhatsApp, not traders
 * logging their own sales. See docs: bizpulse-v1-build-prompt.md Section 4a.
 */

'use strict';

const { query } = require('./db');
const { normalizePhone } = require('../utils/phone');

const SellerModel = {
  async findByWhatsapp(whatsappNumber) {
    const normalized = normalizePhone(whatsappNumber);
    const res = await query(
      `SELECT * FROM reseller_sellers WHERE whatsapp_number = $1 AND active = TRUE`,
      [normalized]
    );
    return res.rows[0] || null;
  },

  async findByCode(code) {
    if (!code) return null;
    const res = await query(
      `SELECT * FROM reseller_sellers WHERE UPPER(code) = UPPER($1) AND active = TRUE`,
      [code.trim()]
    );
    return res.rows[0] || null;
  },

  async findById(id) {
    const res = await query(`SELECT * FROM reseller_sellers WHERE id = $1`, [id]);
    return res.rows[0] || null;
  },

  /** All active sellers — small list in V1, safe to fetch in full for fuzzy matching. */
  async getAllActive() {
    const res = await query(
      `SELECT id, name, business_name, code, whatsapp_number
       FROM reseller_sellers WHERE active = TRUE`
    );
    return res.rows;
  },

  async create({ name, businessName, code, whatsappNumber, bankAccountName, bankAccountNumber, bankName }) {
    const res = await query(
      `INSERT INTO reseller_sellers
         (name, business_name, code, whatsapp_number, bank_account_name, bank_account_number, bank_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, businessName, code.trim().toUpperCase(), normalizePhone(whatsappNumber),
       bankAccountName || null, bankAccountNumber || null, bankName || null]
    );
    return res.rows[0];
  },

  // ── Customer → seller session memory (Section 4a) ───────────────────────
  // Identify a customer's seller once (via sellerMatcher), reuse it for the rest
  // of that relationship. A customer can re-link to a different seller by naming
  // one explicitly again (switch_seller tool) — this simply overwrites the row.

  async getLinkedSellerId(customerPhone) {
    const res = await query(
      `SELECT seller_id FROM reseller_customer_seller_link WHERE phone = $1`,
      [normalizePhone(customerPhone)]
    );
    return res.rows[0]?.seller_id || null;
  },

  async linkCustomer(customerPhone, sellerId) {
    const phone = normalizePhone(customerPhone);
    await query(
      `INSERT INTO reseller_customer_seller_link (phone, seller_id, first_seen_at, last_seen_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (phone) DO UPDATE
         SET seller_id = $2, last_seen_at = NOW()`,
      [phone, sellerId]
    );
  },

  async touchCustomerSeen(customerPhone) {
    await query(
      `UPDATE reseller_customer_seller_link SET last_seen_at = NOW() WHERE phone = $1`,
      [normalizePhone(customerPhone)]
    );
  },
};

module.exports = SellerModel;
