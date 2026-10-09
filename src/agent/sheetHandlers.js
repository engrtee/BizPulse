/**
 * src/agent/sheetHandlers.js
 * Kemi's tools for Sheets mode: the trader's Google Sheet is the source of truth
 * and WhatsApp only reads it. Same tool names as the Postgres-backed read tools,
 * so dispatch() swaps these in for a connected business.
 */

'use strict';

const UserModel            = require('../../models/user');
const SheetConnectionModel = require('../../models/sheetConnection');
const client               = require('../../services/sheets/client');
const { buildMapping }     = require('../../services/sheets/mapper');
const data                 = require('../../services/sheets/data');
const sync                 = require('../../services/sheets/sync');

/** Run a sheet read; turn Google failures into a result Kemi can narrate honestly. */
async function withConnection(whatsappNumber, fn) {
  const conn = await SheetConnectionModel.getActiveByWhatsapp(whatsappNumber);
  if (!conn) return { error: true, reason: 'not_connected', message: 'No Google Sheet is connected.' };
  try {
    const result = await fn(conn);
    SheetConnectionModel.markSynced(conn.id).catch(() => {});
    return result;
  } catch (err) {
    const reason = client.classifyError(err);
    console.error('[Sheets] read failed:', err.message);
    SheetConnectionModel.markError(conn.id, err.message).catch(() => {});
    return {
      error: true, reason,
      message: reason === 'no_access'
        ? `BizPulse can no longer open the sheet "${conn.title}". It may have been unshared or deleted — share it again with ${client.getServiceAccountEmail()}.`
        : 'Could not read the Google Sheet right now. Try again in a minute.',
    };
  }
}

async function getStockLevelHandler({ whatsappNumber, product }) {
  return withConnection(whatsappNumber, async (conn) => {
    const stock = data.computeStock(await data.loadSnapshot(conn));
    const wanted = product ? data.itemKey(product) : null;
    const items = wanted
      ? stock.filter(s => data.itemKey(s.item).includes(wanted) || wanted.includes(data.itemKey(s.item)))
      : stock;
    return {
      source: 'google_sheet', sheet: conn.title,
      products: items.map(s => ({ name: s.item, current_stock: s.quantity, status: s.status, days_cover: s.daysCover })),
      ...(wanted && !items.length ? { not_found: product, hint: 'No item with that name in the sheet.' } : {}),
    };
  });
}

async function getStockIntelligenceHandler(whatsappNumber) {
  return withConnection(whatsappNumber, async (conn) => {
    const stock = data.computeStock(await data.loadSnapshot(conn));
    return {
      source: 'google_sheet',
      out_of_stock:    stock.filter(s => s.status === 'out').map(s => s.item),
      urgent_restock:  stock.filter(s => s.status === 'low').map(s => ({ name: s.item, current_stock: s.quantity, days_cover: s.daysCover })),
      selling_fast:    [...stock].filter(s => s.sold7 > 0).sort((a, b) => b.sold7 - a.sold7).slice(0, 5)
                         .map(s => ({ name: s.item, sold_last_7_days: s.sold7 })),
      not_selling:     stock.filter(s => s.quantity > 0 && s.sold7 === 0).map(s => s.item),
    };
  });
}

async function getSalesSummaryHandler({ whatsappNumber, period, start_date, end_date }) {
  return withConnection(whatsappNumber, async (conn) => {
    const snap = await data.loadSnapshot(conn);
    if (!snap.sales) return { source: 'google_sheet', no_sales_tab: true };
    const range = data.periodRange(period, start_date, end_date);
    return { source: 'google_sheet', period, ...data.summarise(snap, range) };
  });
}

async function connectGoogleSheetHandler({ whatsappNumber, sheet_link }) {
  if (!client.isConfigured()) {
    return { connected: false, reason: 'not_configured', message: 'Google Sheets connection is not switched on for BizPulse yet.' };
  }
  const user = await UserModel.findByWhatsapp(whatsappNumber);
  if (!user) return { connected: false, reason: 'no_user' };

  const spreadsheetId = client.extractSpreadsheetId(sheet_link);
  if (!spreadsheetId) {
    return { connected: false, reason: 'bad_link', message: 'That does not look like a Google Sheets link.' };
  }

  let meta;
  try {
    meta = await client.getMeta(spreadsheetId);
  } catch (err) {
    const reason = client.classifyError(err);
    return {
      connected: false, reason,
      share_with_email: client.getServiceAccountEmail(),
      message: reason === 'no_access'
        ? 'BizPulse cannot open that sheet yet. The owner must open it, tap Share, and add the email in share_with_email as a Viewer.'
        : 'Google did not respond. Try again in a minute.',
    };
  }

  const { mapping, problems } = await buildMapping(meta.tabs, (tab) => client.readTab(spreadsheetId, tab));
  if (problems.length) {
    return {
      connected: false, reason: 'cannot_read_layout', problems, tabs_found: meta.tabs,
      message: 'The sheet opened, but its layout could not be understood. Needed: a Sales tab and a Stock tab (or Purchases + Sales). Columns: item, quantity, date, price.',
    };
  }

  const conn = await SheetConnectionModel.upsert({ userId: user.id, spreadsheetId, title: meta.title, mapping });
  await sync.baseline(conn); // existing sales history must not trigger "just sold" alerts
  const stock = data.computeStock(await data.loadSnapshot(conn, { fresh: true }));

  return {
    connected: true, sheet: meta.title,
    tabs_used: Object.fromEntries(Object.entries(mapping).map(([role, s]) => [role, { tab: s.tab, columns: s.fields }])),
    items_found: stock.length,
    note: 'Sheet is read-only to BizPulse. The business now logs in the sheet; WhatsApp is for checking stock, sales, and getting sold alerts. Logging by WhatsApp is switched off.',
  };
}

async function disconnectGoogleSheetHandler({ whatsappNumber }) {
  const user = await UserModel.findByWhatsapp(whatsappNumber);
  const conn = user ? await SheetConnectionModel.getByUserId(user.id) : null;
  if (!conn) return { disconnected: false, reason: 'not_connected' };
  data.clearCache(conn.id);
  await SheetConnectionModel.remove(user.id);
  return { disconnected: true, note: 'Back to logging by WhatsApp. Sheet data was never copied into BizPulse, so there is nothing to delete.' };
}

module.exports = {
  getStockLevelHandler,
  getStockIntelligenceHandler,
  getSalesSummaryHandler,
  connectGoogleSheetHandler,
  disconnectGoogleSheetHandler,
};
