'use strict';
/**
 * BIZPULSE — BATCH 1 EXIT GATE: DEBT CONSOLIDATION + REMINDERS
 * ══════════════════════════════════════════════════════════════
 * Run with:  node tests/debt_consolidation_test.js
 *
 * Exercises the real toolHandlers/models against a live Postgres — no mocks,
 * same bar as tests/unparseable_honesty_test.js (Batch 0's exit gate).
 * Doesn't call the Claude API: everything here is deterministic DB/handler
 * behavior, not NLP parsing, so the tool handlers are called directly.
 *
 * Covers (Batch 1 / A1-3, A2-3, A2-9):
 *   1. debt_payments is an append-only ledger — two partial payments then a
 *      "fully paid" (amount omitted) settles the true remainder, not the
 *      original total (the latent overpay bug this batch fixed).
 *   2. send_debt_reminder returns needs_phone when no contact is on file,
 *      then sends and links a customers row once customer_phone is supplied.
 *   3. A customer who opts out (STOP) is skipped on future reminders, even
 *      for a different debtor linked to the same phone number.
 *   4. A disputed debt is skipped on "remind all" and flagged honestly.
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config();

// Force WhatsAppService's dev-mode fallback (console log, no real API call)
// regardless of whether this environment has live Meta credentials — this
// test verifies debt/reminder/consent logic, not Meta connectivity or
// template-approval status. Set to '' rather than deleted: services/whatsapp.js
// calls require('dotenv').config() again on its own require, and dotenv only
// fills keys ABSENT from process.env — an empty string counts as present.
process.env.WHATSAPP_PHONE_NUMBER_ID = '';
process.env.WHATSAPP_TOKEN = '';

const { query } = require('../models/db');
const {
  logDebtHandler,
  settleDebtHandler,
  sendDebtReminderHandler,
} = require('../src/agent/toolHandlers');
const CustomerModel = require('../models/customer');

const TEST_PHONE = '2348033332222';
const CUSTOMER_PHONE = '2348099998888';

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
    VALUES ('Debt Test', 'debt.consolidation.test@bizpulse.test', 'Test Shop', 'Retail', $1, true)
    ON CONFLICT (whatsapp_number) DO UPDATE SET name = EXCLUDED.name
  `, [TEST_PHONE]);
  const res = await query('SELECT id FROM users WHERE whatsapp_number = $1', [TEST_PHONE]);
  return res.rows[0].id;
}

async function wipeTestData(userId) {
  await query(`DELETE FROM debt_payments WHERE debtor_id IN (SELECT id FROM debtors WHERE user_id = $1)`, [userId]);
  await query(`DELETE FROM debtors WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM customers WHERE user_id = $1`, [userId]);
}

async function getDebtor(userId, name) {
  const res = await query(
    `SELECT * FROM debtors WHERE user_id = $1 AND debtor_name = $2 ORDER BY created_at DESC LIMIT 1`,
    [userId, name]
  );
  return res.rows[0];
}

async function main() {
  console.log('█'.repeat(60));
  console.log('  BATCH 1 EXIT GATE — DEBT CONSOLIDATION + REMINDERS');
  console.log('█'.repeat(60));

  const userId = await setupTestUser();
  await wipeTestData(userId);
  console.log(`✅ Test user ready: ${TEST_PHONE} (id ${userId})\n`);

  // ── 1. Append-only ledger + fully-paid-after-partial bug fix ─────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Ledger: two partial payments then "fully paid" (amount omitted)');

  await logDebtHandler({ debtor_name: 'Emeka', amount: 10000, whatsappNumber: TEST_PHONE });
  await settleDebtHandler({ debtor_name: 'Emeka', amount: 4000, whatsappNumber: TEST_PHONE });
  await settleDebtHandler({ debtor_name: 'Emeka', amount: 3000, whatsappNumber: TEST_PHONE });

  let emeka = await getDebtor(userId, 'Emeka');
  let paymentsRes = await query('SELECT * FROM debt_payments WHERE debtor_id = $1 ORDER BY created_at', [emeka.id]);
  check('two payments recorded in debt_payments', paymentsRes.rows.length === 2, `got ${paymentsRes.rows.length}`);
  check('amount_paid matches ledger sum after partials', parseFloat(emeka.amount_paid) === 7000, `got ${emeka.amount_paid}`);
  check('status is partial after two partial payments', emeka.status === 'partial', `got ${emeka.status}`);

  const finalSettle = await settleDebtHandler({ debtor_name: 'Emeka', whatsappNumber: TEST_PHONE });
  emeka = await getDebtor(userId, 'Emeka');
  paymentsRes = await query('SELECT * FROM debt_payments WHERE debtor_id = $1', [emeka.id]);

  check('final settle reports fully_paid', finalSettle.fully_paid === true, JSON.stringify(finalSettle));
  check('final settle paid exactly the remainder (3000), not the original total', finalSettle.amount_paid === 3000, `got ${finalSettle.amount_paid}`);
  check('three payments recorded in debt_payments (no phantom overpay row)', paymentsRes.rows.length === 3, `got ${paymentsRes.rows.length}`);
  check('debtors.amount_paid settles at exactly 10000 (not 13000)', parseFloat(emeka.amount_paid) === 10000, `got ${emeka.amount_paid}`);
  check('status is paid', emeka.status === 'paid', `got ${emeka.status}`);

  // ── 2. Reminder: needs_phone → send → linked customer ────────────────────
  console.log('─'.repeat(60));
  console.log('🏷️  Reminder: needs_phone then send once a number is supplied');

  await logDebtHandler({ debtor_name: 'Chidi', amount: 5000, whatsappNumber: TEST_PHONE });

  const attempt1 = await sendDebtReminderHandler({ target: 'one', debtor_name: 'Chidi', whatsappNumber: TEST_PHONE });
  check('no phone on file → needs_phone', attempt1.needs_phone === true, JSON.stringify(attempt1));

  const attempt2 = await sendDebtReminderHandler({
    target: 'one', debtor_name: 'Chidi', customer_phone: CUSTOMER_PHONE, whatsappNumber: TEST_PHONE,
  });
  check('phone supplied → sent', attempt2.sent === true, JSON.stringify(attempt2));

  const linkedCustomer = await CustomerModel.findByPhone(userId, CUSTOMER_PHONE);
  check('customer row created and linked', !!linkedCustomer, 'no customers row found');
  check('new customer starts NOT opted out', linkedCustomer && linkedCustomer.opted_out === false, JSON.stringify(linkedCustomer));

  // ── 3. STOP opts the phone out globally — blocks a DIFFERENT debtor too ──
  console.log('─'.repeat(60));
  console.log('🏷️  STOP: opts the phone out, blocking reminders for any debtor linked to it');

  await CustomerModel.markOptedOutByPhone(CUSTOMER_PHONE);

  await logDebtHandler({ debtor_name: 'Bola', amount: 2000, whatsappNumber: TEST_PHONE });
  const attempt3 = await sendDebtReminderHandler({
    target: 'one', debtor_name: 'Bola', customer_phone: CUSTOMER_PHONE, whatsappNumber: TEST_PHONE,
  });
  check('reminder to opted-out number is skipped, even for a different debtor', attempt3.opted_out === true, JSON.stringify(attempt3));
  check('opted-out reminder is NOT reported as sent', attempt3.sent !== true, JSON.stringify(attempt3));

  // ── 4. DISPUTE — flags the debt and is skipped on "remind all" ───────────
  console.log('─'.repeat(60));
  console.log('🏷️  DISPUTE: flagged debt is skipped on target=all, not silently re-reminded');

  await logDebtHandler({ debtor_name: 'Ngozi', amount: 7500, whatsappNumber: TEST_PHONE });
  const ngoziContactPhone = '2348011112222';
  await sendDebtReminderHandler({
    target: 'one', debtor_name: 'Ngozi', customer_phone: ngoziContactPhone, whatsappNumber: TEST_PHONE,
  });
  const ngozi = await getDebtor(userId, 'Ngozi');
  await query(`UPDATE debtors SET disputed = true, disputed_at = NOW() WHERE id = $1`, [ngozi.id]);

  const remindAll = await sendDebtReminderHandler({ target: 'all', whatsappNumber: TEST_PHONE });
  check('disputed debtor appears in skipped_disputed on remind-all', remindAll.skipped_disputed.includes('Ngozi'), JSON.stringify(remindAll));
  check('disputed debtor is NOT in the sent list', !remindAll.sent.includes('Ngozi'), JSON.stringify(remindAll));

  await wipeTestData(userId);

  console.log('\n' + '█'.repeat(60));
  console.log(`  RESULT: ${passCount} passed, ${failCount} failed`);
  console.log('█'.repeat(60) + '\n');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
