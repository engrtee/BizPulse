/**
 * jobs/sheetJobs.js
 * Proactive WhatsApp pushes for businesses running in Google Sheets mode:
 *   - every 5 min:  "just sold" alert when staff add Sales rows to the sheet
 *   - 7:30 AM WAT:  morning stock check
 *   - 8:30 PM WAT:  night sales recap + stock to watch
 * Everything is read from the owner's sheet; nothing is written anywhere but push_log.
 * (Postgres-based jobs skip these users — see UserModel.findAllActive.)
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const SheetConnectionModel = require('../models/sheetConnection');
const WhatsAppService      = require('../services/whatsapp');
const { checkPushBudget, recordPush } = require('../services/pushBudget');
const client   = require('../services/sheets/client');
const data     = require('../services/sheets/data');
const sync     = require('../services/sheets/sync');
const messages = require('../services/sheets/messages');

// After this many failed polls in a row we stop hammering and flag the connection.
const MAX_CONSECUTIVE_FAILURES = 12; // ~1 hour of 5-min polls
const _failures = new Map();

async function handleReadFailure(conn, err, label) {
  const reason = client.classifyError(err);
  console.error(`[SheetJobs] ${label} failed for connection ${conn.id}: ${err.message}`);
  const n = (_failures.get(conn.id) || 0) + 1;
  _failures.set(conn.id, n);
  if (reason === 'no_access' || n >= MAX_CONSECUTIVE_FAILURES) {
    await SheetConnectionModel.markError(conn.id, err.message, reason === 'no_access' ? 'access_lost' : null);
    if (reason === 'no_access') {
      // Tell the owner once — status flips to access_lost so this never repeats.
      await WhatsAppService.sendMessage(conn.whatsapp_number,
        `⚠️ BizPulse can't open your sheet "${conn.title}" anymore — it may have been unshared. ` +
        `Share it again with ${client.getServiceAccountEmail()} (Viewer) and send me the link.`
      ).catch(() => {});
    }
  }
}

async function pollSoldAlerts() {
  if (!client.isConfigured()) return;
  const conns = await SheetConnectionModel.listActive();
  for (const conn of conns) {
    try {
      const { newSales, stock } = await sync.detectNewSales(conn);
      _failures.delete(conn.id);
      if (!newSales.length) continue;
      await WhatsAppService.sendMessage(conn.whatsapp_number, messages.soldAlert(newSales, stock || []));
      await recordPush(conn.user_id, 'sheet_sold');
    } catch (err) {
      await handleReadFailure(conn, err, 'sold-alert poll');
    }
  }
}

async function runMorningStock() {
  if (!client.isConfigured()) return;
  for (const conn of await SheetConnectionModel.listActive()) {
    try {
      if (!(await checkPushBudget(conn.user_id, 'sheet_morning'))) continue;
      const snap = await data.loadSnapshot(conn, { fresh: true });
      const firstName = (conn.user_name || '').split(' ')[0] || 'there';
      await WhatsAppService.sendMessage(conn.whatsapp_number, messages.morningMessage(firstName, data.computeStock(snap)));
      await recordPush(conn.user_id, 'sheet_morning');
    } catch (err) {
      await handleReadFailure(conn, err, 'morning stock');
    }
  }
}

async function runNightRecap() {
  if (!client.isConfigured()) return;
  for (const conn of await SheetConnectionModel.listActive()) {
    try {
      if (!(await checkPushBudget(conn.user_id, 'sheet_night'))) continue;
      const snap = await data.loadSnapshot(conn, { fresh: true });
      const today = data.todayWAT();
      const summary = data.summarise(snap, [today, today]);
      const firstName = (conn.user_name || '').split(' ')[0] || 'there';
      await WhatsAppService.sendMessage(conn.whatsapp_number, messages.nightMessage(firstName, summary, data.computeStock(snap)));
      await recordPush(conn.user_id, 'sheet_night');
    } catch (err) {
      await handleReadFailure(conn, err, 'night recap');
    }
  }
}

let _polling = false; // never let two polls overlap if Google is slow
cron.schedule('*/5 * * * *', async () => {
  if (_polling) return;
  _polling = true;
  try { await pollSoldAlerts(); } catch (e) { console.error('[SheetJobs] poll fatal:', e.message); }
  finally { _polling = false; }
}, { timezone: 'Africa/Lagos' });

cron.schedule('30 7 * * *', () => runMorningStock().catch(e => console.error('[SheetJobs] morning fatal:', e.message)), { timezone: 'Africa/Lagos' });
cron.schedule('30 20 * * *', () => runNightRecap().catch(e => console.error('[SheetJobs] night fatal:', e.message)), { timezone: 'Africa/Lagos' });

console.log(client.isConfigured()
  ? `[Sheets] service account ready: ${client.getServiceAccountEmail()}`
  : '[Sheets] ⚠️ GOOGLE_SERVICE_ACCOUNT_JSON missing or unreadable — Sheets mode is OFF');
console.log('[Cron] Sheets mode jobs scheduled: 5-min sold alerts, 7:30 AM stock, 8:30 PM recap.');

module.exports = { pollSoldAlerts, runMorningStock, runNightRecap };
