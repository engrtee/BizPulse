/**
 * scripts/recompute-stock.js
 * A1-8 repair utility — checks (and optionally corrects) products.current_stock
 * against what the product_transactions ledger actually says it should be.
 *
 * Manual run only, same convention as scripts/migrate-legacy-debts.js.
 *
 *   node scripts/recompute-stock.js                 — check all products, report drift only
 *   node scripts/recompute-stock.js --apply          — check all products, fix any drift found
 *   node scripts/recompute-stock.js --user 2348012345678         — scope to one trader
 *   node scripts/recompute-stock.js --user 234... --apply
 */

'use strict';

require('dotenv').config();
const { query, initDb } = require('../models/db');
const ProductModel = require('../models/product');

async function run({ apply, whatsappNumber } = {}) {
  const params = [];
  let userFilter = '';
  if (whatsappNumber) {
    userFilter = `WHERE u.whatsapp_number = $1`;
    params.push(whatsappNumber);
  }

  const res = await query(
    `SELECT p.id, p.product_name, u.name AS user_name
     FROM products p
     JOIN users u ON u.id = p.user_id
     ${userFilter}
     ORDER BY p.user_id, p.product_name`,
    params
  );

  console.log(`[Recompute] Checking ${res.rows.length} product(s)${whatsappNumber ? ` for ${whatsappNumber}` : ''}...`);

  let checked = 0, drifted = 0, fixed = 0;

  for (const row of res.rows) {
    checked++;
    const result = apply
      ? await ProductModel.applyRecompute(row.id)
      : await ProductModel.recomputeStock(row.id);

    if (result?.drifted) {
      drifted++;
      const action = apply ? 'FIXED' : 'DRIFT';
      console.log(`[Recompute] ${action} — "${row.product_name}" (${row.user_name}): live=${result.live} ledger=${result.ledger}`);
      if (apply) fixed++;
    }
  }

  console.log(`[Recompute] Done — checked:${checked} drifted:${drifted}${apply ? ` fixed:${fixed}` : ' (dry run — pass --apply to fix)'}`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const userIdx = args.indexOf('--user');
  const whatsappNumber = userIdx !== -1 ? args[userIdx + 1] : null;

  initDb()
    .then(() => run({ apply, whatsappNumber }))
    .then(() => process.exit(0))
    .catch(e => { console.error('Recompute failed:', e.message); process.exit(1); });
}

module.exports = { run };
