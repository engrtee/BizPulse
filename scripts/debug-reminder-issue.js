/**
 * Debug: Check why 6pm reminder isn't firing
 * Run: node scripts/debug-reminder-issue.js
 */

'use strict';

require('dotenv').config();
const { query } = require('../models/db');

async function debug() {
  try {
    console.log('\n🔍 DEBUGGING 6PM REMINDER ISSUE\n');

    // Get all active users
    const res = await query('SELECT id, name, whatsapp_number, last_entry_date FROM users WHERE active = TRUE');
    const users = res.rows;

    console.log(`Found ${users.length} active users\n`);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    console.log(`Today's date (WAT): ${today}\n`);

    for (const user of users) {
      console.log(`👤 ${user.name}`);
      console.log(`   WhatsApp: ${user.whatsapp_number || '❌ NO NUMBER'}`);
      console.log(`   Last entry: ${user.last_entry_date || 'NEVER'}`);

      if (user.last_entry_date) {
        const lastDate = new Date(user.last_entry_date).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
        const isTodayLogged = lastDate === today;
        console.log(`   Last entry date (parsed): ${lastDate}`);
        console.log(`   Would remind? ${isTodayLogged ? '❌ NO (already logged today)' : '✅ YES (not logged today)'}`);
      } else {
        console.log(`   Would remind? ✅ YES (never logged)`);
      }
      console.log('');
    }

    // Check for entries today
    const entriesRes = await query(
      `SELECT user_id, COUNT(*) as count FROM transactions 
       WHERE DATE(AT TIME ZONE 'Africa/Lagos', created_at) = $1 
       GROUP BY user_id`,
      [today]
    );

    console.log('\n📊 ENTRIES TODAY:\n');
    if (entriesRes.rows.length === 0) {
      console.log('No entries today from any user ✓');
    } else {
      entriesRes.rows.forEach(row => {
        console.log(`User ${row.user_id}: ${row.count} entries`);
      });
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

debug();
