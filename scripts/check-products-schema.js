'use strict';
require('dotenv').config();
const { query } = require('../models/db');
async function main() {
  const res = await query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='products'
    ORDER BY ordinal_position
  `);
  console.log('products columns:');
  res.rows.forEach(r => console.log(`  ${r.column_name.padEnd(30)} ${r.data_type.padEnd(20)} nullable=${r.is_nullable}`));

  const idx = await query(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE tablename='products'
  `);
  console.log('\nproducts indexes:');
  idx.rows.forEach(r => console.log(' ', r.indexname, ':', r.indexdef));
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
