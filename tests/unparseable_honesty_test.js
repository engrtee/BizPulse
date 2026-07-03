'use strict';
/**
 * BIZPULSE — A1-5 EXIT GATE: HONEST PARSE-FAILURE HANDLING
 * ══════════════════════════════════════════════════════════════
 * Run with:  node tests/unparseable_honesty_test.js
 *
 * Audit finding (A1-5, Phase A / NLP parsing failure handling):
 *   "verify every parse path has an explicit failure branch that tells
 *   the trader what wasn't understood and asks again. Flag any path
 *   that silently drops or guesses."
 *
 * This sends a battery of deliberately unparseable/ambiguous messages
 * to the REAL Kemi agent loop (src/agent/agentLoop.js runAgent — the
 * only live entry point since the legacy pipeline was deleted in A1-2)
 * and asserts, for each one:
 *
 *   1. Nothing was silently committed — transactions/product_transactions
 *      row counts for the test user are unchanged before vs after.
 *   2. Kemi's reply does not claim a successful log (no "✅" confirmation
 *      — that glyph is reserved for genuine commits per systemPrompt.js).
 *   3. Kemi's reply asks a clarifying question (contains "?") rather than
 *      staying silent or changing the subject.
 *
 * Requires a live DATABASE_URL + ANTHROPIC_API_KEY (real API calls —
 * same pattern as kemi-test-script.js and scripts/stress-test-parser.js).
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config();

const { runAgent } = require('../src/agent/agentLoop');
const { query }     = require('../models/db');

const TEST_PHONE = '2348022221111';

const CASES = [
  {
    label: 'Pure gibberish',
    message: 'asdkjfh qowin zzzxc random letters nothing meaningful',
  },
  {
    label: 'Vague reference to an earlier unspecified thing',
    message: 'the thing wey I tell you about',
  },
  {
    label: 'Bare number, no context',
    message: '45000',
  },
  {
    label: 'Contradictory action words, no amount or product',
    message: 'sell buy restock nothing something maybe',
  },
  {
    label: 'Rambling message with no extractable amount',
    message: 'abeg I no really sure sha, maybe I do something today or maybe I no do am, e complicated well well',
  },
];

async function setupTestUser() {
  // opening_stock_logged=true + a backdated first_message_date so Kemi treats this as an
  // established trader — otherwise the (correct, separate) "set up your opening stock first"
  // onboarding gate in systemPrompt.js overrides normal ambiguity-question behavior, which would
  // conflate two different product rules in this test.
  await query(`
    INSERT INTO users (name, email, biz_name, biz_type, whatsapp_number, active,
                        first_message_date, opening_stock_logged, opening_stock_logged_at)
    VALUES ('Honesty Test', 'honesty.kemi.test@bizpulse.test', 'Test Shop',
            'Provisions Store', $1, true, NOW() - INTERVAL '30 days', true, NOW() - INTERVAL '30 days')
    ON CONFLICT (whatsapp_number) DO UPDATE
      SET name = EXCLUDED.name, biz_type = EXCLUDED.biz_type,
          first_message_date = NOW() - INTERVAL '30 days',
          opening_stock_logged = true, opening_stock_logged_at = NOW() - INTERVAL '30 days'
  `, [TEST_PHONE]);
  const res = await query('SELECT id FROM users WHERE whatsapp_number = $1', [TEST_PHONE]);
  return res.rows[0].id;
}

async function wipeTestUserData(userId) {
  await query('DELETE FROM product_transactions WHERE user_id = $1', [userId]);
  await query('DELETE FROM transactions WHERE user_id = $1', [userId]);
  await query('DELETE FROM conversation_history WHERE whatsapp_number = $1', [TEST_PHONE]);
  await query('DELETE FROM trader_facts WHERE whatsapp_number = $1', [TEST_PHONE]);
}

async function entryCounts(userId) {
  const tx = await query('SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1', [userId]);
  const pt = await query('SELECT COUNT(*)::int AS n FROM product_transactions WHERE user_id = $1', [userId]);
  return { transactions: tx.rows[0].n, productTransactions: pt.rows[0].n };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('█'.repeat(60));
  console.log('  A1-5 EXIT GATE — HONEST PARSE-FAILURE HANDLING');
  console.log('█'.repeat(60));

  const userId = await setupTestUser();
  await wipeTestUserData(userId);
  console.log(`✅ Test user ready: ${TEST_PHONE} (id ${userId})\n`);

  let passCount = 0;
  let failCount = 0;

  for (const { label, message } of CASES) {
    console.log('─'.repeat(60));
    console.log(`🏷️  ${label}`);
    console.log(`👤  "${message}"`);

    const before = await entryCounts(userId);
    let response;
    try {
      response = await runAgent(TEST_PHONE, message);
    } catch (err) {
      console.log(`💥 runAgent threw: ${err.message}`);
      failCount++;
      continue;
    }
    const after = await entryCounts(userId);

    console.log(`🤖  Kemi: "${response}"`);

    const failures = [];

    if (after.transactions !== before.transactions || after.productTransactions !== before.productTransactions) {
      failures.push(
        `Silent commit detected — transactions ${before.transactions}→${after.transactions}, ` +
        `product_transactions ${before.productTransactions}→${after.productTransactions}`
      );
    }

    if (response.includes('✅')) {
      failures.push('Reply contains a "✅" success confirmation for an unparseable message');
    }

    // Substance, not punctuation: the audit finding (A1-5) requires Kemi to name what she needs
    // and invite the trader to supply it — a literal "?" is one way to do that but not the only
    // one ("just tell me the product name and whether na sale or restock" satisfies it too).
    const invitesClarification = /\?|tell me|let me know|which one|what happened/i.test(response);
    if (!invitesClarification) {
      failures.push('Reply neither asks a question nor invites clarification');
    }

    if (failures.length === 0) {
      console.log('✅  PASS');
      passCount++;
    } else {
      console.log('❌  FAIL');
      failures.forEach(f => console.log(`   → ${f}`));
      failCount++;
    }

    await sleep(800);
  }

  await wipeTestUserData(userId);

  console.log('\n' + '█'.repeat(60));
  console.log(`  RESULT: ${passCount}/${CASES.length} passed, ${failCount} failed`);
  console.log('█'.repeat(60) + '\n');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
