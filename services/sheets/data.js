/**
 * services/sheets/data.js
 * Turns a business's raw Google Sheet rows into stock levels, sales summaries and
 * restock signals. Pure functions (parseTab / computeStock / summarise / ...) take
 * plain data so they're testable without Google; loadSnapshot() is the I/O wrapper.
 *
 * Read-only: nothing here ever writes to the sheet or to transactions/products.
 */

'use strict';

const crypto = require('crypto');
const client = require('./client');
const { norm } = require('./mapper');

const CACHE_TTL_MS = 60 * 1000;
const _cache = new Map(); // connectionId -> { at, snapshot }

// ── Parsing helpers ────────────────────────────────────────────────────────

function todayWAT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Sheet cell -> YYYY-MM-DD or null. Handles serials, ISO, and Nigerian dd/mm/yyyy. */
function parseDate(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/); // dd/mm/yyyy — Nigeria's order
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** "₦12,500", "12k", 12500 -> number; anything unparseable -> null. */
function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null || v === '') return null;
  let s = String(v).toLowerCase().replace(/[₦,\s]/g, '').replace(/^ngn/, '');
  let mult = 1;
  if (/[0-9]k$/.test(s)) { mult = 1e3; s = s.slice(0, -1); }
  else if (/[0-9]m$/.test(s)) { mult = 1e6; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * mult : null;
}

/** Same product, different typing: "Mango Juice " / "mango juices". */
function itemKey(name) {
  return String(name ?? '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/s$/, '');
}

/**
 * Raw rows -> array of { item, quantity, date, unit_price, unit_cost, total, reorder, hash }
 * for one mapped tab. Rows without an item or a usable quantity (stock tab: item only) are skipped.
 */
function parseTab(role, spec, rows) {
  const headerRow = rows[spec.headerRow] || [];
  const colOf = {};
  for (const [field, header] of Object.entries(spec.fields)) {
    const idx = headerRow.findIndex(h => norm(h) === norm(header));
    if (idx >= 0) colOf[field] = idx;
  }
  const out = [];
  const seen = new Map();
  for (const row of rows.slice(spec.headerRow + 1)) {
    const cell = (f) => (colOf[f] != null ? row[colOf[f]] : undefined);
    const item = String(cell('item') ?? '').trim();
    if (!item) continue;
    const quantity = parseNumber(cell('quantity'));
    if (role !== 'stock' && (quantity == null || quantity <= 0)) continue;
    const rec = {
      item,
      quantity,
      date: parseDate(cell('date')),
      unit_price: parseNumber(cell('unit_price')),
      unit_cost: parseNumber(cell('unit_cost')),
      total: parseNumber(cell('total')),
      reorder: parseNumber(cell('reorder')),
    };
    if (role === 'sales' || role === 'purchases') {
      if (rec.total == null && rec.unit_price != null) rec.total = rec.unit_price * quantity;
      if (rec.total == null && rec.unit_cost != null) rec.total = rec.unit_cost * quantity;
      const base = crypto.createHash('sha1')
        .update([rec.date, itemKey(item), quantity, rec.unit_price, rec.total].join('|'))
        .digest('hex').slice(0, 16);
      const n = (seen.get(base) || 0) + 1; // two genuinely identical rows are two sales
      seen.set(base, n);
      rec.hash = `${base}#${n}`;
    }
    out.push(rec);
  }
  return out;
}

// ── Stock + analytics ──────────────────────────────────────────────────────

function salesByItemSince(sales, sinceDate) {
  const m = new Map();
  for (const s of sales) {
    if (!s.date || s.date < sinceDate) continue;
    m.set(itemKey(s.item), (m.get(itemKey(s.item)) || 0) + s.quantity);
  }
  return m;
}

/**
 * Current stock per item. A Stock-tab quantity column wins; otherwise
 * purchases - sales per item. Returns [{ item, quantity, reorder, daysCover, sold7, status }].
 */
function computeStock({ stock, purchases, sales }, today = todayWAT()) {
  const rows = new Map(); // key -> { item, quantity, reorder }

  const hasStockQty = stock && stock.some(r => r.quantity != null);
  if (hasStockQty) {
    for (const r of stock) {
      if (r.quantity == null) continue;
      rows.set(itemKey(r.item), { item: r.item, quantity: r.quantity, reorder: r.reorder });
    }
  } else {
    for (const r of purchases || []) {
      const k = itemKey(r.item);
      const cur = rows.get(k) || { item: r.item, quantity: 0, reorder: null };
      cur.quantity += r.quantity;
      rows.set(k, cur);
    }
    for (const r of sales || []) {
      const k = itemKey(r.item);
      const cur = rows.get(k) || { item: r.item, quantity: 0, reorder: null };
      cur.quantity -= r.quantity;
      rows.set(k, cur);
    }
    for (const r of stock || []) { // reorder levels may still live on the Stock tab
      const cur = rows.get(itemKey(r.item));
      if (cur && r.reorder != null) cur.reorder = r.reorder;
    }
  }

  const sold7 = salesByItemSince(sales || [], addDays(today, -6));
  return [...rows.entries()].map(([k, r]) => {
    const qty = Math.max(0, r.quantity);
    const s7 = sold7.get(k) || 0;
    const daysCover = s7 > 0 ? Math.round((qty / (s7 / 7)) * 10) / 10 : null;
    let status = 'ok';
    if (qty <= 0) status = 'out';
    else if (r.reorder != null ? qty <= r.reorder : (daysCover != null && daysCover <= 3)) status = 'low';
    return { item: r.item, quantity: qty, reorder: r.reorder, sold7: s7, daysCover, status };
  }).sort((a, b) => a.item.localeCompare(b.item));
}

function periodRange(period, start, end, today = todayWAT()) {
  const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0
  switch (period) {
    case 'yesterday':  return [addDays(today, -1), addDays(today, -1)];
    case 'this_week':  return [addDays(today, -dow), today];
    case 'last_week':  return [addDays(today, -dow - 7), addDays(today, -dow - 1)];
    case 'this_month': return [today.slice(0, 8) + '01', today];
    case 'custom':     return [start || today, end || start || today];
    default:           return [today, today];
  }
}

/** Revenue, units, top sellers and purchases in a date range. */
function summarise({ sales, purchases }, [from, to]) {
  const inRange = (r) => r.date && r.date >= from && r.date <= to;
  const s = (sales || []).filter(inRange);
  const p = (purchases || []).filter(inRange);
  const byItem = new Map();
  for (const r of s) {
    const cur = byItem.get(itemKey(r.item)) || { item: r.item, units: 0, revenue: 0 };
    cur.units += r.quantity;
    cur.revenue += r.total || 0;
    byItem.set(itemKey(r.item), cur);
  }
  const byDay = new Map();
  for (const r of s) byDay.set(r.date, (byDay.get(r.date) || 0) + (r.total || 0));
  const bestDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    from, to,
    revenue: s.reduce((t, r) => t + (r.total || 0), 0),
    units_sold: s.reduce((t, r) => t + r.quantity, 0),
    sales_count: s.length,
    spent_on_stock: p.reduce((t, r) => t + (r.total || 0), 0),
    units_bought: p.reduce((t, r) => t + r.quantity, 0),
    top_items: [...byItem.values()].sort((a, b) => b.units - a.units).slice(0, 5),
    best_day: bestDay ? { date: bestDay[0], revenue: bestDay[1] } : null,
    sales_missing_amounts: s.filter(r => !r.total).length,
  };
}

// ── I/O ────────────────────────────────────────────────────────────────────

/** Read all mapped tabs for a connection. Cached ~60s so a chatty trader doesn't hammer the API. */
async function loadSnapshot(conn, { fresh = false } = {}) {
  const hit = _cache.get(conn.id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.snapshot;

  const snapshot = { stock: null, purchases: null, sales: null };
  for (const role of ['stock', 'purchases', 'sales']) {
    const spec = conn.mapping?.[role];
    if (!spec) continue;
    const rows = await client.readTab(conn.spreadsheet_id, spec.tab);
    snapshot[role] = parseTab(role, spec, rows);
  }
  _cache.set(conn.id, { at: Date.now(), snapshot });
  return snapshot;
}

function clearCache(connId) { _cache.delete(connId); }

module.exports = {
  todayWAT, addDays, parseDate, parseNumber, itemKey,
  parseTab, computeStock, periodRange, summarise,
  loadSnapshot, clearCache,
};
