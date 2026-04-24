/**
 * Test the /api/summary/latest endpoint directly
 * Run: node scripts/test-summary-endpoint.js
 */

'use strict';

require('dotenv').config();
const TransactionModel = require('../models/transaction');
const UserModel = require('../models/user');

async function test() {
  try {
    console.log('\n🧪 TESTING /api/summary/latest\n');

    // Get the user
    const user = await UserModel.findById(4);
    console.log(`User: ${user.name} (ID: ${user.id})`);

    // Test getLatest
    const latest = await TransactionModel.getLatest(user.id);
    console.log(`\ngetLatest() result:`);
    if (!latest) {
      console.log('  ❌ RETURNED NULL!');
    } else {
      console.log(`  ✅ Found:`);
      console.log(`    Date: ${latest.date}`);
      console.log(`    Revenue: ${latest.revenue}`);
      console.log(`    Profit: ${latest.profit}`);
      console.log(`    Margin: ${latest.margin}`);
    }

    // Test getHistory
    const history = await TransactionModel.getHistory(user.id, 10);
    console.log(`\ngetHistory() returned ${history.length} entries`);

    // Test getDailyExpenseBreakdown
    if (latest) {
      const breakdown = await TransactionModel.getDailyExpenseBreakdown(user.id, latest.date);
      console.log(`\ngetDailyExpenseBreakdown() for ${latest.date}:`, breakdown);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message, err.stack);
    process.exit(1);
  }
}

test();
