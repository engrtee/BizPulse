'use strict';
require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/002_kemi_agent.sql'), 'utf8');

  // Split on semicolons, strip comment-only statements
  const stmts = sql
    .split(/(?<=;)/)
    .map(s => s.trim())
    .filter(s => {
      if (!s) return false;
      // Remove leading comment lines, then check if any SQL remains
      const stripped = s.replace(/^(--[^\n]*\n)+/g, '').trim();
      return stripped.length > 0;
    })
    .map(s => s.replace(/^(--[^\n]*\n)+/g, '').trim()); // strip leading comments

  for (const stmt of stmts) {
    const preview = stmt.replace(/\s+/g, ' ').substring(0, 80);
    try {
      await pool.query(stmt);
      console.log('✅', preview);
    } catch (err) {
      console.error('❌', preview);
      console.error('   Error:', err.message);
    }
  }

  await pool.end();
  console.log('\nMigration complete.');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
