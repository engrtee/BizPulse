'use strict';
/**
 * BIZPULSE — BATCH 4 EXIT GATE: PHOTO-IN CONFIRMATION + STOCK INTEGRITY (A1-8)
 * ══════════════════════════════════════════════════════════════
 * Run with:  node tests/photo_confirmation_test.js
 *
 * Real-DB integration test (no mocks), same style as prior batches.
 *
 * Covers (Batch 4):
 *   1. stage_photo_stock_entry drafts only — touches no products/
 *      product_transactions rows yet.
 *   2. confirm_pending_stock_entry(confirm) commits stock + cost price +
 *      product_transactions.
 *   3. confirm_pending_stock_entry(cancel) leaves no residue.
 *   4. void-zeroes-quantity: a voided sale's quantity is actually zeroed,
 *      and ProductModel.getVelocity() stops counting it.
 *   5. recomputeStock(): an artificially desynced current_stock is detected
 *      and applyRecompute() corrects it back to what the ledger says.
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config();

const { query } = require('../models/db');
const {
  stagePhotoStockEntryHandler,
  confirmPendingStockEntryHandler,
  logSaleHandler,
  correctLastEntryHandler,
} = require('../src/agent/toolHandlers');
const ProductModel = require('../models/product');

const TEST_PHONE = '2348099990011';

let passCount = 0, failCount = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`✅  PASS — ${label}`);
    passCount++;
  } else {
    console.log(`❌  FAIL — ${label}${detail ? ` (${detail})` : ''}`);
    failCount++;
  }
}

async function setupTestUser() {
  await query(`
    INSERT INTO users (name, email, biz_name, biz_type, whatsapp_number, active)
    VALUES ('Photo Confirm Test', 'photo.confirm.test@bizpulse.test', 'Test Shop', 'Retail', $1, true)
    ON CONFLICT (whatsapp_number) DO UPDATE SET name = EXCLUDED.name
  `, [TEST_PHONE]);
  const res = await query('SELECT id FROM users WHERE whatsapp_number = $1', [TEST_PHONE]);
  return res.rows[0].id;
}

async function wipeTestData(userId) {
  await query('DELETE FROM pending_entries WHERE user_id = $1', [userId]);
  await query('DELETE FROM product_transactions WHERE user_id = $1', [userId]);
  await query('DELETE FROM products WHERE user_id = $1', [userId]);
  await query('DELETE FROM transactions WHERE user_id = $1', [userId]);
}

async function main() {
  console.log('█'.repeat(60));
  console.log('  BATCH 4 EXIT GATE — PHOTO-IN CONFIRMATION + STOCK INTEGRITY');
  console.log('█'.repeat(60));

  const userId = await setupTestUser();
  await wipeTestData(userId);
  console.log(`✅ Test user ready: ${TEST_PHONE} (id ${userId})\n`);

  // ── 1. Staging drafts only ─────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  stage_photo_stock_entry drafts only, no commit');

  const staged = await stagePhotoStockEntryHandler({
    items: [
      { product: 'Garri', quantity: 15, unit: 'bags', unit_cost: 700 },
      { product: 'Beans', quantity: 8, unit: 'bags', unit_cost: 1200 },
    ],
    supplier_name: 'Alhaji Musa',
    whatsappNumber: TEST_PHONE,
  });
  check('staging reports staged', staged.staged === true, JSON.stringify(staged));

  const productsAfterStage = await query('SELECT COUNT(*)::int n FROM products WHERE user_id = $1', [userId]);
  check('no products created by staging alone', productsAfterStage.rows[0].n === 0, `found ${productsAfterStage.rows[0].n}`);

  const pendingRow = await query(`SELECT * FROM pending_entries WHERE user_id = $1 AND status = 'pending'`, [userId]);
  check('a pending_entries row exists with entry_type photo_stock_in', pendingRow.rows.length === 1 && pendingRow.rows[0].entry_type === 'photo_stock_in', JSON.stringify(pendingRow.rows[0]));

  // ── 2. Confirm commits atomically ──────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  confirm_pending_stock_entry(confirm) commits stock + cost + transactions');

  const confirmed = await confirmPendingStockEntryHandler({ action: 'confirm', whatsappNumber: TEST_PHONE });
  check('confirm reports confirmed', confirmed.confirmed === true, JSON.stringify(confirmed));
  check('2 items committed', confirmed.items_committed?.length === 2, JSON.stringify(confirmed.items_committed));

  const garri = await query(`SELECT * FROM products WHERE user_id = $1 AND product_name = 'Garri'`, [userId]);
  check('Garri stock + cost price committed', garri.rows.length === 1 && parseFloat(garri.rows[0].current_stock) === 15 && parseFloat(garri.rows[0].last_purchase_price) === 700, JSON.stringify(garri.rows[0]));

  const stockInRows = await query(`SELECT * FROM product_transactions WHERE user_id = $1 AND transaction_type = 'stock_in'`, [userId]);
  check('2 stock_in product_transactions rows recorded', stockInRows.rows.length === 2, `found ${stockInRows.rows.length}`);

  const pendingAfterConfirm = await query(`SELECT status FROM pending_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
  check('pending entry marked confirmed', pendingAfterConfirm.rows[0]?.status === 'confirmed', JSON.stringify(pendingAfterConfirm.rows[0]));

  // ── 3. Cancel leaves no residue ─────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  confirm_pending_stock_entry(cancel) leaves no residue');

  await stagePhotoStockEntryHandler({
    items: [{ product: 'Cancelled Item', quantity: 5, unit: 'units' }],
    whatsappNumber: TEST_PHONE,
  });
  const cancelResult = await confirmPendingStockEntryHandler({ action: 'cancel', whatsappNumber: TEST_PHONE });
  check('cancel reports cancelled', cancelResult.cancelled === true, JSON.stringify(cancelResult));

  const cancelledProduct = await query(`SELECT COUNT(*)::int n FROM products WHERE user_id = $1 AND product_name = 'Cancelled Item'`, [userId]);
  check('cancelled draft created no product row', cancelledProduct.rows[0].n === 0, `found ${cancelledProduct.rows[0].n}`);

  // ── 4. Void-zeroes-quantity fix ─────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Void-zeroes-quantity: a voided sale no longer inflates velocity');

  await logSaleHandler({ product: 'Garri', quantity: 5, unit_price: 1000, whatsappNumber: TEST_PHONE });
  const velocityBeforeVoid = await ProductModel.getVelocity(garri.rows[0].id);
  check('velocity is > 0 right after a real sale', velocityBeforeVoid > 0, `got ${velocityBeforeVoid}`);

  await correctLastEntryHandler({ action: 'delete', whatsappNumber: TEST_PHONE });

  const voidedRow = await query(
    `SELECT quantity, total_amount FROM product_transactions
     WHERE user_id = $1 AND notes LIKE '%[VOIDED]%' ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  check('voided row has quantity = 0', parseFloat(voidedRow.rows[0]?.quantity) === 0, JSON.stringify(voidedRow.rows[0]));

  const velocityAfterVoid = await ProductModel.getVelocity(garri.rows[0].id);
  check('velocity no longer counts the voided sale', velocityAfterVoid === 0, `got ${velocityAfterVoid}`);

  // ── 5. recomputeStock() detects and fixes drift ─────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  recomputeStock(): detects and corrects an artificially desynced stock value');

  await query(`UPDATE products SET current_stock = 9999 WHERE id = $1`, [garri.rows[0].id]);
  const drift = await ProductModel.recomputeStock(garri.rows[0].id);
  check('drift is detected', drift.drifted === true, JSON.stringify(drift));

  const fixed = await ProductModel.applyRecompute(garri.rows[0].id);
  check('applyRecompute corrects the live value', fixed.drifted === true, JSON.stringify(fixed));

  const afterFix = await query(`SELECT current_stock FROM products WHERE id = $1`, [garri.rows[0].id]);
  check('current_stock now matches the ledger-derived value', parseFloat(afterFix.rows[0].current_stock) === fixed.ledger, JSON.stringify(afterFix.rows[0]));

  await wipeTestData(userId);
  await query('DELETE FROM users WHERE id = $1', [userId]);

  console.log('\n' + '█'.repeat(60));
  console.log(`  RESULT: ${passCount} passed, ${failCount} failed`);
  console.log('█'.repeat(60) + '\n');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
