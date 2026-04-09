/**
 * Check the MOST RECENT entries across ALL dates for a user
 * to see if entries are being saved at all
 */

require('dotenv').config();
const { query } = require('../models/db');

async function checkLatest() {
  try {
    console.log('\n🔍 Most recent entries across database:\n');

    const res = await query(`
      SELECT 
        u.name,
        u.email,
        t.date,
        t.revenue,
        t.total_expenses,
        t.profit,
        t.created_at,
        COUNT(*) OVER(PARTITION BY u.id) as user_entry_count
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
      LIMIT 20
    `);

    if (res.rows.length === 0) {
      console.log('❌ No transactions found in database at all!');
      process.exit(0);
    }

    console.log(`📊 Found ${res.rows.length} recent entries:\n`);

    res.rows.forEach((row, idx) => {
      console.log(`[${idx + 1}] ${row.name} <${row.email}>`);
      console.log(`    Date in DB: ${row.date}`);
      console.log(`    Revenue: ₦${Number(row.revenue).toLocaleString('en-NG')} | Profit: ₦${Number(row.profit).toLocaleString('en-NG')}`);
      console.log(`    Saved at: ${row.created_at}`);
      console.log(`    Total entries from this user: ${row.user_entry_count}\n`);
    });

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkLatest();
