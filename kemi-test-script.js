'use strict';
/**
 * BIZPULSE — KEMI AGENT TEST SCRIPT
 * ══════════════════════════════════════════════════════════════
 * Run with:  node kemi-test-script.js
 *
 * What this tests:
 *   - 7-day simulation with a real Nigerian trader profile
 *   - Daily message patterns (morning, midday, evening)
 *   - Evening digest generation each night
 *   - Weekly summary on Day 7
 *   - Skipped day (Day 4) — tests gap handling
 *   - Edge cases: ambiguous messages, corrections, pidgin,
 *     multi-item logs, debts, restocks, stockouts, goal setting
 *   - Stock intelligence triggers
 *   - Kemi tone and language mirroring
 *
 * Output: Full conversation log saved to kemi-test-output.json
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config();

const { runAgent }        = require('./src/agent/agentLoop');
const { generateDigest }  = require('./src/agent/digest');
const { query }           = require('./models/db');
const fs                  = require('fs');

// ── TEST TRADER PROFILE ──────────────────────────────────────
// Phone number without + prefix — matches how the system stores numbers
const TEST_PHONE = '2348031234567';
const TEST_TRADER = {
  whatsapp_number: TEST_PHONE,
  name: 'Ngozi',
  business_type: 'Provisions Store',
};

// ── SETUP: ensure test user exists in DB ─────────────────────
async function setupTestUser() {
  await query(`
    INSERT INTO users (name, email, biz_name, biz_type, whatsapp_number, active)
    VALUES ('Ngozi', 'ngozi.kemi.test@bizpulse.test', 'Mama Ngozi Provisions',
            'Provisions Store', $1, true)
    ON CONFLICT (whatsapp_number) DO UPDATE
      SET name = EXCLUDED.name, biz_type = EXCLUDED.biz_type
  `, [TEST_PHONE]);
  console.log('✅ Test user ready:', TEST_PHONE);
}

// ── HELPERS ──────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
let passCount = 0;
let failCount = 0;
let warnCount = 0;

async function sendMessage(label, message, options = {}) {
  const {
    expectContains = [],
    expectNotContains = [],
    day = null,
    time = null,
    category = 'general',
    note = '',
  } = options;

  console.log('\n' + '═'.repeat(60));
  if (day) console.log(`📅  DAY ${day}  ${time || ''}`);
  console.log(`🏷️  [${category.toUpperCase()}] ${label}`);
  console.log(`👤  Ngozi: "${message}"`);
  if (note) console.log(`📝  Note: ${note}`);
  console.log('─'.repeat(60));

  const startTime = Date.now();
  let response = '';
  let error = null;
  let passed = true;
  const failures = [];
  const warnings = [];

  try {
    response = await runAgent(TEST_PHONE, message);
    const latency = Date.now() - startTime;

    console.log(`🤖  Kemi: "${response}"`);
    console.log(`⏱️   Latency: ${latency}ms`);

    if (latency > 6000) {
      warnings.push(`Slow response: ${latency}ms (target <6000ms)`);
      warnCount++;
    }

    for (const expected of expectContains) {
      if (!response.toLowerCase().includes(expected.toLowerCase())) {
        failures.push(`Expected response to contain: "${expected}"`);
        passed = false;
      }
    }
    for (const notExpected of expectNotContains) {
      if (response.toLowerCase().includes(notExpected.toLowerCase())) {
        failures.push(`Response should NOT contain: "${notExpected}"`);
        passed = false;
      }
    }

    if (response.includes('**') || response.includes('###') || response.includes('---')) {
      failures.push('Response contains markdown — not WhatsApp safe');
      passed = false;
    }

    if (response.length > 1000) {
      warnings.push(`Response long: ${response.length} chars`);
      warnCount++;
    }

    if (passed) { console.log('✅  PASS'); passCount++; }
    else { console.log('❌  FAIL'); failures.forEach(f => console.log(`   → ${f}`)); failCount++; }
    warnings.forEach(w => console.log(`⚠️   ${w}`));

  } catch (err) {
    error = err.message;
    console.log(`💥  ERROR: ${err.message}`);
    failCount++;
    passed = false;
  }

  results.push({ label, message, response, error, day, time, category, note, passed, failures, warnings, latency: Date.now() - startTime });
  await sleep(800);
  return response;
}

async function runDigest(day) {
  console.log('\n' + '═'.repeat(60));
  console.log(`📱  DAY ${day} — EVENING DIGEST (8pm WAT)`);
  console.log('─'.repeat(60));

  try {
    const digest = await generateDigest(TEST_PHONE);
    const displayDigest = digest || '(No activity today — digest skipped)';
    console.log(`🤖  Kemi digest:\n"${displayDigest}"`);

    const failures = [];
    const warnings = [];
    let passed = true;

    if (digest) {
      if (digest.length > 800) warnings.push(`Digest long: ${digest.length} chars`);
      if (digest.includes('**') || digest.includes('###')) { failures.push('Digest contains markdown'); passed = false; }
      if (!digest.includes('₦') && !digest.includes('naira')) warnings.push('Digest has no naira figure');
    }

    if (passed) { console.log('✅  Digest PASS'); passCount++; }
    else { console.log('❌  Digest FAIL'); failures.forEach(f => console.log(`   → ${f}`)); failCount++; }
    warnings.forEach(w => console.log(`⚠️   ${w}`));

    results.push({ label: `Day ${day} Evening Digest`, message: '[DIGEST TRIGGER]', response: displayDigest, category: 'digest', passed, failures, warnings, day, time: '20:00' });
    await sleep(800);
    return displayDigest;
  } catch (err) {
    console.log(`💥  DIGEST ERROR: ${err.message}`);
    failCount++;
  }
}

// ════════════════════════════════════════════════════════════
// THE 7-DAY SIMULATION
// ════════════════════════════════════════════════════════════
async function runFullSimulation() {
  console.log('\n' + '█'.repeat(60));
  console.log('  BIZPULSE — KEMI AGENT 7-DAY TEST SIMULATION');
  console.log('  Trader: Mama Ngozi | Provisions Store | Lagos');
  console.log('█'.repeat(60));

  await setupTestUser();

  // ── DAY 1 ─────────────────────────────────────────────────
  await sendMessage('First ever message', 'Hello I want to start using bizpulse',
    { day: 1, time: '08:12', category: 'onboarding', expectContains: ['kemi', 'bizpulse'], expectNotContains: ['error', 'undefined'], note: 'First message — Kemi should introduce herself by name' });

  await sendMessage('Goal setting', 'I want to make 500k this month',
    { day: 1, time: '08:15', category: 'goal', expectContains: ['500'], note: 'Trader sets monthly revenue goal' });

  await sendMessage('Opening stock log — multi item pidgin', 'I don restock this morning. carry come 10 carton indomie, 5 carton peak milk, 20 bottle coke, 3 bag rice (50kg each)',
    { day: 1, time: '09:00', category: 'restock', expectContains: ['indomie', 'peak'], note: 'Multi-item restock in pidgin' });

  await sendMessage('First sale of the day', 'sell 3 carton indomie 4500',
    { day: 1, time: '10:30', category: 'sale', expectContains: ['indomie'], note: 'Basic sale — quantity + amount' });

  await sendMessage('Sale with customer name', 'Bisi buy 2 bottle coke and 1 peak milk. she pay 1800',
    { day: 1, time: '11:15', category: 'sale', expectContains: ['coke', 'peak'] });

  await sendMessage('Ambiguous amount — missing quantity', 'sold garri 3500',
    { day: 1, time: '12:00', category: 'edge_case', note: 'No quantity — Kemi should ask or assume 1 unit at 3500' });

  await sendMessage('Debt log — customer owing', 'Alhaji carry 1 bag rice, him say him go pay tomorrow',
    { day: 1, time: '13:30', category: 'debt', expectContains: ['alhaji', 'rice'], note: 'Classic credit sale — log as debt' });

  await sendMessage('Quick check midday', 'how I dey so far today?',
    { day: 1, time: '14:00', category: 'query', expectContains: ['₦'], note: 'Pidgin check-in — respond in pidgin with figures' });

  await sendMessage('Multi-item sale afternoon', 'sell 5 indomie, 2 peak milk, 4 coke. total 6200',
    { day: 1, time: '15:30', category: 'sale' });

  await sendMessage('Item normalisation — alias', 'sold 2 lappy for 280k',
    { day: 1, time: '16:00', category: 'normalisation', expectContains: ['laptop'], note: '"lappy" should normalise to Laptop. Kemi may ask to confirm before logging.' });

  await sendMessage('Item normalisation — case variation', 'restock: carry 6 Indomie carton come',
    { day: 1, time: '16:30', category: 'normalisation', expectContains: ['indomie'], note: 'Capital I — should match existing indomie not create duplicate' });

  await sendMessage('Closing sale', 'Last customer buy peak milk and indomie. 2200',
    { day: 1, time: '18:45', category: 'sale' });

  await runDigest(1);

  // ── DAY 2 ─────────────────────────────────────────────────
  await sendMessage('Morning opening', 'Good morning. I dey open now',
    { day: 2, time: '08:05', category: 'general', note: 'Kemi should respond warmly, maybe reference yesterday' });

  await sendMessage('Sale entry', 'sell indomie 15 carton 22500',
    { day: 2, time: '09:00', category: 'sale' });

  await sendMessage('Correction immediately after', 'wait that amount is wrong. it was 25000 not 22500',
    { day: 2, time: '09:01', category: 'correction', expectContains: ['25,000'], note: 'Immediate correction — fix last entry' });

  await sendMessage('Delete wrong entry', 'abeg remove that last one, I log am wrongly',
    { day: 2, time: '09:45', category: 'correction', expectContains: ['done'], note: 'Delete instruction in pidgin — Kemi may confirm in pidgin ("don remove", "done")' });

  await sendMessage('Alhaji pays debt partially', 'Alhaji come pay 3000. him still owe balance',
    { day: 2, time: '10:30', category: 'debt', expectContains: ['alhaji'], note: 'Partial payment — update balance not close debt' });

  await sendMessage('Bulk sale — market woman', 'sell 50 indomie carton to one market woman, she pay 70k cash',
    { day: 2, time: '11:00', category: 'sale', expectContains: ['indomie'], note: 'Large bulk — Kemi may flag stock constraint. Test just checks indomie is acknowledged.' });

  await sendMessage('Stock check after big sale', 'how many indomie I still get?',
    { day: 2, time: '11:05', category: 'stock_query', expectContains: ['indomie'], note: 'After large sale — should show remaining stock or stockout alert' });

  await sendMessage('Emergency restock', 'abeg restock indomie. I go market buy 30 carton. cost me 42000',
    { day: 2, time: '13:00', category: 'restock', expectContains: ['indomie', '30'] });

  await sendMessage('Expense — shop rent', 'pay shop rent 15000',
    { day: 2, time: '14:00', category: 'expense', expectContains: ['15,000', 'rent'] });

  await sendMessage('Expense — transport', 'spend 2500 on keke to market',
    { day: 2, time: '14:05', category: 'expense' });

  await sendMessage('Comparison query', 'today better than yesterday?',
    { day: 2, time: '16:00', category: 'comparison', expectContains: ['yesterday'] });

  await sendMessage('New item never seen before', 'sell 3 bottles zobo drink 1500',
    { day: 2, time: '17:00', category: 'normalisation', expectContains: ['zobo'] });

  await sendMessage('Completely unclear message', 'the thing wey I tell you about',
    { day: 2, time: '17:30', category: 'edge_case', note: 'Vague reference — should ask ONE clarifying question' });

  await runDigest(2);

  // ── DAY 3 ─────────────────────────────────────────────────
  await sendMessage('Slow morning complaint', 'sales slow today o. no customer since morning',
    { day: 3, time: '12:00', category: 'general', note: 'Venting — Kemi should be empathetic, maybe surface an insight' });

  await sendMessage('Small sale pidgin', 'one customer buy indomie 2 pack 600',
    { day: 3, time: '13:00', category: 'sale' });

  await sendMessage('New debt — different customer', 'Emeka carry 2 carton peak milk, him go pay friday',
    { day: 3, time: '14:00', category: 'debt', expectContains: ['emeka', 'peak'] });

  await sendMessage('Who owes me money', 'who still dey owe me money?',
    { day: 3, time: '15:00', category: 'debt_query', expectContains: ['alhaji', 'emeka'], note: 'Debt list query — should show all outstanding' });

  await sendMessage('Stock intelligence query', 'which one I need to restock soon?',
    { day: 3, time: '15:30', category: 'stock_intelligence', note: 'Should use materialized view data' });

  await sendMessage('Week so far check', 'how the week dey go so far?',
    { day: 3, time: '17:00', category: 'query', expectContains: ['₦'] });

  await sendMessage('Yoruba/local item name', 'sell eba customer 500',
    { day: 3, time: '17:30', category: 'normalisation', note: '"eba" = garri. Amount 500 no quantity — handle gracefully' });

  await runDigest(3);

  // ── DAY 4: SKIPPED ────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('📅  DAY 4 — THURSDAY: SKIPPED (no messages)');
  console.log('   Testing: digest should handle zero-activity day');
  console.log('═'.repeat(60));
  await runDigest(4);

  // ── DAY 5 ─────────────────────────────────────────────────
  await sendMessage('Return after skipped day', 'I dey back. yesterday I no well',
    { day: 5, time: '08:30', category: 'general', note: 'Return after gap — Kemi should acknowledge warmly, not lecture' });

  await sendMessage('Alhaji fully pays', 'Alhaji come clear everything. him pay remaining balance',
    { day: 5, time: '09:30', category: 'debt', expectContains: ['alhaji'], note: 'Full debt settlement' });

  await sendMessage('Emeka pays as promised', 'Emeka transfer the peak milk money now now',
    { day: 5, time: '10:00', category: 'debt', expectContains: ['emeka'] });

  await sendMessage('Voice-style transcription', 'sell five pack indomie two bottle peak three coke total four thousand two hundred',
    { day: 5, time: '11:00', category: 'voice_style', expectContains: ['indomie', 'peak', 'coke'], note: 'Words not numbers — simulates voice note transcript' });

  await sendMessage('USD payment edge case', 'that customer pay me 50 dollars for the laptop',
    { day: 5, time: '12:00', category: 'edge_case', note: 'USD payment — ask for naira equivalent or handle' });

  await sendMessage('Shop expense', 'buy broom 500 for shop',
    { day: 5, time: '13:00', category: 'edge_case', note: 'Shop expense not a sale — log correctly' });

  await sendMessage('Restock with supplier', 'Dangote supply man bring 10 bag cement 55000',
    { day: 5, time: '14:00', category: 'restock', expectContains: ['cement'] });

  await sendMessage('Goal progress check', 'how far my 500k target?',
    { day: 5, time: '17:00', category: 'goal_query', expectContains: ['500'] });

  await runDigest(5);

  // ── DAY 6 ─────────────────────────────────────────────────
  await sendMessage('Rapid log 1', 'sell indomie 5k', { day: 6, time: '09:00', category: 'sale' });
  await sendMessage('Rapid log 2', 'sell rice 12k',   { day: 6, time: '09:05', category: 'sale' });
  await sendMessage('Rapid log 3 — no verb', 'coke 3k',
    { day: 6, time: '09:07', category: 'sale', note: 'No verb — should infer sale' });

  await sendMessage('Multi-item CSV style', 'indomie 3500, peak milk 2200, biscuit 1800, pure water 500',
    { day: 6, time: '10:30', category: 'sale', note: 'Four items in CSV — all should be logged' });

  await sendMessage('Typo in item name', 'sell 2 botle ribena 1200',
    { day: 6, time: '11:00', category: 'normalisation', expectContains: ['ribena'], note: '"botle" typo — should still understand' });

  await sendMessage('Pidgin top seller query', 'which one sell pass today?',
    { day: 6, time: '13:00', category: 'query' });

  await sendMessage('Partial fulfilment', 'customer want 10 carton cement but I only get 5',
    { day: 6, time: '14:00', category: 'stock_intelligence', note: 'Stock constraint — flag it' });

  await sendMessage('Long ambiguous message',
    'abeg help me, I sell like 3 or 4 pack of the thing wey I restock yesterday, the indomie one, for maybe 1500 or 1600 I no remember well, and one customer still owe me change of 200',
    { day: 6, time: '15:00', category: 'edge_case', note: 'Highly ambiguous — ask ONE question, most important first' });

  await sendMessage('Best day claim', 'I think today na my best day this week',
    { day: 6, time: '19:00', category: 'general', note: 'Should confirm or deny with actual data' });

  await runDigest(6);

  // ── DAY 7 ─────────────────────────────────────────────────
  await sendMessage('Sunday low activity', 'small sales today. just 2 customer',
    { day: 7, time: '14:00', category: 'general' });

  await sendMessage('Sunday small sale', 'sell indomie and coke, 1800 total',
    { day: 7, time: '14:05', category: 'sale' });

  await sendMessage('Full week summary', 'give me full summary for the whole week',
    { day: 7, time: '16:00', category: 'weekly_summary', expectContains: ['week', '₦'] });

  await sendMessage('Restock advice', 'what I need to restock before monday market?',
    { day: 7, time: '16:30', category: 'stock_intelligence', note: 'Forward-looking — use velocity data' });

  await sendMessage('Slow movers query', 'anything wey I carry wey no dey sell?',
    { day: 7, time: '17:00', category: 'stock_intelligence' });

  await sendMessage('Emotional message', 'abeg Kemi I don tire. this business hard sometimes',
    { day: 7, time: '18:00', category: 'emotional', expectNotContains: ['error', 'tool', 'database'], note: 'Empathy — not a tool call' });

  await sendMessage('Next week goal', 'I wan try reach 600k next week. possible?',
    { day: 7, time: '18:30', category: 'goal', note: 'Kemi should check current pace and give honest assessment' });

  await runDigest(7);

  // ════════════════════════════════════════════════════════
  // EDGE CASE BATTERY
  // ════════════════════════════════════════════════════════
  console.log('\n\n' + '█'.repeat(60));
  console.log('  EDGE CASE BATTERY');
  console.log('█'.repeat(60));

  await sendMessage('Empty message', ' ',
    { category: 'edge_case', note: 'Blank — should not crash' });

  await sendMessage('Only numbers', '45000',
    { category: 'edge_case', note: 'Just a number — ask what it is for' });

  await sendMessage('Negative amount', 'sold goods -5000',
    { category: 'edge_case', note: 'Negative — handle gracefully' });

  await sendMessage('Extremely large amount', 'sell generator 2500000',
    { category: 'edge_case', note: 'Large amount — log with correct ₦ formatting' });

  await sendMessage('Mixed languages', 'Je veux acheter indomie, I sell am 500 sha',
    { category: 'edge_case', note: 'French + English + Pidgin' });

  await sendMessage('All caps', 'SELL RICE 15000 TODAY',
    { category: 'edge_case' });

  await sendMessage('Competitor mention', 'that shoprite near me dey sell indomie cheaper than me',
    { category: 'general' });

  await sendMessage('Out of scope request', 'abeg send money to my account',
    { category: 'edge_case', expectNotContains: ['error', 'crash'], note: 'Out of scope — decline gracefully' });

  await sendMessage('Yoruba food items', 'sell egusi and iru total 3500',
    { category: 'normalisation', note: 'Should map to canonical names' });

  await sendMessage('Kpomo spelling variation', 'sell kpomo 2500 and ponmo 1200',
    { category: 'normalisation', note: 'kpomo + ponmo = same item (cow skin). Should not create two separate items' });

  await sendMessage('Restock and sale same message', 'carry 10 carton malt come 18000. immediately sell 3 carton 6000',
    { category: 'restock', note: 'Both should be logged in one message' });

  await sendMessage('Business advice request', 'Kemi which product should I add to my shop?',
    { category: 'general', note: 'Use their sales data to inform answer' });

  // ════════════════════════════════════════════════════════
  // FINAL REPORT
  // ════════════════════════════════════════════════════════
  const totalTests = passCount + failCount;
  const passRate = totalTests > 0 ? ((passCount / totalTests) * 100).toFixed(1) : '0.0';

  console.log('\n\n' + '█'.repeat(60));
  console.log('  KEMI TEST RESULTS');
  console.log('█'.repeat(60));
  console.log(`\n  Total tests:  ${totalTests}`);
  console.log(`  ✅ Passed:    ${passCount}  (${passRate}%)`);
  console.log(`  ❌ Failed:    ${failCount}`);
  console.log(`  ⚠️  Warnings:  ${warnCount}`);

  if (failCount === 0)       console.log('\n  🎉 All tests passed — Kemi is ready for real traders!');
  else if (passRate >= 80)   console.log('\n  ⚡ Good pass rate — review failures before deploying');
  else                       console.log('\n  🔧 Significant failures — do not deploy until resolved');

  const categories = {};
  results.forEach(r => {
    if (!categories[r.category]) categories[r.category] = { pass: 0, fail: 0 };
    if (r.passed) categories[r.category].pass++;
    else categories[r.category].fail++;
  });

  console.log('\n  Results by category:');
  Object.entries(categories).forEach(([cat, counts]) => {
    const total = counts.pass + counts.fail;
    const rate  = ((counts.pass / total) * 100).toFixed(0);
    console.log(`  ${counts.fail > 0 ? '❌' : '✅'}  ${cat.padEnd(22)} ${counts.pass}/${total} (${rate}%)`);
  });

  const failed = results.filter(r => !r.passed);
  if (failed.length > 0) {
    console.log('\n  FAILED TESTS — fix before production:');
    failed.forEach((r, i) => {
      console.log(`\n  ${i + 1}. ${r.label}`);
      console.log(`     Message: "${r.message.substring(0, 60)}..."`);
      r.failures.forEach(f => console.log(`     → ${f}`));
    });
  }

  fs.writeFileSync('./kemi-test-output.json', JSON.stringify({ summary: { total: totalTests, passed: passCount, failed: failCount, warnings: warnCount, passRate: parseFloat(passRate), categories }, results }, null, 2));
  console.log('\n  Full output saved to: kemi-test-output.json');
  console.log('█'.repeat(60) + '\n');

  process.exit(failCount > 0 ? 1 : 0);
}

runFullSimulation().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
