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

  // ── Business persona library ──────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS business_personas (
    id              SERIAL PRIMARY KEY,
    business_type   VARCHAR(100) NOT NULL UNIQUE,
    craft_identity  VARCHAR(200),
    craft_emoji     VARCHAR(10),
    dream_outcome   VARCHAR(200),
    loan_use_case   VARCHAR(200),
    peak_season     VARCHAR(100),
    key_metric      VARCHAR(100),
    example_amount  INTEGER DEFAULT 30000,
    example_expense VARCHAR(100),
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE business_personas');

  // ── Message variant A/B testing layer ────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS message_variants (
    id            SERIAL PRIMARY KEY,
    message_type  VARCHAR(50) NOT NULL,
    variant_name  VARCHAR(50) NOT NULL,
    content       TEXT NOT NULL,
    is_active     BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(message_type, variant_name)
  )`, 'CREATE message_variants');

  // ── Message send + outcome log ────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS message_log (
    id                   SERIAL PRIMARY KEY,
    user_id              INTEGER REFERENCES users(id),
    message_type         VARCHAR(50),
    variant_name         VARCHAR(50),
    sent_at              TIMESTAMPTZ DEFAULT NOW(),
    user_logged_next_day BOOLEAN DEFAULT NULL,
    days_to_next_log     INTEGER DEFAULT NULL
  )`, 'CREATE message_log');

  await run(`CREATE INDEX IF NOT EXISTS idx_msg_log_user    ON message_log(user_id)`,               'INDEX msg_log_user');
  await run(`CREATE INDEX IF NOT EXISTS idx_msg_log_sent    ON message_log(sent_at DESC)`,          'INDEX msg_log_sent');
  await run(`CREATE INDEX IF NOT EXISTS idx_msg_log_outcome ON message_log(user_logged_next_day)`,  'INDEX msg_log_outcome');

  // ── Seed business personas ────────────────────────────────────────────
  await run(`INSERT INTO business_personas
    (business_type, craft_identity, craft_emoji, dream_outcome, loan_use_case, peak_season, key_metric, example_amount, example_expense)
  VALUES
    ('Fashion',        'one of Nigeria''s most sought-after fashion designers',         '👗', 'a fashion brand that outlasts you',                            'stock up ahead of your peak season',           'Christmas and wedding season',              'fabric cost per outfit',          45000, 'fabric'),
    ('Food',           'the food vendor everyone recommends',                           '🍲', 'a food business with multiple locations',                      'expand your kitchen or open a second spot',     'festive seasons and weekends',              'cost per plate',                  18000, 'ingredients'),
    ('Photography',    'one of the most sought-after photographers in your city',       '📸', 'a photography brand known across Nigeria',                     'upgrade your equipment or studio',             'wedding season and December',               'revenue per shoot',               80000, 'equipment hire'),
    ('Retail',         'a retailer with sharp business instincts',                      '🏪', 'a retail business that runs itself',                           'stock up before your busiest period',           'back to school and festive seasons',         'margin per product category',     30000, 'restocking'),
    ('Services',       'a service professional building a name in your field',          '💼', 'a service business that attracts premium clients',             'invest in equipment or team expansion',         'Q1 and Q4',                                 'revenue per client',              50000, 'operations'),
    ('Online Business','an online entrepreneur building something real',                '💻', 'a digital business with passive income',                       'invest in marketing and inventory',             'sales periods and festive seasons',          'revenue per order',               30000, 'ads and packaging'),
    ('Beauty',         'the go-to beauty professional in your area',                   '💅', 'your own salon or beauty brand',                               'open or expand your own space',                 'Christmas, Valentine''s, and wedding season', 'revenue per client visit',        25000, 'beauty products'),
    ('Agricultural',   'a farmer building real food security',                          '🌾', 'a farming operation that feeds communities and builds wealth',  'expand your farmland or equipment',             'harvest season',                            'cost per kg produced',            40000, 'farm inputs'),
    ('Manufacturing',  'a manufacturer building made-in-Nigeria products',              '🏭', 'a manufacturing brand that scales across West Africa',         'invest in machinery or raw materials',           'festive production periods',                'cost of production per unit',     60000, 'raw materials')
  ON CONFLICT (business_type) DO NOTHING`, 'SEED business_personas');

  // ── Seed retention message variants ──────────────────────────────────
  await run(`INSERT INTO message_variants (message_type, variant_name, content) VALUES
    ('retention_day3', 'variant_a', 'Hello [name], you have not logged your business numbers in 3 days. Your streak is at risk. Log today at mybizpulse.app'),
    ('retention_day3', 'variant_b', '[name] 👋 e don reach 3 days o. Your business numbers are waiting for you. Just send what you made today — I go handle the rest 💪'),
    ('retention_day3', 'variant_c', '[name], 3 days without logging. Your competitors are tracking their numbers. Are you? Send your figures now: ''made 30k today spent 5k on stock'''),
    ('retention_day5', 'variant_a', 'Hello [name], it has been 5 days since your last entry. Your financial data has a gap. Every day without a record makes your business picture less clear. Log today.'),
    ('retention_day5', 'variant_b', '[name] 👋 5 days o! I know business dey keep you busy. But just 30 seconds — send your numbers. Even one line go do the work 💪'),
    ('retention_day5', 'variant_c', '[name], 5 days without a log. Your streak is gone but your data journey does not have to be. Send your numbers right now: ''made 30k today'''),
    ('retention_day7', 'variant_a', 'Hello [name], one full week without a log. You are losing data that could support a loan application or investor conversation. Your account is still active — restart today at mybizpulse.app'),
    ('retention_day7', 'variant_b', '[name] 🙏 one whole week o. I dey miss your numbers. Life full — I understand. But come back small small. Just send anything from today.'),
    ('retention_day7', 'variant_c', '[name], 7 days. A full week of your business ran without any record. That data is gone. But today is recoverable. Send your numbers now.')
  ON CONFLICT (message_type, variant_name) DO NOTHING`, 'SEED message_variants');

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
