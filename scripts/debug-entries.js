/**
 * Debug script to check what entries exist in the database for a given date
 * 
 * Usage: node scripts/debug-entries.js [date]
 * Example: node scripts/debug-entries.js 2026-04-09
 * 
 * If no date provided, defaults to today in WAT timezone
 */

require('dotenv').config();
const { query } = require('../models/db');
const { todayWAT } = require('../utils/formatter');

async function debugEntries() {
  const dateArg = process.argv[2];
  const checkDate = dateArg || todayWAT();

  console.log(`\n🔍 Checking entries for date: ${checkDate}\n`);
  console.log(`Current WAT time: ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}\n`);

  try {
    // Get all users
    const usersRes = await query(`
      SELECT id, name, email FROM users ORDER BY created_at DESC LIMIT 10
    `);

    console.log(`📋 Checking ${usersRes.rows.length} recent users:\n`);

    for (const user of usersRes.rows) {
      const entriesRes = await query(`
        SELECT id, date, revenue, total_expenses, profit, customers, created_at
        FROM transactions
        WHERE user_id = $1 AND date = $2
        ORDER BY created_at DESC
      `, [user.id, checkDate]);

      if (entriesRes.rows.length === 0) {
        console.log(`❌ ${user.name} <${user.email}>`);
        console.log(`   No entries for ${checkDate}`);
        
        // Show recent entries
        const recentRes = await query(`
          SELECT date, COUNT(*) as count
          FROM transactions
          WHERE user_id = $1
          GROUP BY date
          ORDER BY date DESC
          LIMIT 3
        `, [user.id]);
        
        if (recentRes.rows.length > 0) {
          console.log(`   Recent entries:`);
          recentRes.rows.forEach(r => {
            console.log(`     - ${r.date}: ${r.count} entries`);
          });
        }
      } else {
        console.log(`✅ ${user.name} <${user.email}>`);
        console.log(`   Found ${entriesRes.rows.length} entries:\n`);
        
        let totalRev = 0, totalExp = 0;
        entriesRes.rows.forEach((entry, idx) => {
          console.log(`   [${idx + 1}] Revenue: ₦${Number(entry.revenue).toLocaleString('en-NG')} | ` +
            `Expenses: ₦${Number(entry.total_expenses).toLocaleString('en-NG')} | ` +
            `Profit: ₦${Number(entry.profit).toLocaleString('en-NG')}`);
          console.log(`       Customers: ${entry.customers} | Created: ${entry.created_at}`);
          totalRev += parseFloat(entry.revenue) || 0;
          totalExp += parseFloat(entry.total_expenses) || 0;
        });
        
        console.log(`\n   📊 Daily totals: Revenue ₦${Number(totalRev).toLocaleString('en-NG')} | ` +
          `Expenses ₦${Number(totalExp).toLocaleString('en-NG')} | ` +
          `Profit ₦${Number(totalRev - totalExp).toLocaleString('en-NG')}\n`);
      }
    }

    console.log('\n✨ Debug complete.\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

debugEntries();
