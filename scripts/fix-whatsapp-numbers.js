/**
 * Fix WhatsApp number format for all users
 * Converts 080/081/089 to 2348/2349 format
 * Run: node scripts/fix-whatsapp-numbers.js
 */

'use strict';

require('dotenv').config();
const { query } = require('../models/db');

async function normalizeNumber(num) {
  if (!num) return null;
  
  // Already in 234 format
  if (num.startsWith('234')) return num;
  
  // Has + prefix
  if (num.startsWith('+234')) return num.substring(1);
  
  // Starts with 0 — convert to 234
  if (num.startsWith('0')) {
    return '234' + num.substring(1);
  }
  
  return num;
}

async function fix() {
  try {
    console.log('\n🔧 FIXING WHATSAPP NUMBERS\n');

    // Show users with no WhatsApp number (they cannot use the WhatsApp bot)
    const nullRes = await query('SELECT id, name, email FROM users WHERE whatsapp_number IS NULL AND active = TRUE');
    if (nullRes.rows.length > 0) {
      console.log('⚠️  USERS WITH NO WHATSAPP NUMBER (cannot receive messages):');
      for (const u of nullRes.rows) {
        console.log(`  ID ${u.id}: ${u.name} <${u.email}>`);
      }
      console.log('  → Ask them to log in at mybizpulse.app, go to Settings, and add their number.\n');
    } else {
      console.log('✅ All active users have a WhatsApp number.\n');
    }

    const res = await query('SELECT id, name, whatsapp_number FROM users WHERE whatsapp_number IS NOT NULL');
    const users = res.rows;

    console.log(`Found ${users.length} users with WhatsApp numbers — checking format...\n`);

    for (const user of users) {
      const normalized = await normalizeNumber(user.whatsapp_number);
      
      if (normalized !== user.whatsapp_number) {
        console.log(`${user.name}:`);
        console.log(`  Before: ${user.whatsapp_number}`);
        console.log(`  After:  ${normalized}`);
        
        await query(
          'UPDATE users SET whatsapp_number = $1 WHERE id = $2',
          [normalized, user.id]
        );
        
        console.log(`  ✅ Updated\n`);
      } else {
        console.log(`${user.name}: Already correct (${normalized})\n`);
      }
    }

    console.log('✅ All WhatsApp numbers normalized!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

fix();
