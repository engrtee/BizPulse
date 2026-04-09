/**
 * Direct database test - try a simple INSERT and SELECT
 */

require('dotenv').config();
const { query } = require('../models/db');

async function testDB() {
  console.log('\n🔧 Testing database connection...\n');

  try {
    // Test 1: Simple query
    console.log('📋 Test 1: SELECT count from users...');
    const countRes = await query('SELECT COUNT(*) as count FROM users');
    console.log(`✅ Found ${countRes.rows[0].count} users\n`);

    // Test 2: Get a user
    if (countRes.rows[0].count > 0) {
      console.log('📋 Test 2: Get first user...');
      const userRes = await query('SELECT id, name, email FROM users LIMIT 1');
      const user = userRes.rows[0];
      console.log(`✅ User: ${user.name} <${user.email}>\n`);

      // Test 3: Check their entries
      console.log(`📋 Test 3: Count transactions for ${user.name}...`);
      const txnRes = await query('SELECT COUNT(*) as count FROM transactions WHERE user_id = $1', [user.id]);
      console.log(`✅ Found ${txnRes.rows[0].count} entries\n`);

      // Test 4: List recent entries
      console.log(`📋 Test 4: Show last 3 entries for ${user.name}...`);
      const recentRes = await query(`
        SELECT id, date, revenue, total_expenses, profit, created_at
        FROM transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 3
      `, [user.id]);
      
      if (recentRes.rows.length > 0) {
        recentRes.rows.forEach((row, i) => {
          console.log(`   [${i + 1}] ${row.date} — Revenue: ₦${Number(row.revenue).toLocaleString('en-NG')}`);
        });
        console.log();
      } else {
        console.log(`   No entries found\n`);
      }
    }

    console.log('✅ Database connection is working!\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Database error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

testDB();
