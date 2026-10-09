/**
 * services/sheets/mapper.js
 * Works out which tab is Stock / Purchases / Sales and which column is which,
 * by header name. The mapping stores header NAMES (not column letters), so staff
 * inserting a column later doesn't break anything.
 */

'use strict';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const TAB_NAMES = {
  stock:     ['stock', 'inventory', 'stocklist', 'products', 'items', 'currentstock'],
  purchases: ['purchases', 'purchase', 'bought', 'goodsbought', 'stockin', 'restock', 'supply', 'supplies', 'buying'],
  sales:     ['sales', 'sale', 'sold', 'goodssold', 'stockout', 'selling', 'orders'],
};

const FIELD_SYNONYMS = {
  item:       ['item', 'itemname', 'product', 'productname', 'goods', 'description', 'name', 'particulars', 'article'],
  quantity:   ['quantity', 'qty', 'currentstock', 'instock', 'stock', 'balance', 'remaining', 'available', 'unitssold', 'quantitysold', 'quantitybought', 'units', 'pieces', 'pcs', 'closingstock'],
  date:       ['date', 'day', 'saledate', 'dateofsale', 'purchasedate', 'datebought', 'datesold', 'timestamp', 'time'],
  unit_price: ['unitprice', 'price', 'sellingprice', 'saleprice', 'rate', 'priceperunit'],
  unit_cost:  ['unitcost', 'cost', 'costprice', 'buyingprice', 'purchaseprice', 'costperunit'],
  total:      ['total', 'totalamount', 'amount', 'value', 'totalprice', 'totalcost', 'amountpaid'],
  reorder:    ['reorderlevel', 'reorderpoint', 'minstock', 'minimum', 'min', 'lowstock', 'threshold', 'alertlevel'],
};

// Fields we look for on each tab, and which must be found for the tab to be usable.
const TAB_FIELDS = {
  stock:     { want: ['item', 'quantity', 'reorder', 'unit_cost'], need: ['item'] },
  purchases: { want: ['date', 'item', 'quantity', 'unit_cost', 'total'], need: ['item', 'quantity'] },
  sales:     { want: ['date', 'item', 'quantity', 'unit_price', 'total'], need: ['item', 'quantity'] },
};

function findTab(role, tabs) {
  const names = TAB_NAMES[role];
  const exact = tabs.find(t => names.includes(norm(t)));
  if (exact) return exact;
  return tabs.find(t => names.some(n => n.length > 3 && norm(t).includes(n))) || null;
}

/** First of the top rows that looks like a header row (>= 2 recognised headers). */
function detectHeaderRow(rows) {
  const all = new Set(Object.values(FIELD_SYNONYMS).flat());
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const hits = (rows[i] || []).filter(c => all.has(norm(c))).length;
    if (hits >= 2) return i;
  }
  return 0;
}

function mapFields(role, headers) {
  const fields = {};
  const taken = new Set();
  for (const field of TAB_FIELDS[role].want) {
    for (const syn of FIELD_SYNONYMS[field]) {
      const h = headers.find(x => norm(x) === syn && !taken.has(x));
      if (h) { fields[field] = h; taken.add(h); break; }
    }
  }
  return fields;
}

/** Optional Claude fallback for required fields the synonym pass missed. */
async function aiFill(role, headers, sampleRows, missing) {
  if (!process.env.ANTHROPIC_API_KEY) return {};
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content:
          `A Nigerian shop's "${role}" spreadsheet tab has these column headers: ${JSON.stringify(headers)}.\n` +
          `Sample rows: ${JSON.stringify(sampleRows.slice(0, 3))}.\n` +
          `Which header is: ${missing.join(', ')}? (item = product name, quantity = number of units.)\n` +
          'Reply with ONLY a JSON object like {"item":"<exact header>"}; omit any you cannot identify.',
      }],
    });
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    const out = {};
    for (const k of missing) if (headers.includes(parsed[k])) out[k] = parsed[k];
    return out;
  } catch (e) {
    console.warn('[Sheets] AI header fallback failed:', e.message);
    return {};
  }
}

/**
 * @param {string[]} tabs
 * @param {(tab:string)=>Promise<any[][]>} readTab
 * @returns {{ mapping, problems: string[] }}
 *   mapping = { stock?:{tab,headerRow,fields}, purchases?:..., sales?:... }
 */
async function buildMapping(tabs, readTab) {
  const mapping = {};
  const problems = [];

  for (const role of ['stock', 'purchases', 'sales']) {
    const tab = findTab(role, tabs);
    if (!tab) continue;
    const rows = await readTab(tab);
    if (!rows.length) { problems.push(`The "${tab}" tab is empty`); continue; }
    const headerRow = detectHeaderRow(rows);
    const headers = (rows[headerRow] || []).map(h => String(h ?? '').trim()).filter(Boolean);
    const fields = mapFields(role, headers);

    const missing = TAB_FIELDS[role].need.filter(f => !fields[f]);
    if (missing.length) {
      Object.assign(fields, await aiFill(role, headers, rows.slice(headerRow + 1), missing));
    }
    const stillMissing = TAB_FIELDS[role].need.filter(f => !fields[f]);
    if (stillMissing.length) {
      problems.push(`In the "${tab}" tab I couldn't find the ${stillMissing.join(' and ')} column`);
      continue;
    }
    mapping[role] = { tab, headerRow, fields };
  }

  if (!mapping.sales && !mapping.stock) {
    problems.push('I need at least a Sales tab or a Stock tab to work with');
  }
  if (!mapping.stock?.fields.quantity && !(mapping.purchases && mapping.sales)) {
    problems.push('I need either a Stock tab with a quantity column, or both Purchases and Sales tabs to work out what is left');
  }
  return { mapping, problems };
}

module.exports = { buildMapping, norm };
