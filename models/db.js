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
  const run = async (sql, label) => {
    try {
      await pool.query(sql);
    } catch (err) {
      console.warn(`[DB] ${label} skipped:`, err.message);
    }
  };

  // Core tables
  await run(`CREATE TABLE IF NOT EXISTS users (
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
  )`, 'CREATE users');

  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak               INTEGER DEFAULT 0`, 'ADD streak');
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_message_date  DATE`,               'ADD first_message_date');
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_message_date   DATE`,               'ADD last_message_date');
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_messages_sent INTEGER DEFAULT 0`,  'ADD total_messages_sent');
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by         INTEGER REFERENCES users(id)`, 'ADD referred_by');

  await run(`CREATE TABLE IF NOT EXISTS transactions (
    id                SERIAL PRIMARY KEY,
    user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
    date              DATE NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE,
    revenue           NUMERIC(15,2) DEFAULT 0,
    total_expenses    NUMERIC(15,2) DEFAULT 0,
    expense_breakdown JSONB DEFAULT '{}',
    profit            NUMERIC(15,2) DEFAULT 0,
    margin            NUMERIC(6,2)  DEFAULT 0,
    customers         INTEGER DEFAULT 0,
    notes             TEXT,
    raw_message       TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE transactions');

  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS entry_method VARCHAR(20) DEFAULT 'text'`, 'ADD entry_method');

  await run(`CREATE TABLE IF NOT EXISTS inventory (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
    item_name           VARCHAR(200) NOT NULL,
    current_balance     NUMERIC(12,2) DEFAULT 0,
    total_received      NUMERIC(12,2) DEFAULT 0,
    unit_price          NUMERIC(15,2) DEFAULT 0,
    low_stock_threshold NUMERIC(12,2) DEFAULT 20,
    last_updated        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, item_name)
  )`, 'CREATE inventory');

  await run(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS total_received NUMERIC(12,2) DEFAULT 0`, 'ADD inventory.total_received');

  await run(`CREATE TABLE IF NOT EXISTS customer_logs (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    date       DATE NOT NULL DEFAULT CURRENT_DATE,
    count      INTEGER DEFAULT 0,
    notes      TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE customer_logs');

  await run(`CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    phone_number  VARCHAR(20) NOT NULL,
    direction     VARCHAR(10) NOT NULL DEFAULT 'inbound',
    message_text  TEXT,
    intent        VARCHAR(50),
    parsed_data   JSONB,
    response_sent TEXT,
    status        VARCHAR(20) DEFAULT 'received',
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE whatsapp_messages');

  await run(`CREATE INDEX IF NOT EXISTS idx_wa_messages_phone   ON whatsapp_messages(phone_number)`,   'INDEX phone');
  await run(`CREATE INDEX IF NOT EXISTS idx_wa_messages_user    ON whatsapp_messages(user_id)`,        'INDEX user');
  await run(`CREATE INDEX IF NOT EXISTS idx_wa_messages_created ON whatsapp_messages(created_at DESC)`,'INDEX created');

  console.log('✅ Database tables ready.');
}

// ─────────────────────────────────────────────
// WhatsApp message log helpers
// Used by webhook to record every inbound message and its processing result.
// ─────────────────────────────────────────────
const MessageModel = {
  /** Insert a new inbound message row. Returns the row id so it can be updated later. */
  async logInbound(phoneNumber, userId, messageText) {
    const res = await pool.query(
      `INSERT INTO whatsapp_messages (phone_number, user_id, message_text, direction, status)
       VALUES ($1, $2, $3, 'inbound', 'received')
       RETURNING id`,
      [phoneNumber, userId || null, messageText]
    );
    return res.rows[0]?.id;
  },

  /** Log an outbound message (every reply BizPulse sends). Non-blocking by design. */
  async logOutbound(phoneNumber, messageText) {
    try {
      await pool.query(
        `INSERT INTO whatsapp_messages (phone_number, direction, message_text, status)
         VALUES ($1, 'outbound', $2, 'sent')`,
        [phoneNumber, messageText ? messageText.slice(0, 2000) : null]
      );
    } catch (e) { /* non-critical — never block the send */ }
  },

  /** Update the log row after processing is complete. */
  async updateLog(id, { intent, parsedData, responseSent, status = 'processed' }) {
    if (!id) return;
    await pool.query(
      `UPDATE whatsapp_messages
       SET intent = $1, parsed_data = $2, response_sent = $3, status = $4
       WHERE id = $5`,
      [intent || null, parsedData ? JSON.stringify(parsedData) : null, responseSent || null, status, id]
    );
  },

  /** Fetch the last N messages (both inbound and outbound) for the admin dashboard. */
  async getRecent(limit = 60) {
    const res = await pool.query(
      `SELECT m.*, u.name AS user_name, u.biz_name
       FROM whatsapp_messages m
       LEFT JOIN users u ON u.id = m.user_id
                        OR (m.direction = 'outbound' AND u.whatsapp_number = m.phone_number)
       ORDER BY m.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  },

  /** Fetch all messages (inbound + outbound) for a single user, matched by user_id or phone. */
  async getByUser(userId, phoneNumber, limit = 40) {
    const res = await pool.query(
      `SELECT * FROM whatsapp_messages
       WHERE user_id = $1
          OR (direction = 'outbound' AND phone_number = $2)
       ORDER BY created_at DESC
       LIMIT $3`,
      [userId, phoneNumber || '', limit]
    );
    return res.rows;
  },
};

module.exports = { query, initDb, pool, MessageModel };
