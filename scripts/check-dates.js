/**
 * Check what date will be stored for today's entry
 * and verify timezone handling
 */

require('dotenv').config();
const { query } = require('../models/db');

async function checkDateHandling() {
  console.log('\n🕐 Timezone & Date Handling Check\n');
  
  try {
    // Get system time
    const now = new Date();
    console.log(`Local system time: ${now}`);
    console.log(`WAT timezone: ${now.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}`);

    // Check what the database will store
    const dbRes = await query(`
      SELECT 
        NOW() as db_now_utc,
        (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE as watin_date,
        CURRENT_DATE as db_current_date
    `);

    const row = dbRes.rows[0];
    console.log(`\nDatabase time (UTC): ${row.db_now_utc}`);
    console.log(`Database time (WAT date): ${row.watin_date}`);
    console.log(`DATABASE CURRENT_DATE: ${row.db_current_date}`);
    
    // Check what's actually in the transactions table by date
    console.log(`\n📋 Transactions grouped by date:\n`);
    const txnRes = await query(`
      SELECT 
        date,
        COUNT(*) as count,
        SUM(revenue) as total_revenue
      FROM transactions
      GROUP BY date
      ORDER BY date DESC
      LIMIT 5
    `);
    
    txnRes.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.date}: ${row.count} entries, ₦${Number(row.total_revenue).toLocaleString('en-NG')} revenue`);
    });
    
    console.log('\n✨ Check complete\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkDateHandling();
