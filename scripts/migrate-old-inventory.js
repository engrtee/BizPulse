/**
 * scripts/migrate-old-inventory.js
 *
 * One-time migration: transfers stock from the old `inventory` table into the
 * new `products` + `product_transactions` tables for all users.
 *
 * Safe to run multiple times — skips products that already have stock or
 * existing transactions in the new system.
 *
 * Run: node scripts/migrate-old-inventory.js
 */

'use strict';

require('dotenv').config();
const { query, initDb } = require('../models/db');
const ProductModel      = require('../models/product');
const ProductService    = require('../services/productService');

async function run() {
  await initDb();

  console.log('=== Old Inventory → Products Migration ===\n');

  const inv = await query(`
    SELECT i.*, u.name AS user_name
    FROM inventory i
    JOIN users u ON u.id = i.user_id
    WHERE i.current_balance > 0
    ORDER BY i.user_id, i.item_name
  `);

  if (inv.rows.length === 0) {
    console.log('No old inventory rows with non-zero balance. Nothing to migrate.');
    process.exit(0);
  }

  console.log(`Found ${inv.rows.length} old inventory items to check:\n`);

  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  let migrated = 0, skipped = 0;

  for (const item of inv.rows) {
    const userId  = item.user_id;
    const rawName = item.item_name;
    const balance = parseFloat(item.current_balance);
    const price   = parseFloat(item.unit_price) || null;

    // Check if a matching product already exists in the new system
    const existing = await ProductService.findProductFuzzy(userId, rawName);

    if (existing) {
      const existingStock = parseFloat(existing.current_stock) || 0;
      const existingRecv  = parseFloat(existing.total_ever_received) || 0;

      if (existingRecv > 0) {
        // Product already has stock history in new system — check for balance mismatch
        if (Math.abs(existingStock - balance) > 0.01) {
          console.log(`⚠️  MISMATCH user=${userId} (${item.user_name}) [${rawName}]`);
          console.log(`     Old inventory: ${balance} units`);
          console.log(`     New products:  ${existingStock} units (from ${existingRecv} ever received)`);
          console.log(`     → Will correct new product stock to match old inventory balance\n`);

          // Add an adjustment transaction to reconcile
          const adjustment = balance - existingStock;
          await ProductModel.applyStockChange(existing.id, { delta: adjustment });
          if (adjustment > 0) {
            await ProductModel.recordTransaction({
              userId,
              productId:    existing.id,
              type:         'stock_in',
              quantity:     adjustment,
              unitPrice:    price,
              totalAmount:  price ? adjustment * price : 0,
              dailyEntryId: null,
              date,
              channel:      'retail',
            });
          }
          migrated++;
        } else {
          console.log(`✅  OK user=${userId} (${item.user_name}) [${rawName}] → ${existingStock} units (already correct)`);
          skipped++;
        }
        continue;
      }

      // Product exists but has 0 total_ever_received — likely created by a sale with no opening stock
      // Set the opening balance now
      console.log(`📦  FIXING user=${userId} (${item.user_name}) [${rawName}]`);
      console.log(`     Old inventory has ${balance} units. New product had ${existingStock} (no opening stock set)`);

      await ProductModel.setOpeningBalance(existing.id, balance, price);
      // Also update current_stock to reflect: opening - whatever was already sold
      const alreadySold = parseFloat(existing.total_ever_received) || 0; // was 0 before
      // Re-apply: current = balance (opening stock just set, transactions already recorded)
      // The new current_stock should be balance + existing delta from transactions
      const txRes = await query(
        `SELECT
           COALESCE(SUM(CASE WHEN transaction_type='stock_in' THEN quantity ELSE 0 END),0) AS total_in,
           COALESCE(SUM(CASE WHEN transaction_type='sale' THEN quantity ELSE 0 END),0) AS total_out
         FROM product_transactions WHERE product_id = $1 AND quantity IS NOT NULL`,
        [existing.id]
      );
      const totalIn  = parseFloat(txRes.rows[0].total_in)  || 0;
      const totalOut = parseFloat(txRes.rows[0].total_out) || 0;
      const correctStock = Math.max(0, balance + totalIn - totalOut);

      await query(
        'UPDATE products SET current_stock = $1, total_ever_received = $2 WHERE id = $3',
        [correctStock, balance + totalIn, existing.id]
      );
      console.log(`     → Set current_stock=${correctStock}, total_ever_received=${balance + totalIn}\n`);
      migrated++;
      continue;
    }

    // Product doesn't exist at all in new system — create it with the old inventory balance
    console.log(`📦  CREATING user=${userId} (${item.user_name}) [${rawName}] with ${balance} units`);
    const displayName   = ProductService.normalizeProductName(rawName);
    const normalizedKey = ProductService.normalizeForStorage(rawName);
    const product = await ProductModel.create(userId, displayName, normalizedKey, 'units');
    await ProductModel.setOpeningBalance(product.id, balance, price);
    await ProductModel.recordTransaction({
      userId,
      productId:    product.id,
      type:         'stock_in',
      quantity:     balance,
      unitPrice:    price,
      totalAmount:  price ? balance * price : 0,
      dailyEntryId: null,
      date,
      channel:      'retail',
    });
    console.log(`     → Created with ${balance} units opening stock\n`);
    migrated++;
  }

  console.log(`\n=== Done ===`);
  console.log(`Migrated/fixed: ${migrated} items`);
  console.log(`Already correct: ${skipped} items`);
  process.exit(0);
}

// Allow direct execution: node scripts/migrate-old-inventory.js
if (require.main === module) {
  run().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
}

module.exports = { run };
