/**
 * services/sheets/sync.js
 * Detects newly-added Sales rows in a connected sheet so the owner can be told
 * "an item just sold". Rows are tracked by content hash in sheet_seen_sales.
 */

'use strict';

const SheetConnectionModel = require('../../models/sheetConnection');
const data = require('./data');

/**
 * Mark every current Sales row as already seen, without alerting — run once when a
 * sheet is connected so the owner isn't flooded with their whole history.
 */
async function baseline(conn) {
  const snap = await data.loadSnapshot(conn, { fresh: true });
  await SheetConnectionModel.addSeenHashes(conn.id, (snap.sales || []).map(r => r.hash));
  await SheetConnectionModel.setBaselined(conn.id);
}

/**
 * Returns { newSales, stock } for rows not seen before and dated today/yesterday (WAT).
 * Older unseen rows (staff back-filling or editing history) are marked seen silently.
 * Rows are marked seen here — the caller should send the alert straight after.
 */
async function detectNewSales(conn) {
  if (!conn.baselined) { await baseline(conn); return { newSales: [], stock: null }; }

  const snap = await data.loadSnapshot(conn, { fresh: true });
  const sales = snap.sales || [];
  const seen = await SheetConnectionModel.getSeenHashes(conn.id);
  const unseen = sales.filter(r => !seen.has(r.hash));
  if (!unseen.length) return { newSales: [], stock: null };

  const cutoff = data.addDays(data.todayWAT(), -1);
  const newSales = unseen.filter(r => !r.date || r.date >= cutoff);
  await SheetConnectionModel.addSeenHashes(conn.id, unseen.map(r => r.hash));
  return { newSales, stock: data.computeStock(snap) };
}

module.exports = { baseline, detectNewSales };
