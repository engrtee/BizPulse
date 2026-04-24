/**
 * scripts/onboard-mohat.js
 *
 * One-time fix: sets Mohat's WhatsApp number and sends her the welcome message.
 *
 * Run: node scripts/onboard-mohat.js
 */

'use strict';

require('dotenv').config();
const { query }          = require('../models/db');
const { normalizePhone } = require('../utils/phone');
const WhatsAppService    = require('../services/whatsapp');

const RAW_NUMBER = '09046099011';

async function run() {
  try {
    const canonical = normalizePhone(RAW_NUMBER);
    console.log(`\n📱 Target number: ${RAW_NUMBER} → ${canonical}\n`);

    // ── Find the user ─────────────────────────────────────
    const res = await query(
      `SELECT id, name, email, whatsapp_number
       FROM users
       WHERE active = TRUE
         AND (
           whatsapp_number IS NULL
           OR whatsapp_number = $1
           OR whatsapp_number = $2
         )
         AND name ILIKE '%mohat%'
       ORDER BY id`,
      [RAW_NUMBER, canonical]
    );

    if (res.rows.length === 0) {
      console.error('❌ No user found with name containing "mohat".');
      console.log('   All users with NULL phone:');
      const nullRes = await query(
        `SELECT id, name, email FROM users WHERE active = TRUE AND whatsapp_number IS NULL`
      );
      for (const u of nullRes.rows) {
        console.log(`   ID ${u.id}: ${u.name} <${u.email}>`);
      }
      process.exit(1);
    }

    const user = res.rows[0];
    console.log(`✅ Found user: ID ${user.id} — ${user.name} (${user.email})`);
    console.log(`   Current whatsapp_number: ${user.whatsapp_number || '(none)'}`);

    // ── Update phone number ───────────────────────────────
    await query(
      'UPDATE users SET whatsapp_number = $1 WHERE id = $2',
      [canonical, user.id]
    );
    console.log(`✅ Updated whatsapp_number → ${canonical}`);

    // ── Send welcome message ──────────────────────────────
    console.log(`\n📤 Sending welcome message to ${canonical}...`);
    const firstName = user.name.split(' ')[0];
    await WhatsAppService.sendOnboarding(canonical, firstName);
    console.log(`✅ Welcome message sent to ${user.name}!\n`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

run();
