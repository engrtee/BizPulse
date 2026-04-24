/**
 * Check: Are transactions still in the database?
 * Run: node scripts/check-transactions.js
 */

'use strict';

require('dotenv').config();
const { query } = require('../models/db');

async function check() {
  try {
    console.log('\n🔍 CHECKING DATABASE TRANSACTIONS\n');

    // Total transactions in DB
    const allRes = await query('SELECT COUNT(*) as count FROM transactions');
    const totalCount = parseInt(allRes.rows[0].count, 10);
    console.log(`Total transactions in database: ${totalCount}`);

    if (totalCount === 0) {
      console.log('❌ NO TRANSACTIONS FOUND!\n');
      process.exit(0);
    }

    // By user
    const byUserRes = await query(`
      SELECT u.name, COUNT(t.id) as tx_count 
      FROM users u 
      LEFT JOIN transactions t ON u.id = t.user_id 
      WHERE u.active = TRUE
      GROUP BY u.id, u.name
      ORDER BY tx_count DESC
    `);

    console.log('\nTransactions by user:');
    byUserRes.rows.forEach(row => {
      console.log(`  ${row.name}: ${row.tx_count} entries`);
    });

    // Tosin's entries specifically
    const tosinRes = await query(`
      SELECT u.id, u.name FROM users u 
      WHERE u.active = TRUE AND u.name LIKE '%Tosin%'
    `);

    if (tosinRes.rows.length > 0) {
      const tosinId = tosinRes.rows[0].id;
      const tosinName = tosinRes.rows[0].name;
      
      const tosinTxRes = await query(`
        SELECT id, date, revenue, total_expenses, profit, created_at 
        FROM transactions 
        WHERE user_id = $1 
        ORDER BY date DESC 
        LIMIT 5
      `, [tosinId]);

      console.log(`\n${tosinName}'s recent entries:`);
      if (tosinTxRes.rows.length === 0) {
        console.log('  ❌ No entries for this user');
      } else {
        tosinTxRes.rows.forEach(tx => {
          console.log(`  ${tx.date}: ₦${parseInt(tx.revenue).toLocaleString('en-NG')} revenue`);
        });
      }
    }

    console.log('');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

check();
