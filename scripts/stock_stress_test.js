/**
 * scripts/stock_stress_test.js
 *
 * BizPulse Stock Intelligence Stress Test
 * 15 trader scenarios — real Gemini parser, real PostgreSQL, no mocks.
 *
 * Run: node scripts/stock_stress_test.js
 * Report saved to: reports/stress_test_YYYY-MM-DDTHH-MM-SS.txt
 *
 * DO NOT auto-fix failures. Report only.
 */

'use strict';

require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const { query }        = require('../models/db');
const GeminiService    = require('../services/gemini');
const ProductService   = require('../services/productService');
const ProductModel     = require('../models/product');
const InventoryService = require('../services/inventory');
const TransactionModel = require('../models/transaction');

// todayWAT is used by processProductTransactions date param
function todayWAT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

// ── NullWhatsApp: swallow every outgoing message ───────────────────────────
const NullWhatsApp = {
  sendMessage:    async () => {},
  sendEntryAck:   async () => {},
  sendMilestone:  async () => {},
  sendStockReply: async () => {},
  sendHelp:       async () => {},
  sendNotRegistered: async () => {},
};

// ── Report state ───────────────────────────────────────────────────────────
const lines = [];
let passed = 0, failed = 0, warned = 0, skipped = 0;

function log(line = '') {
  console.log(line);
  lines.push(line);
}
function pass(label, detail = '') {
  passed++;
  log(`  ✅ PASS   ${label}${detail ? `  [${detail}]` : ''}`);
}
function fail(label, expected, actual) {
  failed++;
  log(`  ❌ FAIL   ${label}  expected=${JSON.stringify(expected)}  got=${JSON.stringify(actual)}`);
}
function warn(label, detail = '') {
  warned++;
  log(`  ⚠️  WARN   ${label}${detail ? `  [${detail}]` : ''}`);
}
function skip(label, reason = '') {
  skipped++;
  log(`  ⏭️  SKIP   ${label}${reason ? `  [${reason}]` : ''}`);
}

// ── 500ms pause between messages ──────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Upsert test user (safe for repeated runs) ──────────────────────────────
async function upsertTestUser({ phone, name, bizName, bizType, state }) {
  const found = await query(`SELECT * FROM users WHERE whatsapp_number = $1 LIMIT 1`, [phone]);
  if (found.rows[0]) {
    await query(
      `UPDATE users SET name=$1, biz_name=$2, biz_type=$3, state=$4, active=true WHERE id=$5`,
      [name, bizName, bizType, state, found.rows[0].id]
    );
    return { ...found.rows[0], name, biz_name: bizName, biz_type: bizType, state, opening_stock_logged: false };
  }
  const email = `stress.${phone}@bizpulse.test`;
  await query(`DELETE FROM users WHERE email = $1`, [email]);
  const res = await query(
    `INSERT INTO users
       (name, email, biz_name, biz_type, state, whatsapp_number, active, first_message_date)
     VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
     RETURNING *`,
    [name, email, bizName, bizType, state, phone]
  );
  return res.rows[0];
}

// ── Clean all test data for a user before each scenario ───────────────────
async function cleanUser(userId) {
  await query(`DELETE FROM stock_alerts_sent   WHERE user_id = $1`, [userId]).catch(() => {});
  await query(`DELETE FROM product_transactions WHERE user_id = $1`, [userId]).catch(() => {});
  await query(`DELETE FROM products             WHERE user_id = $1`, [userId]).catch(() => {});
  await query(`DELETE FROM transactions         WHERE user_id = $1`, [userId]).catch(() => {});
  await query(`DELETE FROM pending_entries      WHERE user_id = $1`, [userId]).catch(() => {});
  await query(`DELETE FROM ai_inference_log     WHERE user_id = $1`, [userId]).catch(() => {});
  await query(`DELETE FROM parse_corrections    WHERE user_id = $1`, [userId]).catch(() => {});
}

// ── DB query helpers ───────────────────────────────────────────────────────
async function getProduct(userId, keyword) {
  const res = await query(
    `SELECT * FROM products
     WHERE user_id = $1
       AND is_active = true
       AND (LOWER(product_name) LIKE LOWER($2) OR LOWER(product_name_normalized) LIKE LOWER($2))
     ORDER BY id LIMIT 1`,
    [userId, `%${keyword}%`]
  );
  return res.rows[0] || null;
}

async function getActiveProductCount(userId) {
  const res = await query(
    `SELECT COUNT(*) FROM products WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  return parseInt(res.rows[0].count, 10);
}

async function getTotalRevenue(userId) {
  const res = await query(
    `SELECT COALESCE(SUM(revenue), 0) AS total FROM transactions WHERE user_id = $1`,
    [userId]
  );
  return parseFloat(res.rows[0].total);
}

async function getSaleTxCount(userId, keyword) {
  const prod = await getProduct(userId, keyword);
  if (!prod) return 0;
  const res = await query(
    `SELECT COUNT(*) FROM product_transactions
     WHERE product_id = $1 AND transaction_type = 'sale'`,
    [prod.id]
  );
  return parseInt(res.rows[0].count, 10);
}

async function getLastSaleChannel(userId, keyword) {
  const prod = await getProduct(userId, keyword);
  if (!prod) return null;
  const res = await query(
    `SELECT channel FROM product_transactions
     WHERE product_id = $1 AND transaction_type = 'sale'
     ORDER BY created_at DESC LIMIT 1`,
    [prod.id]
  );
  return res.rows[0]?.channel || null;
}

// ── Core: parse message with real Gemini then write to DB ─────────────────
async function processMessage(user, text) {
  log(`     📨  "${text}"`);
  const aiResult = await GeminiService.parseWithAI(text, user);
  const type = aiResult.type || 'unknown';
  log(`     🤖  → ${type}`);
  const date = todayWAT();

  switch (type) {
    case 'opening_stock': {
      const products = aiResult.products || [];
      if (products.length > 0) {
        await ProductService.setOpeningStock(user.id, products);
      }
      break;
    }
    case 'inventory_in': {
      const hasProds = Array.isArray(aiResult.products) && aiResult.products.length > 0;
      if (hasProds) {
        await ProductService.processProductTransactions(user.id, user, aiResult.products, null, date, NullWhatsApp);
      } else if (aiResult.item && aiResult.quantity) {
        await InventoryService.receiveStock(user, aiResult);
      }
      break;
    }
    case 'inventory_out': {
      const hasProds = Array.isArray(aiResult.products) && aiResult.products.length > 0;
      if (hasProds) {
        await ProductService.processProductTransactions(user.id, user, aiResult.products, null, date, NullWhatsApp);
      } else if (aiResult.item && aiResult.quantity) {
        await InventoryService.sellStock(user, aiResult);
      }
      break;
    }
    case 'daily_entry': {
      const tx = await TransactionModel.create({
        userId:          user.id,
        revenue:         aiResult.revenue         || 0,
        totalExpenses:   aiResult.totalExpenses   || 0,
        expenseBreakdown: aiResult.expenseBreakdown || {},
        profit:          aiResult.profit          || 0,
        margin:          aiResult.margin          || 0,
        customers:       aiResult.customers       || 0,
        notes:           text,
        rawMessage:      text,
        entryMethod:     'text',
      });
      if (Array.isArray(aiResult.products) && aiResult.products.length > 0) {
        await ProductService.processProductTransactions(
          user.id, user, aiResult.products, tx?.id || null, date, NullWhatsApp
        );
      }
      break;
    }
    case 'stock_zero': {
      const rawName = aiResult.product_name;
      if (rawName) {
        const found = await ProductService.findProductFuzzy(user.id, rawName);
        if (found) await ProductService.zeroProductStock(user.id, found.id, date);
      }
      break;
    }
    default:
      log(`     ⚠️   Unrouted type: ${type}`);
  }

  return aiResult;
}

// ═════════════════════════════════════════════════════════════════════════════
// TRADER SCENARIOS
// ═════════════════════════════════════════════════════════════════════════════

async function trader01() {
  log('\n━━━ Trader 01 — Fatima (Opening stock declaration, Lagos, FMCG) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000001', name: 'Fatima Ibrahim',
    bizName: "Fatima's Store", bizType: 'FMCG', state: 'Lagos',
  });
  await cleanUser(user.id);

  await processMessage(user, 'I have 50 bags of rice and 30 cartons of indomie');
  await sleep(500);

  const rice    = await getProduct(user.id, 'rice');
  const indomie = await getProduct(user.id, 'indomie');

  if (!rice)    fail('Rice product created',    true, false);
  else rice.current_stock == 50    ? pass('Rice stock=50',    `got ${rice.current_stock}`)    : fail('Rice stock=50',    50, rice.current_stock);

  if (!indomie) fail('Indomie product created', true, false);
  else indomie.current_stock == 30 ? pass('Indomie stock=30', `got ${indomie.current_stock}`) : fail('Indomie stock=30', 30, indomie.current_stock);
}

async function trader02() {
  log('\n━━━ Trader 02 — Chidi (Restock + sell, Abuja, Electronics) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000002', name: 'Chidi Okonkwo',
    bizName: 'Chidi Electronics', bizType: 'Retail', state: 'Abuja',
  });
  await cleanUser(user.id);

  await processMessage(user, 'received 20 iPhone 14 at 850000 each');
  await sleep(500);
  await processMessage(user, 'sold 3 iPhone 14 at 980000 each');
  await sleep(500);

  const prod = await getProduct(user.id, 'iphone');
  if (!prod) { fail('iPhone product created', true, false); return; }

  prod.current_stock == 17
    ? pass('RESTOCK+DEDUCTION: iPhone stock=17', `got ${prod.current_stock}`)
    : fail('iPhone stock=17', 17, prod.current_stock);

  const revenue = await getTotalRevenue(user.id);
  Math.abs(revenue - 2940000) < 1
    ? pass('REVENUE: ₦2,940,000', `got ₦${revenue.toLocaleString('en-NG')}`)
    : fail('REVENUE: ₦2,940,000', 2940000, revenue);
}

async function trader03() {
  log('\n━━━ Trader 03 — Amina (Ankara fabric, Kano, Fashion) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000003', name: 'Amina Sule',
    bizName: "Amina's Fabric", bizType: 'Fashion', state: 'Kano',
  });
  await cleanUser(user.id);

  await processMessage(user, 'received 40 yards ankara at 4500 per yard');
  await sleep(500);
  await processMessage(user, 'I sell 10 yards ankara for 6500 each');
  await sleep(500);

  const ankara = await getProduct(user.id, 'ankara');
  if (!ankara) { fail('Ankara product created', true, false); return; }

  ankara.current_stock == 30
    ? pass('STOCK_DEDUCTION: Ankara stock=30', `got ${ankara.current_stock}`)
    : fail('Ankara stock=30', 30, ankara.current_stock);

  const revenue = await getTotalRevenue(user.id);
  Math.abs(revenue - 65000) < 1
    ? pass('REVENUE: ₦65,000', `got ₦${revenue.toLocaleString('en-NG')}`)
    : fail('REVENUE: ₦65,000', 65000, revenue);
}

async function trader04() {
  log('\n━━━ Trader 04 — Emeka (FMCG Pidgin bulk, Anambra) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000004', name: 'Emeka Nwosu',
    bizName: 'Emeka Wholesale', bizType: 'FMCG', state: 'Anambra',
  });
  await cleanUser(user.id);

  await processMessage(user, 'got 100 carton indomie at 3800 each');
  await sleep(500);
  // FMCG pattern: quantity × price = total (no "sold" keyword)
  await processMessage(user, 'indomie 80 carton 4200 each = 336000');
  await sleep(500);

  const indomie = await getProduct(user.id, 'indomie');
  if (!indomie) { fail('Indomie product created', true, false); return; }

  indomie.current_stock == 20
    ? pass('STOCK_DEDUCTION: Indomie stock=20', `got ${indomie.current_stock}`)
    : fail('Indomie stock=20', 20, indomie.current_stock);

  const revenue = await getTotalRevenue(user.id);
  Math.abs(revenue - 336000) < 1
    ? pass('REVENUE: ₦336,000', `got ₦${revenue.toLocaleString('en-NG')}`)
    : fail('REVENUE: ₦336,000', 336000, revenue);
}

async function trader05() {
  log('\n━━━ Trader 05 — Blessing (Cumulative deduction across 2 messages, Enugu) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000005', name: 'Blessing Eze',
    bizName: 'Blessing Foods', bizType: 'FMCG', state: 'Enugu',
  });
  await cleanUser(user.id);

  await processMessage(user, 'I have 100 bags garri');
  await sleep(500);
  await processMessage(user, 'sold 40 bags garri at 3500 each');
  await sleep(500);
  await processMessage(user, 'sold 30 bags garri at 3500 each');
  await sleep(500);

  const garri = await getProduct(user.id, 'garri');
  if (!garri) { fail('Garri product created', true, false); return; }

  garri.current_stock == 30
    ? pass('CUMULATIVE DEDUCTION: Garri stock=30 (100-40-30)', `got ${garri.current_stock}`)
    : fail('Garri stock=30', 30, garri.current_stock);

  const saleTxCount = await getSaleTxCount(user.id, 'garri');
  saleTxCount == 2
    ? pass('TX_COUNT: 2 sale transactions', `got ${saleTxCount}`)
    : fail('TX_COUNT: 2 sales', 2, saleTxCount);
}

async function trader06() {
  log('\n━━━ Trader 06 — Kunle (Low stock threshold check, Oyo) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000006', name: 'Kunle Adeyemi',
    bizName: 'Kunle Agro', bizType: 'FMCG', state: 'Oyo',
  });
  await cleanUser(user.id);

  await processMessage(user, 'received 50 bags rice at 22000 each');
  await sleep(500);
  await processMessage(user, 'sold 41 bags rice at 28000 each');
  await sleep(500);

  const rice = await getProduct(user.id, 'rice');
  if (!rice) { fail('Rice product created', true, false); return; }

  rice.current_stock == 9
    ? pass('STOCK_DEDUCTION: Rice stock=9', `got ${rice.current_stock}`)
    : fail('Rice stock=9', 9, rice.current_stock);

  const totalReceived = parseFloat(rice.total_ever_received) || 0;
  const pct = totalReceived > 0 ? parseFloat(rice.current_stock) / totalReceived : 1;
  pct < 0.20
    ? pass(`LOW_STOCK zone: ${(pct * 100).toFixed(1)}% < 20% of ${totalReceived} received`)
    : fail('LOW_STOCK zone: must be <20%', '<20%', `${(pct * 100).toFixed(1)}%`);
}

async function trader07() {
  log('\n━━━ Trader 07 — Ngozi (Sell-all → stock=0, Lagos, Beauty) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000007', name: 'Ngozi Okafor',
    bizName: 'Ngozi Beauty', bizType: 'Retail', state: 'Lagos',
  });
  await cleanUser(user.id);

  await processMessage(user, 'received 20 wigs at 15000 each');
  await sleep(500);
  await processMessage(user, 'sold 20 wigs at 25000 each today');
  await sleep(500);

  const wig = await getProduct(user.id, 'wig');
  if (!wig) { fail('Wig product created', true, false); return; }

  wig.current_stock == 0
    ? pass('OUT_OF_STOCK: Wig stock=0', `got ${wig.current_stock}`)
    : fail('Wig stock=0', 0, wig.current_stock);
}

async function trader08() {
  log('\n━━━ Trader 08 — Tunde ("milo don finish" Pidgin stock_zero, Lagos) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000008', name: 'Tunde Bakare',
    bizName: 'Tunde Provisions', bizType: 'FMCG', state: 'Lagos',
  });
  await cleanUser(user.id);

  await processMessage(user, 'I have 30 tins of milo');
  await sleep(500);

  const before = await getProduct(user.id, 'milo');
  if (!before) { fail('Milo product created in opening stock', true, false); return; }

  await processMessage(user, 'milo don finish');
  await sleep(500);

  const after = await getProduct(user.id, 'milo');
  if (!after) { fail('Milo still in products after stock_zero', true, false); return; }

  after.current_stock == 0
    ? pass('PIDGIN STOCK_ZERO: Milo stock=0 after "milo don finish"', `got ${after.current_stock}`)
    : fail('Milo stock=0', 0, after.current_stock);
}

async function trader09() {
  log('\n━━━ Trader 09 — Aisha (Credit sale → revenue=0, Kano, Fashion) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000009', name: 'Aisha Musa',
    bizName: "Aisha Fabrics", bizType: 'Fashion', state: 'Kano',
  });
  await cleanUser(user.id);

  await processMessage(user, 'received 10 yards lace fabric at 12000 each');
  await sleep(500);
  await processMessage(user, 'sold lace fabric to Mama Joy on credit, she will pay 80k on Saturday');
  await sleep(500);

  const revenue = await getTotalRevenue(user.id);
  revenue == 0
    ? pass('CREDIT_SALE: revenue=0 (unpaid credit not counted)', `got ₦${revenue.toLocaleString('en-NG')}`)
    : fail('CREDIT_SALE: revenue must be 0 — cash not yet received', 0, revenue);
}

async function trader10() {
  log('\n━━━ Trader 10 — Seun (Customer return — Phase 2 edge case, Ogun) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000010', name: 'Seun Adeleke',
    bizName: 'Seun Grains', bizType: 'FMCG', state: 'Ogun',
  });
  await cleanUser(user.id);

  await processMessage(user, 'received 20 bags of beans at 18000 each');
  await sleep(500);
  await processMessage(user, 'sold 5 bags of beans at 25000 each');
  await sleep(500);
  await processMessage(user, 'customer returned 2 bags of beans');
  await sleep(500);

  const beans = await getProduct(user.id, 'beans');
  if (!beans) { fail('Beans product created', true, false); return; }

  const stock = parseFloat(beans.current_stock);
  if (stock === 17) {
    pass('RETURN: stock=17 — return captured as stock_in ✓', `got ${stock}`);
  } else if (stock === 15) {
    warn('RETURN: stock=15 — return not treated as restock (Phase 2 feature). Expected 17.', `got ${stock}`);
  } else {
    fail('RETURN: expected 15 (no return) or 17 (return as stock_in)', '15 or 17', stock);
  }
}

async function trader11() {
  log('\n━━━ Trader 11 — Musa (Multi-product single message, Kaduna, FMCG) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000011', name: 'Musa Danjuma',
    bizName: 'Musa Provisions', bizType: 'FMCG', state: 'Kaduna',
  });
  await cleanUser(user.id);

  await processMessage(user, 'I have 50 bags rice and 100 carton indomie');
  await sleep(500);
  await processMessage(user, 'sold 3 bags rice at 25000 each and 10 cartons indomie at 4000 each');
  await sleep(500);

  const rice    = await getProduct(user.id, 'rice');
  const indomie = await getProduct(user.id, 'indomie');
  if (!rice || !indomie) { fail('Both products created', true, false); return; }

  rice.current_stock == 47
    ? pass('STOCK_DEDUCTION: Rice stock=47', `got ${rice.current_stock}`)
    : fail('Rice stock=47', 47, rice.current_stock);

  indomie.current_stock == 90
    ? pass('STOCK_DEDUCTION: Indomie stock=90', `got ${indomie.current_stock}`)
    : fail('Indomie stock=90', 90, indomie.current_stock);

  const revenue = await getTotalRevenue(user.id);
  Math.abs(revenue - 115000) < 1
    ? pass('REVENUE: ₦115,000 (3×25k + 10×4k)', `got ₦${revenue.toLocaleString('en-NG')}`)
    : fail('REVENUE: ₦115,000', 115000, revenue);
}

async function trader12() {
  log('\n━━━ Trader 12 — Grace (Wholesale channel detection, Rivers, FMCG) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000012', name: 'Grace Chukwu',
    bizName: 'Grace Wholesale', bizType: 'FMCG', state: 'Rivers',
  });
  await cleanUser(user.id);

  await processMessage(user, 'received 500 carton indomie at 3500 each');
  await sleep(500);
  await processMessage(user, 'wholesale bulk order — 200 carton indomie to market traders at 3800 each = 760000');
  await sleep(500);

  const indomie = await getProduct(user.id, 'indomie');
  if (!indomie) { fail('Indomie product created', true, false); return; }

  indomie.current_stock == 300
    ? pass('STOCK_DEDUCTION: Indomie stock=300', `got ${indomie.current_stock}`)
    : fail('Indomie stock=300', 300, indomie.current_stock);

  const revenue = await getTotalRevenue(user.id);
  Math.abs(revenue - 760000) < 1
    ? pass('REVENUE: ₦760,000', `got ₦${revenue.toLocaleString('en-NG')}`)
    : fail('REVENUE: ₦760,000', 760000, revenue);

  const channel = await getLastSaleChannel(user.id, 'indomie');
  channel === 'wholesale'
    ? pass('CHANNEL: wholesale detected', `got "${channel}"`)
    : warn('CHANNEL: expected wholesale — keyword "wholesale" in message', `got "${channel}"`);
}

async function trader13() {
  log('\n━━━ Trader 13 — Ibrahim (Fuzzy name matching — no duplicates, Katsina) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000013', name: 'Ibrahim Bello',
    bizName: 'Ibrahim Agro', bizType: 'FMCG', state: 'Katsina',
  });
  await cleanUser(user.id);

  // Three different phrasings of the same product — should all resolve to one product row
  await processMessage(user, 'received 50 bags of rice at 22000 each');
  await sleep(500);
  await processMessage(user, 'sold 5 Rice at 28000 each');   // different casing
  await sleep(500);
  await processMessage(user, 'sold 3 bags of rice for 28k'); // natural phrasing
  await sleep(500);

  const count = await getActiveProductCount(user.id);
  count == 1
    ? pass('FUZZY MATCH: 1 product record (no duplicates)', `got ${count} products`)
    : fail('No duplicates — should have 1 product', 1, count);

  const rice = await getProduct(user.id, 'rice');
  if (!rice) { fail('Rice product found', true, false); return; }

  rice.current_stock == 42
    ? pass('STOCK_DEDUCTION cumulative: Rice stock=42 (50-5-3)', `got ${rice.current_stock}`)
    : fail('Rice stock=42', 42, rice.current_stock);
}

async function trader14() {
  log('\n━━━ Trader 14 — Chioma (Large numbers — 1.5m notation, Delta, Retail) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000014', name: 'Chioma Obi',
    bizName: 'Chioma Hair', bizType: 'Retail', state: 'Delta',
  });
  await cleanUser(user.id);

  await processMessage(user, 'received 5 human hair pieces at 800000 each');
  await sleep(500);
  await processMessage(user, 'sold 2 human hair at 1.5m each today');
  await sleep(500);

  const hair = await getProduct(user.id, 'hair');
  if (!hair) { fail('Human hair product created', true, false); return; }

  hair.current_stock == 3
    ? pass('STOCK_DEDUCTION: Hair stock=3', `got ${hair.current_stock}`)
    : fail('Hair stock=3', 3, hair.current_stock);

  const revenue = await getTotalRevenue(user.id);
  Math.abs(revenue - 3000000) < 1
    ? pass('REVENUE: ₦3,000,000 (1.5m × 2 parsed correctly)', `got ₦${revenue.toLocaleString('en-NG')}`)
    : fail('REVENUE: ₦3,000,000', 3000000, revenue);
}

async function trader15() {
  log('\n━━━ Trader 15 — Adewale (Oversell protection — no negative stock, Lagos) ━━━');
  const user = await upsertTestUser({
    phone: '2348100000015', name: 'Adewale Osei',
    bizName: 'Wale Gadgets', bizType: 'Retail', state: 'Lagos',
  });
  await cleanUser(user.id);

  await processMessage(user, 'I have 10 power banks');
  await sleep(500);
  // Sell 15 — more than available stock of 10
  await processMessage(user, 'sold 15 power banks at 5000 each');
  await sleep(500);

  const pb = await getProduct(user.id, 'power bank');
  if (!pb) {
    // Product might be named differently — check broadly
    const fallback = await getProduct(user.id, 'power');
    if (!fallback) { fail('Power bank product created', true, false); return; }
    fallback.current_stock >= 0
      ? pass('OVERSELL PROTECTION: stock >= 0 (clamped by GREATEST)', `got ${fallback.current_stock}`)
      : fail('Stock must be >= 0', '>=0', fallback.current_stock);
    return;
  }

  pb.current_stock >= 0
    ? pass('OVERSELL PROTECTION: stock >= 0 (no negative balance)', `got ${pb.current_stock}`)
    : fail('Stock must be >= 0 — GREATEST() violated', '>=0', pb.current_stock);

  pb.current_stock == 0
    ? pass('OVERSELL: stock clamped to 0', `got ${pb.current_stock}`)
    : warn('OVERSELL: stock not 0 — may have been classified as daily_entry without stock deduction', `got ${pb.current_stock}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportDir  = path.join(__dirname, '..', 'reports');
  const reportPath = path.join(reportDir, `stress_test_${timestamp}.txt`);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  log('══════════════════════════════════════════════════════════════════════');
  log('  BIZPULSE STOCK INTELLIGENCE STRESS TEST');
  log(`  Started: ${new Date().toISOString()}`);
  log('  Parser: real Gemini 2.0 Flash   DB: real PostgreSQL   WA: null mock');
  log('  500ms pause between messages    DO NOT auto-fix failures');
  log('══════════════════════════════════════════════════════════════════════');

  const scenarios = [
    trader01, trader02, trader03, trader04, trader05,
    trader06, trader07, trader08, trader09, trader10,
    trader11, trader12, trader13, trader14, trader15,
  ];

  for (const fn of scenarios) {
    try {
      await fn();
    } catch (err) {
      log(`  ❌ FATAL   ${fn.name}: ${err.message}`);
      failed++;
    }
  }

  log('');
  log('══════════════════════════════════════════════════════════════════════');
  log('  RESULTS SUMMARY');
  log('══════════════════════════════════════════════════════════════════════');
  log(`  ✅ PASSED:  ${passed}`);
  log(`  ❌ FAILED:  ${failed}`);
  log(`  ⚠️  WARNED:  ${warned}`);
  log(`  ⏭️  SKIPPED: ${skipped}`);
  log(`  TOTAL:    ${passed + failed + warned + skipped} checks across 15 traders`);
  if (failed === 0) log('');
  if (failed === 0) log('  🏆 ALL CHECKS PASSED');
  log('══════════════════════════════════════════════════════════════════════');
  log(`  Report: ${reportPath}`);

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`\nReport saved → ${reportPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('❌ Fatal runner error:', err);
  process.exit(1);
});
