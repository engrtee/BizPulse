/**
 * scripts/migrate-old-inventory.js
 *
 * Reconciles the old `inventory` table with the new `products` table.
 * Called at server startup (non-blocking) and safe to run multiple times.
 *
 * RECONCILIATION RULES
 * ─────────────────────────────────────────────────────────────────────
 * The `products` table is the source of truth going forward because Kemi
 * (the WhatsApp agent) writes exclusively to it.
 *
 * For each item in the old `inventory` table:
 *
 * Case A — No matching product in `products` yet (Kemi has never seen it):
 *   → Create the product and set its opening stock from `inventory`.
 *
 * Case B — Product exists in `products` with total_ever_received = 0
 *           (Kemi created the product via a sale but never set opening stock):
 *   → Set opening stock from `inventory.current_balance` and recompute
 *     `current_stock` as opening + all stock_in movements - all sales.
 *
 * Case C — Product exists in `products` with total_ever_received > 0
 *           (Kemi has been actively tracking this item):
 *   → `products` is correct. Sync `inventory.current_balance` to match
 *     `products.current_stock` so the two tables stop drifting apart.
 *     This is the case that was causing the display discrepancy.
 */

'use strict';

require('dotenv').config();
const { query, initDb } = require('../models/db');
const ProductModel      = require('../models/product');
const ProductService    = require('../services/productService');

async function run() {
  console.log('[Migration] Reconciling inventory ↔ products tables...');

  // All old inventory rows with a non-zero balance or that have received stock
  const inv = await query(`
    SELECT i.*, u.name AS user_name
    FROM inventory i
    JOIN users u ON u.id = i.user_id
    WHERE i.current_balance > 0 OR i.total_received > 0
    ORDER BY i.user_id, i.item_name
  `);

  if (inv.rows.length === 0) {
    console.log('[Migration] Old inventory is empty — nothing to reconcile.');
    return;
  }

  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  let caseA = 0, caseB = 0, caseC = 0;

  for (const item of inv.rows) {
    const userId  = item.user_id;
    const rawName = item.item_name;
    const balance = parseFloat(item.current_balance) || 0;
    const price   = parseFloat(item.unit_price) || null;

    try {
      const existing = await ProductService.findProductFuzzy(userId, rawName);

      // ── Case A: product doesn't exist in new system yet ──────────────────
      if (!existing) {
        if (balance <= 0) continue; // nothing to migrate
        const displayName   = ProductService.normalizeProductName(rawName);
        const normalizedKey = ProductService.normalizeForStorage(rawName);
        const product = await ProductModel.create(userId, displayName, normalizedKey, 'units');
        await ProductModel.setOpeningBalance(product.id, balance, price);
        await ProductModel.recordTransaction({
          userId, productId: product.id, type: 'stock_in',
          quantity: balance, unitPrice: price,
          totalAmount: price ? balance * price : 0,
          dailyEntryId: null, date, channel: 'retail',
        });
        console.log(`[Migration] A — Created "${rawName}" for user ${userId} (${item.user_name}): ${balance} units`);
        caseA++;
        continue;
      }

      const existingStock = parseFloat(existing.current_stock)       || 0;
      const existingRecv  = parseFloat(existing.total_ever_received) || 0;

      // ── Case B: product exists but Kemi never set opening stock ──────────
      if (existingRecv === 0 && balance > 0) {
        // Calculate correct current_stock from opening + movements
        const txRes = await query(
          `SELECT
             COALESCE(SUM(CASE WHEN transaction_type='stock_in' THEN quantity ELSE 0 END), 0) AS total_in,
             COALESCE(SUM(CASE WHEN transaction_type='sale'     THEN quantity ELSE 0 END), 0) AS total_out
           FROM product_transactions
           WHERE product_id = $1 AND quantity IS NOT NULL`,
          [existing.id]
        );
        const totalIn   = parseFloat(txRes.rows[0].total_in)  || 0;
        const totalOut  = parseFloat(txRes.rows[0].total_out) || 0;
        const newStock  = Math.max(0, balance + totalIn - totalOut);
        const newRecv   = balance + totalIn;

        await query(
          'UPDATE products SET current_stock = $1, total_ever_received = $2, last_purchase_price = COALESCE($3, last_purchase_price) WHERE id = $4',
          [newStock, newRecv, price, existing.id]
        );
        console.log(`[Migration] B — Fixed "${rawName}" for user ${userId} (${item.user_name}): stock ${existingStock}→${newStock}, ever_rcvd 0→${newRecv}`);
        caseB++;
        continue;
      }

      // ── Case C: Kemi is actively tracking — products is truth ────────────
      // Sync inventory to match products so the tables stay in agreement.
      if (Math.abs(existingStock - balance) > 0.01) {
        await query(
          'UPDATE inventory SET current_balance = $1 WHERE user_id = $2 AND LOWER(item_name) = LOWER($3)',
          [existingStock, userId, rawName]
        );
        console.log(`[Migration] C — Synced inventory "${rawName}" for user ${userId} (${item.user_name}): ${balance}→${existingStock} (products is truth)`);
        caseC++;
      }

    } catch (err) {
      console.error(`[Migration] Error on "${rawName}" user=${userId}:`, err.message);
    }
  }

  console.log(`[Migration] Done — A(created):${caseA}  B(fixed):${caseB}  C(synced):${caseC}`);
}

// Allow direct execution: node scripts/migrate-old-inventory.js
if (require.main === module) {
  initDb()
    .then(() => run())
    .then(() => process.exit(0))
    .catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
}

module.exports = { run };
