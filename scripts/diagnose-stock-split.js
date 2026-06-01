'use strict';
/**
 * Diagnoses the stock discrepancy between the old inventory table
 * and the new products table for a given WhatsApp number.
 *
 * Usage:
 *   node scripts/diagnose-stock-split.js 2348012345678
 *   node scripts/diagnose-stock-split.js 08012345678
 */

require('dotenv').config();
const { query } = require('../models/db');

async function run() {
  const rawNumber = process.argv[2];
  if (!rawNumber) {
    console.error('Usage: node scripts/diagnose-stock-split.js <whatsapp_number>');
    process.exit(1);
  }

  // Normalise: strip leading + or 0, ensure starts with 234
  let phone = rawNumber.replace(/^\+/, '');
  if (phone.startsWith('0')) phone = '234' + phone.slice(1);

  // Look up user
  const userRes = await query(
    `SELECT id, name, biz_type, opening_stock_logged
     FROM users
     WHERE whatsapp_number = $1
        OR whatsapp_number = '0' || SUBSTRING($1, 4)
        OR whatsapp_number = '+' || $1`,
    [phone]
  );
  if (!userRes.rows.length) {
    console.error('❌ User not found for number:', rawNumber);
    process.exit(1);
  }
  const user = userRes.rows[0];
  console.log(`\n👤 User: ${user.name} (ID: ${user.id}) — ${user.biz_type}`);
  console.log(`   Opening stock logged: ${user.opening_stock_logged ? 'yes' : 'no'}\n`);

  // ── OLD inventory table ──────────────────────────────────────────────────
  const invRes = await query(
    `SELECT item_name, current_balance, total_received, unit_price
     FROM inventory
     WHERE user_id = $1
     ORDER BY item_name`,
    [user.id]
  );
  console.log(`📦 OLD inventory table (${invRes.rows.length} rows):`);
  if (invRes.rows.length === 0) {
    console.log('   (empty)');
  } else {
    invRes.rows.forEach(r => {
      console.log(`   ${r.item_name.padEnd(30)} balance: ${String(r.current_balance).padStart(8)}  total_received: ${r.total_received}`);
    });
  }

  // ── NEW products table ───────────────────────────────────────────────────
  const prodRes = await query(
    `SELECT product_name, current_stock, total_ever_received, unit, last_purchase_price, is_active
     FROM products
     WHERE user_id = $1
     ORDER BY product_name`,
    [user.id]
  );
  console.log(`\n🏷️  NEW products table (${prodRes.rows.length} rows):`);
  if (prodRes.rows.length === 0) {
    console.log('   (empty)');
  } else {
    prodRes.rows.forEach(r => {
      const active = r.is_active ? '✅' : '❌';
      console.log(`   ${active} ${r.product_name.padEnd(30)} stock: ${String(r.current_stock).padStart(8)}  ever_rcvd: ${String(r.total_ever_received).padStart(8)}  unit: ${r.unit || 'units'}`);
    });
  }

  // ── Cross-reference: items in inventory but not products ────────────────
  const invNames = invRes.rows.map(r => r.item_name.toLowerCase());
  const prodNames = prodRes.rows.filter(r => r.is_active).map(r => r.product_name.toLowerCase());

  const onlyInInv  = invNames.filter(n => !prodNames.some(p => p.includes(n) || n.includes(p)));
  const onlyInProd = prodNames.filter(n => !invNames.some(i => n.includes(i) || i.includes(n)));

  if (onlyInInv.length) {
    console.log(`\n⚠️  Items ONLY in old inventory (not in products):`);
    onlyInInv.forEach(n => console.log(`   - ${n}`));
  }
  if (onlyInProd.length) {
    console.log(`\n⚠️  Items ONLY in new products (not in old inventory):`);
    onlyInProd.forEach(n => console.log(`   - ${n}`));
  }

  // ── Mismatched balances ──────────────────────────────────────────────────
  console.log('\n🔍 Stock balance comparison (items found in both):');
  let found = false;
  for (const inv of invRes.rows) {
    const match = prodRes.rows.find(p =>
      p.product_name.toLowerCase().includes(inv.item_name.toLowerCase()) ||
      inv.item_name.toLowerCase().includes(p.product_name.toLowerCase())
    );
    if (match) {
      found = true;
      const inv_bal  = parseFloat(inv.current_balance);
      const prod_bal = parseFloat(match.current_stock);
      const same = Math.abs(inv_bal - prod_bal) < 0.001;
      const icon = same ? '✅' : '❌ MISMATCH';
      console.log(`   ${icon}  "${inv.item_name}"  inventory: ${inv_bal}  |  products: ${prod_bal} (${match.product_name})`);
    }
  }
  if (!found) console.log('   No matching item names found between tables.');

  console.log('\n📌 CONCLUSION:');
  if (invRes.rows.length === 0 && prodRes.rows.length > 0) {
    console.log('   The old inventory table is empty. All stock is in the products table (Kemi system). ✅');
  } else if (invRes.rows.length > 0 && prodRes.rows.length === 0) {
    console.log('   Only the old inventory table has data. Kemi has no stock entries yet.');
  } else if (invRes.rows.length > 0 && prodRes.rows.length > 0) {
    console.log('   ⚠️  SPLIT DATA — stock exists in BOTH tables.');
    console.log('   WhatsApp (Kemi) reads from: products table');
    console.log('   Web app stock panel reads from: products table');
    console.log('   Web app low-stock alerts read from: inventory table (OLD)');
    console.log('   Action needed: reconcile the two tables or migrate old inventory to products.');
  }

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
