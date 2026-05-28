'use strict';
require('dotenv').config();
const { query } = require('../models/db');
async function main() {
  const res = await query(
    `SELECT id, name, whatsapp_number, active FROM users
     WHERE whatsapp_number LIKE '%35273030%' OR whatsapp_number LIKE '%2348035273030%'
     ORDER BY id`
  );
  console.log('Matching users:', res.rows);
  // Also show all users
  const all = await query(`SELECT id, name, whatsapp_number FROM users ORDER BY id`);
  console.log('\nAll users:');
  all.rows.forEach(r => console.log(` id=${r.id} name="${r.name}" wa="${r.whatsapp_number}"`));
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
