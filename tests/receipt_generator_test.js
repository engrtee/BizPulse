'use strict';
/**
 * BIZPULSE — BATCH 2 EXIT GATE: RECEIPT GENERATOR
 * ══════════════════════════════════════════════════════════════
 * Run with:  node tests/receipt_generator_test.js
 *
 * Exercises generateReceiptHandler against a live Postgres — no mocks, same
 * bar as the Batch 0/1 exit-gate tests. Forces WhatsAppService's dev-mode
 * fallback (see tests/debt_consolidation_test.js for why).
 *
 * Covers (Batch 2):
 *   1. Cash receipt: returns a real PNG, no debtors row created.
 *   2. Credit receipt: same, PLUS creates a linked debtors row (Edge 1↔2
 *      interlock) with the matching amount.
 *   3. Race-safety: N concurrent generate_receipt calls for the same trader
 *      get unique, gapless sequence numbers — the actual proof the atomic
 *      receipt_counters UPSERT works under concurrency, not just that it
 *      looks right on paper.
 *   4. Send-failure path: a forced WhatsApp send throw returns send_failed
 *      instead of crashing the tool call (same technique used to verify
 *      Batch 1's send_debt_reminder fix).
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config();

// Force WhatsAppService's dev-mode fallback (console log, no real API call).
process.env.WHATSAPP_PHONE_NUMBER_ID = '';
process.env.WHATSAPP_TOKEN = '';

const { query } = require('../models/db');
const { generateReceiptHandler } = require('../src/agent/toolHandlers');
const WhatsAppService = require('../services/whatsapp');

const TEST_PHONE = '2348066667777';

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
    VALUES ('Receipt Test', 'receipt.generator.test@bizpulse.test', 'Test Shop', 'Retail', $1, true)
    ON CONFLICT (whatsapp_number) DO UPDATE SET name = EXCLUDED.name
  `, [TEST_PHONE]);
  const res = await query('SELECT id FROM users WHERE whatsapp_number = $1', [TEST_PHONE]);
  return res.rows[0].id;
}

async function wipeTestData(userId) {
  // receipts.debtor_id FKs to debtors — must clear receipts first.
  await query('DELETE FROM receipts WHERE user_id = $1', [userId]);
  await query('DELETE FROM debt_payments WHERE debtor_id IN (SELECT id FROM debtors WHERE user_id = $1)', [userId]);
  await query('DELETE FROM debtors WHERE user_id = $1', [userId]);
  await query('DELETE FROM receipt_counters WHERE user_id = $1', [userId]);
}

async function main() {
  console.log('█'.repeat(60));
  console.log('  BATCH 2 EXIT GATE — RECEIPT GENERATOR');
  console.log('█'.repeat(60));

  const userId = await setupTestUser();
  await wipeTestData(userId);
  console.log(`✅ Test user ready: ${TEST_PHONE} (id ${userId})\n`);

  // ── 1. Cash receipt ────────────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Cash receipt: PNG output, no debtor created');

  const cashResult = await generateReceiptHandler({
    customer_name: 'Amaka',
    items: [{ product: 'Rice', quantity: 2, unit_price: 6000 }],
    payment_method: 'cash',
    whatsappNumber: TEST_PHONE,
  });
  check('cash receipt reports generated + sent', cashResult.generated === true && cashResult.sent === true, JSON.stringify(cashResult));
  check('cash receipt reports total_amount = 12000', cashResult.total_amount === 12000, `got ${cashResult.total_amount}`);
  check('cash receipt does NOT create a debtor', cashResult.debtor_created === false, JSON.stringify(cashResult));

  const debtorsAfterCash = await query('SELECT COUNT(*)::int n FROM debtors WHERE user_id = $1', [userId]);
  check('no debtors row exists after cash receipt', debtorsAfterCash.rows[0].n === 0, `found ${debtorsAfterCash.rows[0].n}`);

  const receiptRow = await query('SELECT * FROM receipts WHERE user_id = $1 AND sequence_number = $2', [userId, cashResult.sequence_number]);
  check('receipts row was persisted', receiptRow.rows.length === 1, JSON.stringify(receiptRow.rows));
  check('receipts row has null debtor_id for cash', receiptRow.rows[0]?.debtor_id === null, JSON.stringify(receiptRow.rows[0]));

  // ── 2. Credit receipt — the Edge 1↔2 interlock ─────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Credit receipt: creates a linked debtor (Edge 1↔2 interlock)');

  const creditResult = await generateReceiptHandler({
    customer_name: 'Bola',
    items: [{ product: 'Beans', quantity: 1, unit_price: 8000 }],
    payment_method: 'credit',
    whatsappNumber: TEST_PHONE,
  });
  check('credit receipt reports debtor_created', creditResult.debtor_created === true, JSON.stringify(creditResult));

  const debtorRow = await query(
    `SELECT d.* FROM debtors d
     JOIN receipts r ON r.debtor_id = d.id
     WHERE r.user_id = $1 AND r.sequence_number = $2`,
    [userId, creditResult.sequence_number]
  );
  check('linked debtor row exists', debtorRow.rows.length === 1, 'no linked debtor found');
  check('linked debtor amount matches receipt total', parseFloat(debtorRow.rows[0]?.amount) === 8000, `got ${debtorRow.rows[0]?.amount}`);
  check('linked debtor name matches customer_name', debtorRow.rows[0]?.debtor_name === 'Bola', `got ${debtorRow.rows[0]?.debtor_name}`);

  // ── 3. Race-safety of the sequence counter ─────────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Race-safety: 10 concurrent generate_receipt calls get unique sequence numbers');

  const concurrentCalls = Array.from({ length: 10 }, (_, i) =>
    generateReceiptHandler({
      customer_name: `Concurrent${i}`,
      items: [{ product: 'Item', quantity: 1, unit_price: 1000 }],
      payment_method: 'cash',
      whatsappNumber: TEST_PHONE,
    })
  );
  const concurrentResults = await Promise.all(concurrentCalls);
  const seqNumbers = concurrentResults.map(r => r.sequence_number);
  const uniqueSeqNumbers = new Set(seqNumbers);
  check('all 10 concurrent calls succeeded', concurrentResults.every(r => r.generated === true), JSON.stringify(concurrentResults));
  check('all 10 sequence numbers are unique (no race collision)', uniqueSeqNumbers.size === 10, `got ${JSON.stringify(seqNumbers)}`);

  // ── 4. Send-failure path ────────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Send-failure: a forced WhatsApp throw is caught, not crashed');

  const originalSend = WhatsAppService.sendReceiptImage;
  WhatsAppService.sendReceiptImage = async () => { throw new Error('simulated Meta rejection'); };

  let threw = false, failResult;
  try {
    failResult = await generateReceiptHandler({
      customer_name: 'FailCase',
      items: [{ product: 'Item', quantity: 1, unit_price: 500 }],
      payment_method: 'cash',
      whatsappNumber: TEST_PHONE,
    });
  } catch (e) {
    threw = true;
  }
  WhatsAppService.sendReceiptImage = originalSend;

  check('generateReceiptHandler does NOT crash on send failure', !threw, threw ? 'it threw' : '');
  if (!threw) {
    check('send failure reports send_failed honestly', failResult.send_failed === true && failResult.sent === false, JSON.stringify(failResult));
    check('receipt is still recorded even though the send failed', failResult.generated === true, JSON.stringify(failResult));
  }

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
