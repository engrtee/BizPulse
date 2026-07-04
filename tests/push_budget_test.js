'use strict';
/**
 * BIZPULSE — BATCH 3 EXIT GATE: PUSHED INSIGHTS + THE GLOBAL SEND CAP
 * ══════════════════════════════════════════════════════════════
 * Run with:  node tests/push_budget_test.js
 *
 * Real-DB integration test (no mocks), same style as prior batches. Forces
 * WhatsAppService's dev-mode fallback (see tests/debt_consolidation_test.js
 * for why).
 *
 * Covers (Batch 3):
 *   1. Budget enforcement: 10 recorded pushes exhausts the weekly cap; the
 *      11th check returns false.
 *   2. out_of_stock bypass: still returns true past the cap, and still logs.
 *   3. Live-path fix: logSaleHandler on an engineered low-stock product
 *      actually creates a push_log row — proof Kemi's live sale path now
 *      triggers what used to be dead code (checkAndSendLowStockAlert had
 *      zero production callers before this batch).
 *   4. Weekly profit note's honest-degradation branch: >30% of this week's
 *      sold items missing cost price is correctly detected.
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config();

// Force WhatsAppService's dev-mode fallback (console log, no real API call).
process.env.WHATSAPP_PHONE_NUMBER_ID = '';
process.env.WHATSAPP_TOKEN = '';

const { query } = require('../models/db');
const { checkPushBudget, recordPush, WEEKLY_CAP } = require('../services/pushBudget');
const { logSaleHandler, logRestockHandler } = require('../src/agent/toolHandlers');
const { getMissingCostFraction } = require('../jobs/weeklyProfitNote');

const TEST_PHONE = '2348088889900';

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
    VALUES ('Push Budget Test', 'push.budget.test@bizpulse.test', 'Test Shop', 'Retail', $1, true)
    ON CONFLICT (whatsapp_number) DO UPDATE SET name = EXCLUDED.name
  `, [TEST_PHONE]);
  const res = await query('SELECT id FROM users WHERE whatsapp_number = $1', [TEST_PHONE]);
  return res.rows[0].id;
}

async function wipeTestData(userId) {
  await query('DELETE FROM push_log WHERE user_id = $1', [userId]);
  await query('DELETE FROM stock_alerts_sent WHERE user_id = $1', [userId]);
  await query('DELETE FROM product_transactions WHERE user_id = $1', [userId]);
  await query('DELETE FROM products WHERE user_id = $1', [userId]);
  await query('DELETE FROM transactions WHERE user_id = $1', [userId]);
}

async function main() {
  console.log('█'.repeat(60));
  console.log('  BATCH 3 EXIT GATE — PUSHED INSIGHTS + GLOBAL SEND CAP');
  console.log('█'.repeat(60));

  const userId = await setupTestUser();
  await wipeTestData(userId);
  console.log(`✅ Test user ready: ${TEST_PHONE} (id ${userId})\n`);

  // ── 1. Budget enforcement ──────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log(`🏷️  Budget enforcement: ${WEEKLY_CAP} pushes exhausts the weekly cap`);

  for (let i = 0; i < WEEKLY_CAP; i++) {
    await recordPush(userId, 'test_push');
  }
  const underCap = await checkPushBudget(userId, 'test_push');
  check(`checkPushBudget returns false after ${WEEKLY_CAP} recorded pushes`, underCap === false, `got ${underCap}`);

  // ── 2. out_of_stock bypass ──────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  out_of_stock bypasses the cap even when it\'s spent');

  const bypassResult = await checkPushBudget(userId, 'out_of_stock');
  check('out_of_stock still returns true past the cap', bypassResult === true, `got ${bypassResult}`);

  await recordPush(userId, 'out_of_stock');
  const outOfStockLogged = await query(
    `SELECT COUNT(*)::int AS n FROM push_log WHERE user_id = $1 AND push_type = 'out_of_stock'`,
    [userId]
  );
  check('out_of_stock push is still logged for admin visibility', outOfStockLogged.rows[0].n === 1, JSON.stringify(outOfStockLogged.rows[0]));

  await wipeTestData(userId); // clear the budget-exhausting test_push rows before the live-path test
  await query('DELETE FROM push_log WHERE user_id = $1', [userId]);

  // ── 3. Live-path fix: logSaleHandler triggers a real low-stock alert ──────
  console.log('─'.repeat(60));
  console.log('🏷️  Live-path fix: Kemi\'s logSaleHandler now actually fires low-stock alerts');

  await logRestockHandler({
    product: 'LowStockWidget', quantity: 10, unit_cost: 100, whatsappNumber: TEST_PHONE,
  });
  // Sell 9 of 10 — stock/received = 0.10 < 0.20 threshold → low_stock
  await logSaleHandler({
    product: 'LowStockWidget', quantity: 9, unit_price: 200, whatsappNumber: TEST_PHONE,
  });
  // Give the non-blocking alert check a moment to complete
  await new Promise(r => setTimeout(r, 500));

  const lowStockPush = await query(
    `SELECT * FROM push_log WHERE user_id = $1 AND push_type = 'low_stock'`,
    [userId]
  );
  check('logSaleHandler triggered a real low_stock push_log row', lowStockPush.rows.length === 1, `found ${lowStockPush.rows.length} rows`);

  // ── 4. Weekly profit note honest degradation ──────────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Weekly profit note: >30% missing cost price triggers honest degradation');

  await wipeTestData(userId);

  // 2 products: one with cost price on file, one without
  await logRestockHandler({ product: 'WithCost', quantity: 5, unit_cost: 500, whatsappNumber: TEST_PHONE });
  await logSaleHandler({ product: 'WithCost', quantity: 1, unit_price: 1000, whatsappNumber: TEST_PHONE });
  await logSaleHandler({ product: 'NoCostA', quantity: 1, unit_price: 1000, whatsappNumber: TEST_PHONE });
  await logSaleHandler({ product: 'NoCostB', quantity: 1, unit_price: 1000, whatsappNumber: TEST_PHONE });

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const fraction = await getMissingCostFraction(userId, today, today);
  check('missing-cost fraction is > 30% (2 of 3 sold items have no cost price)', fraction > 0.30, `got ${fraction}`);

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
