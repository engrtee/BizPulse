/**
 * Connect (or re-connect) a business to its Google Sheet without going through WhatsApp.
 * Usage: node scripts/connect-sheet.js <whatsapp_number> <sheet_link>
 *        node scripts/connect-sheet.js <whatsapp_number> --disconnect
 * Same code path as Kemi's connect_google_sheet tool. Needs GOOGLE_SERVICE_ACCOUNT_JSON.
 */
'use strict';
require('dotenv').config();
const { initDb } = require('../models/db');
const { connectGoogleSheetHandler, disconnectGoogleSheetHandler } = require('../src/agent/sheetHandlers');

(async () => {
  const [number, arg] = process.argv.slice(2);
  if (!number || !arg) {
    console.error('Usage: node scripts/connect-sheet.js <whatsapp_number> <sheet_link | --disconnect>');
    process.exit(1);
  }
  await initDb(); // idempotent; makes sure the sheet_* tables exist
  const result = arg === '--disconnect'
    ? await disconnectGoogleSheetHandler({ whatsappNumber: number })
    : await connectGoogleSheetHandler({ whatsappNumber: number, sheet_link: arg });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.connected === false || result.disconnected === false ? 2 : 0);
})().catch(e => { console.error(e); process.exit(1); });
