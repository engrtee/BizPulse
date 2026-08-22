/**
 * scripts/create-reseller-seller.js
 * Registers a new seller for the Reseller Ordering Agent (separate product from
 * BizPulse's own trader accounts — see src/reseller-agent/). V1 has no self-signup;
 * sellers are created manually, per bizpulse-v1-build-prompt.md Section 2.
 *
 * Run:
 *   node scripts/create-reseller-seller.js \
 *     --name "Amaka" --business "Amaka Bags & Totes" --code AMAKA01 --phone 08012345678 \
 *     [--bank-name "Account Holder Name"] [--bank-account 0123456789] [--bank "GTBank"]
 *
 * --code is the short word/code customers can type to skip seller-identification
 * (bizpulse-v1-build-prompt.md Section 4a) — keep it short and easy to type, e.g.
 * her first name + a number. --phone is HER OWN WhatsApp number (for inventory
 * commands + dashboard login) — this is separate from the shared BizPulse number
 * her customers message.
 */

'use strict';

require('dotenv').config();
const SellerModel = require('../models/seller');
const { pool } = require('../models/db');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function run() {
  const args = parseArgs();
  const required = ['name', 'business', 'code', 'phone'];
  const missing = required.filter(k => !args[k]);
  if (missing.length > 0) {
    console.error(`❌ Missing required arguments: ${missing.join(', ')}\n`);
    console.log(
      `Usage:\n  node scripts/create-reseller-seller.js \\\n` +
      `    --name "Amaka" --business "Amaka Bags & Totes" --code AMAKA01 --phone 08012345678 \\\n` +
      `    [--bank-name "Account Holder Name"] [--bank-account 0123456789] [--bank "GTBank"]\n`
    );
    process.exit(1);
  }

  try {
    const seller = await SellerModel.create({
      name: args.name,
      businessName: args.business,
      code: args.code,
      whatsappNumber: args.phone,
      bankAccountName: args['bank-name'],
      bankAccountNumber: args['bank-account'],
      bankName: args.bank,
    });

    console.log(`✅ Seller created:`);
    console.log(`   ID: ${seller.id}`);
    console.log(`   Business: ${seller.business_name}`);
    console.log(`   Code: ${seller.code}`);
    console.log(`   Her own WhatsApp number: ${seller.whatsapp_number}`);
    console.log(`\nShe can now message the BizPulse WhatsApp number directly to manage her ` +
      `stock/catalog (e.g. "new item: blue tote bag, 8000 naira"), and log in to her ` +
      `dashboard at ${process.env.BASE_URL || '<BASE_URL>'}/reseller/login using her ` +
      `WhatsApp number (no password — a login code is sent to her on WhatsApp).`);
    if (!args['bank-account']) {
      console.log(`\n⚠️  No bank account details were given — add them before she takes real ` +
        `orders, since place_order sends bank_details to customers once an order is confirmed.`);
    }
  } catch (err) {
    if (err.code === '23505') {
      console.error(`❌ A seller with that code or phone number already exists.`);
    } else {
      console.error('❌ Error:', err.message);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
