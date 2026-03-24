/**
 * models/db.js
 * PostgreSQL connection pool.
 * All models import { query } from here — never open raw connections.
 *
 * On first run, call initDb() to create tables if they don't exist.
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err.message);
});

/**
 * Run a parameterised query against the pool.
 * @param {string} text  SQL string with $1, $2 placeholders
 * @param {Array}  params Values array
 */
const query = (text, params) => pool.query(text, params);

/**
 * Create all tables on first run.
 * Safe to call repeatedly — uses CREATE TABLE IF NOT EXISTS.
 */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                   SERIAL PRIMARY KEY,
      name                 VARCHAR(100) NOT NULL,
      email                VARCHAR(255) UNIQUE NOT NULL,
      biz_name             VARCHAR(200),
      biz_type             VARCHAR(100),
      state                VARCHAR(100),
      whatsapp_number      VARCHAR(20) UNIQUE,
      sheet_id             VARCHAR(200),
      google_access_token  TEXT,
      google_refresh_token TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      active               BOOLEAN DEFAULT TRUE,
      last_entry_date      DATE,
      streak               INTEGER DEFAULT 0
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0;

    CREATE TABLE IF NOT EXISTS transactions (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
      date             DATE NOT NULL DEFAULT CURRENT_DATE,
      revenue          NUMERIC(15, 2) DEFAULT 0,
      total_expenses   NUMERIC(15, 2) DEFAULT 0,
      expense_breakdown JSONB DEFAULT '{}',
      profit           NUMERIC(15, 2) DEFAULT 0,
      margin           NUMERIC(6, 2) DEFAULT 0,
      customers        INTEGER DEFAULT 0,
      notes            TEXT,
      raw_message      TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
      item_name           VARCHAR(200) NOT NULL,
      current_balance     NUMERIC(12, 2) DEFAULT 0,
      unit_price          NUMERIC(15, 2) DEFAULT 0,
      low_stock_threshold NUMERIC(12, 2) DEFAULT 20,
      last_updated        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, item_name)
    );

    CREATE TABLE IF NOT EXISTS customer_logs (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      date       DATE NOT NULL DEFAULT CURRENT_DATE,
      count      INTEGER DEFAULT 0,
      notes      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('✅ Database tables ready.');
}

module.exports = { query, initDb, pool };
