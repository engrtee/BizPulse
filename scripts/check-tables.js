'use strict';
require('dotenv').config();
const { query } = require('../models/db');

async function main() {
  try {
    const res = await query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    console.log('Connected. Tables found:', res.rows.map(r => r.table_name).join(', '));
  } catch (err) {
    console.error('DB error:', err.message);
  }
  process.exit(0);
}
main();
