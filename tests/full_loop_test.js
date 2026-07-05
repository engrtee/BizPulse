'use strict';
/**
 * BIZPULSE — BATCH 5 EXIT GATE: FULL-LOOP INTERLOCK PROOF
 * ══════════════════════════════════════════════════════════════
 * Run with:  node tests/full_loop_test.js
 *
 * Every prior batch (0-4) has its own exit-gate test proving that batch's
 * feature works in isolation. This test is different on purpose: it drives
 * ONE continuous trader lifecycle through the interlocks that connect what
 * those batches built, in the order a real trader would actually hit them —
 * proving the pieces hold together as a system, not just individually.
 *
 * The loop:
 *   1. Photo-in confirmation (Batch 4) sets opening stock
 *   2. A cash sale and a credit sale (existing Kemi tools) — the credit sale
 *      creates a debtor automatically
 *   3. generate_receipt (Batch 2) for a cash sale, then for a credit sale —
 *      the credit receipt creates a SECOND debtor (Edge 1<->2, forward)
 *   4. send_debt_reminder (Batch 1) — needs_phone, then sent once supplied
 *   5. settle_debt in full on the OTHER debtor — auto-generates a receipt
 *      (Edge 1<->2, reverse) via the Batch-1-stubbed, Batch-4-real hook
 *   6. Receipt sequence numbers from steps 3 and 5 must be strictly
 *      increasing across BOTH trigger paths (manual tool call and the
 *      automatic debt-payoff hook) — proof the shared counter is one
 *      system, not two coincidentally-similar ones.
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config();

process.env.WHATSAPP_PHONE_NUMBER_ID = '';
process.env.WHATSAPP_TOKEN = '';

const { query } = require('../models/db');
const {
  stagePhotoStockEntryHandler,
  confirmPendingStockEntryHandler,
  logSaleHandler,
  generateReceiptHandler,
  sendDebtReminderHandler,
  settleDebtHandler,
} = require('../src/agent/toolHandlers');

const TEST_PHONE = '2348022223344';
const NGOZI_PHONE = '2348033334455';

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
    VALUES ('Full Loop Test', 'full.loop.test@bizpulse.test', 'Loop Test Shop', 'Retail', $1, true)
    ON CONFLICT (whatsapp_number) DO UPDATE SET name = EXCLUDED.name
  `, [TEST_PHONE]);
  const res = await query('SELECT * FROM users WHERE whatsapp_number = $1', [TEST_PHONE]);
  return res.rows[0];
}

async function wipeTestData(userId) {
  await query('DELETE FROM receipts WHERE user_id = $1', [userId]);
  await query('DELETE FROM receipt_counters WHERE user_id = $1', [userId]);
  await query('DELETE FROM debt_payments WHERE debtor_id IN (SELECT id FROM debtors WHERE user_id = $1)', [userId]);
  await query('DELETE FROM debtors WHERE user_id = $1', [userId]);
  await query('DELETE FROM customers WHERE user_id = $1', [userId]);
  await query('DELETE FROM pending_entries WHERE user_id = $1', [userId]);
  await query('DELETE FROM push_log WHERE user_id = $1', [userId]);
  await query('DELETE FROM product_transactions WHERE user_id = $1', [userId]);
  await query('DELETE FROM products WHERE user_id = $1', [userId]);
  await query('DELETE FROM transactions WHERE user_id = $1', [userId]);
}

async function main() {
  console.log('█'.repeat(60));
  console.log('  BATCH 5 EXIT GATE — FULL-LOOP INTERLOCK PROOF');
  console.log('█'.repeat(60));

  const user = await setupTestUser();
  await wipeTestData(user.id);
  console.log(`✅ Test user ready: ${TEST_PHONE} (id ${user.id})\n`);

  // ── 1. Photo-in confirmation sets opening stock (Batch 4) ─────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Step 1 — Photo-in: stage opening stock, then confirm it');

  await stagePhotoStockEntryHandler({
    items: [{ product: 'Ankara Fabric', quantity: 30, unit: 'yards', unit_cost: 3000 }],
    whatsappNumber: TEST_PHONE,
  });
  const productsBeforeConfirm = await query('SELECT COUNT(*)::int n FROM products WHERE user_id = $1', [user.id]);
  check('staging alone creates no product row', productsBeforeConfirm.rows[0].n === 0, `found ${productsBeforeConfirm.rows[0].n}`);

  const openingStock = await confirmPendingStockEntryHandler({ action: 'confirm', whatsappNumber: TEST_PHONE });
  check('opening stock confirmed', openingStock.confirmed === true, JSON.stringify(openingStock));

  // ── 2. Cash sale + credit sale (existing Kemi tools) ───────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Step 2 — Cash sale, then a credit sale (auto-creates a debtor)');

  const cashSale = await logSaleHandler({
    product: 'Ankara Fabric', quantity: 5, unit: 'yards', unit_price: 6000,
    whatsappNumber: TEST_PHONE,
  });
  check('cash sale succeeds', cashSale.success === true, JSON.stringify(cashSale));

  const creditSale = await logSaleHandler({
    product: 'Ankara Fabric', quantity: 3, unit: 'yards', unit_price: 6000,
    customer_name: 'Ngozi', is_credit: true,
    whatsappNumber: TEST_PHONE,
  });
  check('credit sale succeeds', creditSale.success === true && creditSale.is_credit === true, JSON.stringify(creditSale));

  const ngoziDebt = await query(`SELECT * FROM debtors WHERE user_id = $1 AND debtor_name = 'Ngozi'`, [user.id]);
  check('credit sale auto-created a debtor for Ngozi', ngoziDebt.rows.length === 1 && parseFloat(ngoziDebt.rows[0].amount) === 18000, JSON.stringify(ngoziDebt.rows[0]));

  // ── 3. generate_receipt: cash, then credit (Edge 1<->2 forward) ────────
  console.log('─'.repeat(60));
  console.log('🏷️  Step 3 — Receipts: cash (no debtor), then credit for Bola (creates one)');

  const cashReceipt = await generateReceiptHandler({
    customer_name: 'Walk-in customer',
    items: [{ product: 'Ankara Fabric', quantity: 2, unit_price: 6000 }],
    payment_method: 'cash',
    whatsappNumber: TEST_PHONE,
  });
  check('cash receipt generated, no debtor', cashReceipt.generated === true && cashReceipt.debtor_created === false, JSON.stringify(cashReceipt));

  const creditReceipt = await generateReceiptHandler({
    customer_name: 'Bola',
    items: [{ product: 'Ankara Fabric', quantity: 4, unit_price: 6000 }],
    payment_method: 'credit',
    whatsappNumber: TEST_PHONE,
  });
  check('credit receipt generated AND created a debtor (Edge 1<->2 forward)', creditReceipt.generated === true && creditReceipt.debtor_created === true, JSON.stringify(creditReceipt));

  const bolaDebt = await query(`SELECT * FROM debtors WHERE user_id = $1 AND debtor_name = 'Bola'`, [user.id]);
  check('Bola debtor exists with matching amount', bolaDebt.rows.length === 1 && parseFloat(bolaDebt.rows[0].amount) === 24000, JSON.stringify(bolaDebt.rows[0]));

  check('receipt sequence numbers increase across calls (1, 2)', creditReceipt.sequence_number === cashReceipt.sequence_number + 1, `cash=${cashReceipt.sequence_number} credit=${creditReceipt.sequence_number}`);

  // ── 4. send_debt_reminder — needs_phone then sent ──────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Step 4 — Debt reminder for Ngozi: needs_phone, then sent once supplied');

  const reminderAttempt1 = await sendDebtReminderHandler({ target: 'one', debtor_name: 'Ngozi', whatsappNumber: TEST_PHONE });
  check('first reminder attempt needs a phone number', reminderAttempt1.needs_phone === true, JSON.stringify(reminderAttempt1));

  const reminderAttempt2 = await sendDebtReminderHandler({
    target: 'one', debtor_name: 'Ngozi', customer_phone: NGOZI_PHONE, whatsappNumber: TEST_PHONE,
  });
  check('reminder sent once phone supplied', reminderAttempt2.sent === true, JSON.stringify(reminderAttempt2));

  // ── 5. settle_debt in full on Bola — auto-generates a receipt (reverse) ─
  console.log('─'.repeat(60));
  console.log('🏷️  Step 5 — Settle Bola\'s debt in full: auto-generates a receipt (Edge 1<->2 reverse)');

  const settle = await settleDebtHandler({ debtor_name: 'Bola', whatsappNumber: TEST_PHONE });
  check('Bola\'s debt settled in full', settle.settled === true && settle.fully_paid === true, JSON.stringify(settle));

  // give the fire-and-forget receipt hook a moment
  await new Promise(r => setTimeout(r, 500));

  const autoReceipt = await query(
    `SELECT * FROM receipts WHERE user_id = $1 AND customer_name = 'Bola' AND payment_method = 'cash' ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  check('a cash receipt was auto-generated for the debt payoff', autoReceipt.rows.length === 1, `found ${autoReceipt.rows.length}`);
  check('auto-generated receipt sequence continues past the manual ones (3)', autoReceipt.rows[0]?.sequence_number === creditReceipt.sequence_number + 1, `got ${autoReceipt.rows[0]?.sequence_number}`);

  await wipeTestData(user.id);
  await query('DELETE FROM users WHERE id = $1', [user.id]);

  console.log('\n' + '█'.repeat(60));
  console.log(`  RESULT: ${passCount} passed, ${failCount} failed`);
  console.log('█'.repeat(60) + '\n');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
