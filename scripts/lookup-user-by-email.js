/**
 * Lookup user by email and check all their data
 * Run: node scripts/lookup-user-by-email.js
 */

'use strict';

require('dotenv').config();
const { query } = require('../models/db');

async function lookup() {
  try {
    const email = 'tosin.ilesanmi193@gmail.com';
    
    console.log(`\n🔍 LOOKING UP USER: ${email}\n`);

    // Find user
    const userRes = await query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (userRes.rows.length === 0) {
      console.log('❌ User not found in database!');
      process.exit(1);
    }

    const user = userRes.rows[0];
    console.log(`User ID: ${user.id}`);
    console.log(`Name: ${user.name}`);
    console.log(`Email: ${user.email}`);
    console.log(`WhatsApp: ${user.whatsapp_number || 'NOT SET'}`);
    console.log(`Active: ${user.active}`);
    console.log(`Last entry: ${user.last_entry_date || 'NEVER'}`);
    console.log(`Streak: ${user.streak || 0}`);

    // Get their transactions
    const txRes = await query(
      'SELECT id, date, revenue, total_expenses, profit, created_at FROM transactions WHERE user_id = $1 ORDER BY date DESC',
      [user.id]
    );

    console.log(`\nTransactions: ${txRes.rows.length}`);
    if (txRes.rows.length === 0) {
      console.log('  ❌ No entries found for this user');
    } else {
      txRes.rows.forEach((tx, idx) => {
        console.log(`  ${idx + 1}. ${tx.date}: ₦${parseInt(tx.revenue).toLocaleString('en-NG')} revenue (created: ${tx.created_at})`);
      });
    }

    // Get inventory
    const inventoryRes = await query(
      'SELECT id, item_name, current_balance FROM inventory WHERE user_id = $1',
      [user.id]
    );

    console.log(`\nInventory items: ${inventoryRes.rows.length}`);
    if (inventoryRes.rows.length > 0) {
      inventoryRes.rows.forEach(item => {
        console.log(`  - ${item.item_name}: ${item.current_balance} units`);
      });
    }

    console.log('\n✅ User account is active and data is in database!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

lookup();
