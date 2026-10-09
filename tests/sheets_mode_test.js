// Offline test for Sheets mode: parsing, stock maths, summaries, tool gating. No Google/DB needed.
'use strict';
const assert = require('assert');
const data = require('../services/sheets/data');
const { toolsFor } = require('../src/agent/tools');

const mapping = {
  stock:     { tab: 'Stock',     headerRow: 0, fields: { item: 'Item Name', reorder: 'Min Stock' } },
  purchases: { tab: 'Purchases', headerRow: 0, fields: { date: 'Date', item: 'Product', quantity: 'Qty', unit_cost: 'Cost' } },
  sales:     { tab: 'Sales',     headerRow: 1, fields: { date: 'Date', item: 'Product', quantity: 'Qty', unit_price: 'Price' } },
};
const today = data.todayWAT();
const serial = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);

const stock = data.parseTab('stock', mapping.stock, [['Item Name', 'Min Stock'], ['Mango Juice', 5], ['Rice 50kg', '']]);
const purchases = data.parseTab('purchases', mapping.purchases, [
  ['Date', 'Product', 'Qty', 'Cost'],
  [serial(data.addDays(today, -3)), 'Mango Juice', 30, 500],
  ['01/10/2026', 'Rice 50kg', 10, '₦45,000'],
]);
const sales = data.parseTab('sales', mapping.sales, [
  ['Sales log (junk title row)'],
  ['Date', 'Product', 'Qty', 'Price'],
  [serial(today), 'mango juices', 4, 800],
  [serial(today), 'mango juices', 4, 800],           // identical row = a second real sale
  [serial(data.addDays(today, -1)), 'Rice 50kg', 10, '60k'],
  [serial(today), '', 3, 100],                        // no item -> skipped
]);

assert.strictEqual(data.parseDate('01/10/2026'), '2026-10-01', 'dd/mm/yyyy');
assert.strictEqual(data.parseNumber('₦45,000'), 45000);
assert.strictEqual(data.parseNumber('60k'), 60000);
assert.strictEqual(sales.length, 3);
assert.notStrictEqual(sales[0].hash, sales[1].hash, 'identical rows must hash differently');

// No quantity column on Stock tab -> purchases minus sales
const st = data.computeStock({ stock, purchases, sales }, today);
const mango = st.find(s => s.item === 'Mango Juice');
const rice = st.find(s => s.item === 'Rice 50kg');
assert.strictEqual(mango.quantity, 22);            // 30 - 8
assert.strictEqual(mango.reorder, 5);
assert.strictEqual(rice.quantity, 0);              // 10 - 10
assert.strictEqual(rice.status, 'out');

const sum = data.summarise({ sales, purchases }, [today, today]);
assert.strictEqual(sum.revenue, 6400);
assert.strictEqual(sum.units_sold, 8);

// Sheets mode is read-only: no write tools offered
const names = toolsFor(true).map(t => t.name);
for (const w of ['log_sale', 'log_restock', 'log_expense', 'correct_last_entry', 'log_debt', 'generate_receipt'])
  assert(!names.includes(w), `${w} must not be available in Sheets mode`);
assert(names.includes('get_stock_level') && names.includes('disconnect_google_sheet'));
assert(toolsFor(false).some(t => t.name === 'connect_google_sheet'));
console.log('sheets_mode_test: all passed');
