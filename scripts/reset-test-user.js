'use strict';
require('dotenv').config();
const { query } = require('../models/db');

const TEST_PHONE = '2348031234567';

async function main() {
  // Get user id first
  const u = await query('SELECT id FROM users WHERE whatsapp_number=$1', [TEST_PHONE]);
  const userId = u.rows[0]?.id;

  if (userId) {
    await query('DELETE FROM product_transactions WHERE user_id=$1', [userId]);
    await query('DELETE FROM products WHERE user_id=$1', [userId]);
    await query('DELETE FROM transactions WHERE user_id=$1', [userId]);
  }
  await query('DELETE FROM conversation_history WHERE whatsapp_number=$1', [TEST_PHONE]);
  await query('DELETE FROM trader_facts WHERE whatsapp_number=$1', [TEST_PHONE]);
  await query('DELETE FROM debts WHERE whatsapp_number=$1', [TEST_PHONE]);
  await query('DELETE FROM goals WHERE whatsapp_number=$1', [TEST_PHONE]);

  console.log('✅ Test user data wiped. Ready for fresh run.');
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
