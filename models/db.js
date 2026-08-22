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
 * Run a series of queries atomically (A1-8). Checks out a dedicated client,
 * BEGINs, hands the caller a transaction-scoped query() function, then
 * COMMITs on success or ROLLBACKs on any thrown error — always releasing
 * the client back to the pool.
 *
 * @param {(txQuery: Function) => Promise<any>} fn
 * @returns {Promise<any>} whatever fn returns
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txQuery = (text, params) => client.query(text, params);
    const result = await fn(txQuery);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

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

  // margin_basis distinguishes what transactions.margin actually means on a given row (Fix 2):
  // 'net_of_expenses' — margin = (revenue - all expenses) / revenue, for daily-aggregate entries
  // 'gross_cogs'       — margin = (sale price - cost of goods sold) / sale price, for a single Kemi sale
  // 'not_applicable'   — margin is NULL/not meaningful on this row (debt repayments, voids/corrections)
  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS margin_basis VARCHAR(20) DEFAULT 'net_of_expenses'`, 'ADD margin_basis');
  await run(`ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_margin_basis_check`, 'DROP old margin_basis check');
  await run(`ALTER TABLE transactions ADD CONSTRAINT transactions_margin_basis_check
    CHECK (margin_basis IN ('net_of_expenses', 'gross_cogs', 'not_applicable'))`, 'ADD margin_basis check');
  await run(`CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date DESC)`, 'INDEX transactions user_date');

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
    date       DATE NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE,
    count      INTEGER DEFAULT 0,
    notes      TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE customer_logs');
  await run(`ALTER TABLE customer_logs ALTER COLUMN date SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE`, 'WAT default customer_logs.date');

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

  await run(`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS whatsapp_message_id VARCHAR(100)`, 'ADD whatsapp_message_id');
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_msgid ON whatsapp_messages(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL`, 'INDEX msgid');
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

  // ── Task 1: Opening stock flag on users ──────────────────────────────
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS opening_stock_logged    BOOLEAN   DEFAULT false`, 'ADD opening_stock_logged');
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS opening_stock_logged_at TIMESTAMPTZ`,             'ADD opening_stock_logged_at');

  // ── Task 1: Pending entries (parse confirmation before writing to DB) ─
  await run(`CREATE TABLE IF NOT EXISTS pending_entries (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
    entry_type       VARCHAR(50) NOT NULL,
    parsed_data      JSONB NOT NULL,
    original_message TEXT NOT NULL,
    status           VARCHAR(20) DEFAULT 'pending',
    reminder_sent    BOOLEAN DEFAULT false,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    confirmed_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ DEFAULT NOW() + INTERVAL '4 hours'
  )`, 'CREATE pending_entries');
  await run(`CREATE INDEX IF NOT EXISTS idx_pending_user_status ON pending_entries(user_id, status, created_at DESC)`, 'INDEX pending_entries');

  // ── Task 2: Products ──────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS products (
    id                     SERIAL PRIMARY KEY,
    user_id                INTEGER REFERENCES users(id) ON DELETE CASCADE,
    product_name           VARCHAR(200) NOT NULL,
    product_name_normalized VARCHAR(200) NOT NULL,
    unit                   VARCHAR(50) DEFAULT 'units',
    last_purchase_price    NUMERIC(12,2),
    last_sale_price        NUMERIC(12,2),
    current_stock          NUMERIC(12,2) DEFAULT 0,
    total_ever_received    NUMERIC(12,2) DEFAULT 0,
    is_active              BOOLEAN DEFAULT true,
    created_at             TIMESTAMPTZ DEFAULT NOW(),
    updated_at             TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, product_name_normalized)
  )`, 'CREATE products');
  await run(`CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id, is_active)`, 'INDEX products');

  // ── Task 2: Product transactions ──────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS product_transactions (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
    product_id       INTEGER REFERENCES products(id) ON DELETE CASCADE,
    transaction_type VARCHAR(20) NOT NULL,
    quantity         NUMERIC(12,2),
    unit_price       NUMERIC(12,2),
    total_amount     NUMERIC(12,2),
    transaction_date DATE NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE,
    daily_entry_id   INTEGER,
    notes            VARCHAR(500),
    created_at       TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE product_transactions');
  await run(`CREATE INDEX IF NOT EXISTS idx_pt_user_date    ON product_transactions(user_id, transaction_date DESC)`,   'INDEX pt_user_date');
  await run(`CREATE INDEX IF NOT EXISTS idx_pt_product_date ON product_transactions(product_id, transaction_date DESC)`, 'INDEX pt_product');
  await run(`ALTER TABLE product_transactions ALTER COLUMN transaction_date SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE`, 'WAT default product_transactions.transaction_date');

  // ── Task 2: Stock alerts sent (one alert per product per day) ─────────
  await run(`CREATE TABLE IF NOT EXISTS stock_alerts_sent (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
    alert_date DATE NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE,
    alert_type VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE stock_alerts_sent');
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_alert_daily ON stock_alerts_sent(user_id, product_id, alert_date, alert_type)`, 'UNIQUE INDEX stock_alerts_sent');
  await run(`ALTER TABLE stock_alerts_sent ALTER COLUMN alert_date SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE`, 'WAT default stock_alerts_sent.alert_date');

  // ── Task 3: Product name dictionary ──────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS product_name_dictionary (
    id          SERIAL PRIMARY KEY,
    variant     VARCHAR(200) NOT NULL UNIQUE,
    normalised  VARCHAR(200) NOT NULL,
    category    VARCHAR(100),
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE product_name_dictionary');

  await run(`INSERT INTO product_name_dictionary (variant, normalised, category) VALUES
    -- Perfume / fragrance oils
    ('oud',             'Oud oil',         'fragrance'),
    ('ud oil',          'Oud oil',         'fragrance'),
    ('oudh',            'Oud oil',         'fragrance'),
    ('aoud',            'Oud oil',         'fragrance'),
    ('rose oil',        'Rose oil',        'fragrance'),
    ('rose water oil',  'Rose oil',        'fragrance'),
    ('musk oil',        'Musk oil',        'fragrance'),
    ('white musk',      'Musk oil',        'fragrance'),
    ('musk',            'Musk oil',        'fragrance'),
    ('amber oil',       'Amber oil',       'fragrance'),
    ('ambergris',       'Amber oil',       'fragrance'),
    ('sandalwood',      'Sandalwood oil',  'fragrance'),
    ('sandal oil',      'Sandalwood oil',  'fragrance'),
    ('lavender oil',    'Lavender oil',    'fragrance'),
    -- Fashion / fabric
    ('ankara',          'Ankara fabric',   'fashion'),
    ('ankara fabric',   'Ankara fabric',   'fashion'),
    ('ankara cloth',    'Ankara fabric',   'fashion'),
    ('ankara print',    'Ankara fabric',   'fashion'),
    ('lace',            'Lace fabric',     'fashion'),
    ('lace fabric',     'Lace fabric',     'fashion'),
    ('lace material',   'Lace fabric',     'fashion'),
    ('french lace',     'Lace fabric',     'fashion'),
    ('thread',          'Thread',          'fashion'),
    ('sewing thread',   'Thread',          'fashion'),
    ('buttons',         'Buttons',         'fashion'),
    ('button',          'Buttons',         'fashion'),
    ('zip',             'Zipper',          'fashion'),
    ('zipper',          'Zipper',          'fashion'),
    -- Food / groceries
    ('indomie',         'Indomie',         'food'),
    ('noodles',         'Indomie',         'food'),
    ('indomie noodles', 'Indomie',         'food'),
    ('rice',            'Rice',            'food'),
    ('bag of rice',     'Rice',            'food'),
    ('beans',           'Beans',           'food'),
    ('black eyed beans','Beans',           'food'),
    ('garri',           'Garri',           'food'),
    ('gari',            'Garri',           'food'),
    ('palm oil',        'Palm oil',        'food'),
    ('red oil',         'Palm oil',        'food'),
    ('groundnut oil',   'Vegetable oil',   'food'),
    ('veg oil',         'Vegetable oil',   'food'),
    ('vegetable oil',   'Vegetable oil',   'food'),
    ('tomatoes',        'Tomatoes',        'food'),
    ('fresh tomatoes',  'Tomatoes',        'food'),
    ('pepper',          'Pepper',          'food'),
    ('tatashe',         'Pepper',          'food'),
    ('rodo',            'Pepper',          'food'),
    ('onions',          'Onions',          'food'),
    ('onion',           'Onions',          'food'),
    -- Beverages / dairy
    ('peak',            'Peak Milk',       'beverage'),
    ('peak milk',       'Peak Milk',       'beverage'),
    ('peak tin',        'Peak Milk',       'beverage'),
    ('cowbell',         'Cowbell Milk',    'beverage'),
    ('cow bell',        'Cowbell Milk',    'beverage'),
    ('cowbell milk',    'Cowbell Milk',    'beverage'),
    ('milo',            'Milo',            'beverage'),
    ('milo tin',        'Milo',            'beverage'),
    ('bournvita',       'Bournvita',       'beverage'),
    ('capri',           'Caprisonne',      'beverage'),
    ('caprisonne',      'Caprisonne',      'beverage'),
    ('capri sun',       'Caprisonne',      'beverage'),
    ('eva water',       'Eva Water',       'beverage'),
    ('eva',             'Eva Water',       'beverage'),
    ('swan water',      'Swan Water',      'beverage'),
    -- Biscuits / snacks
    ('cabin',           'Cabin Biscuits',  'snacks'),
    ('cabin biscuit',   'Cabin Biscuits',  'snacks'),
    ('digestive',       'Digestive',       'snacks'),
    ('crackers',        'Crackers',        'snacks'),
    -- Golden Morn
    ('golden morn',     'Golden Morn',     'food'),
    ('goldenmorn',      'Golden Morn',     'food')
  ON CONFLICT (variant) DO NOTHING`, 'SEED product_name_dictionary');

  // ── Task 3: Media processing log ─────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS media_log (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    media_type    VARCHAR(20) NOT NULL,
    intent        VARCHAR(50),
    parse_success BOOLEAN,
    product_count INTEGER DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE media_log');

  // ── Feature 6: Summary frequency preference ───────────────────────────
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS summary_frequency VARCHAR(20) DEFAULT 'daily'`, 'ADD summary_frequency');

  // ── Feature 8: Wholesale channel on product transactions ──────────────
  await run(`ALTER TABLE product_transactions ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'retail'`, 'ADD pt.channel');

  // ── Crowdsourced learning: raw correction signals ─────────────────────
  await run(`CREATE TABLE IF NOT EXISTS parse_corrections (
    id                    SERIAL PRIMARY KEY,
    user_id               INTEGER REFERENCES users(id) ON DELETE CASCADE,
    user_state            TEXT,
    original_message      TEXT NOT NULL,
    original_type         TEXT,
    original_parsed_data  JSONB,
    corrected_message     TEXT,
    corrected_type        TEXT,
    corrected_parsed_data JSONB,
    phrase_key            TEXT NOT NULL,
    learn_type            TEXT NOT NULL,
    created_at            TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE parse_corrections');
  await run(`CREATE INDEX IF NOT EXISTS idx_corrections_phrase ON parse_corrections(phrase_key, learn_type)`, 'INDEX parse_corrections');

  // ── Crowdsourced learning: promoted phrases injected into Gemini ───────
  await run(`CREATE TABLE IF NOT EXISTS learned_phrases (
    id               SERIAL PRIMARY KEY,
    phrase_key       TEXT NOT NULL,
    learn_type       TEXT NOT NULL,
    maps_to          TEXT NOT NULL,
    correction_count INTEGER DEFAULT 0,
    unique_users     INTEGER DEFAULT 0,
    unique_states    INTEGER DEFAULT 0,
    status           TEXT DEFAULT 'pending_review',
    example_message  TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(phrase_key, learn_type)
  )`, 'CREATE learned_phrases');
  await run(`CREATE INDEX IF NOT EXISTS idx_learned_status ON learned_phrases(status)`, 'INDEX learned_phrases');

  // ── Credit / cash sale tracking ──────────────────────────────────────
  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sale_type VARCHAR(20) DEFAULT 'cash'`, 'ADD transactions.sale_type');
  await run(`ALTER TABLE product_transactions ADD COLUMN IF NOT EXISTS sale_type VARCHAR(20) DEFAULT 'cash'`, 'ADD pt.sale_type');

  await run(`CREATE TABLE IF NOT EXISTS debtors (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    debtor_name  VARCHAR(200) NOT NULL,
    amount       NUMERIC(15,2) NOT NULL DEFAULT 0,
    amount_paid  NUMERIC(15,2) NOT NULL DEFAULT 0,
    product_name VARCHAR(200),
    status       VARCHAR(20) DEFAULT 'pending',
    notes        TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    paid_at      TIMESTAMPTZ
  )`, 'CREATE debtors');
  await run(`CREATE INDEX IF NOT EXISTS idx_debtors_user_status ON debtors(user_id, status)`, 'INDEX debtors');

  // ── Batch 1 (A1-3): customers (trader's named contacts, on-demand phone capture) ─
  await run(`CREATE TABLE IF NOT EXISTS customers (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name          VARCHAR(200),
    phone         VARCHAR(20) NOT NULL,
    opted_out     BOOLEAN DEFAULT false,
    opted_out_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, phone)
  )`, 'CREATE customers');
  await run(`CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)`, 'INDEX customers phone');

  // ── Batch 1 (A1-3): debt_payments — append-only ledger backing DebtorModel.markPaid ─
  await run(`CREATE TABLE IF NOT EXISTS debt_payments (
    id         SERIAL PRIMARY KEY,
    debtor_id  INTEGER REFERENCES debtors(id) ON DELETE CASCADE,
    amount     NUMERIC(15,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE debt_payments');
  await run(`CREATE INDEX IF NOT EXISTS idx_debt_payments_debtor ON debt_payments(debtor_id)`, 'INDEX debt_payments');

  // ── Batch 1 (A1-3): debtors extensions for customer linking + reminders/disputes ─
  await run(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id)`, 'ADD debtors.customer_id');
  await run(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS disputed BOOLEAN DEFAULT false`, 'ADD debtors.disputed');
  await run(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ`, 'ADD debtors.disputed_at');
  await run(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ`, 'ADD debtors.last_reminder_sent_at');

  // ── Batch 2: receipt_counters — atomic per-trader sequence numbers ───────
  // A single UPSERT statement is serialized per-row by Postgres, so this is
  // race-safe under concurrent generate_receipt calls with no explicit locking.
  await run(`CREATE TABLE IF NOT EXISTS receipt_counters (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    next_number INTEGER NOT NULL DEFAULT 1
  )`, 'CREATE receipt_counters');

  // ── Batch 2: receipts — generate_receipt Kemi tool's records ──────────────
  await run(`CREATE TABLE IF NOT EXISTS receipts (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    customer_name   VARCHAR(200),
    items           JSONB NOT NULL DEFAULT '[]',
    total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
    payment_method  VARCHAR(20) DEFAULT 'cash',
    debtor_id       INTEGER REFERENCES debtors(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE receipts');
  await run(`CREATE INDEX IF NOT EXISTS idx_receipts_user ON receipts(user_id, created_at DESC)`, 'INDEX receipts');

  // ── Batch 3: push_log — shared weekly send-volume budget across all proactive pushes ─
  await run(`CREATE TABLE IF NOT EXISTS push_log (
    id        SERIAL PRIMARY KEY,
    user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
    push_type VARCHAR(50) NOT NULL,
    sent_at   TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE push_log');
  await run(`CREATE INDEX IF NOT EXISTS idx_push_log_user_time ON push_log(user_id, sent_at DESC)`, 'INDEX push_log');

  // ── Layer 0: WhatsApp-native onboarding sessions ─────────────────────
  await run(`CREATE TABLE IF NOT EXISTS onboarding_sessions (
    phone       TEXT PRIMARY KEY,
    step        TEXT NOT NULL DEFAULT 'name',
    collected   JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '6 hours'
  )`, 'CREATE onboarding_sessions');
  await run(`ALTER TABLE onboarding_sessions ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '6 hours'`, 'EXTEND onboarding session TTL');

  // ── AI inference log (training dataset capture) ───────────────────────
  // Every Gemini parse call is logged here. outcome is filled in when the
  // user confirms (YES) or edits — giving us labeled fine-tuning data.
  await run(`CREATE TABLE IF NOT EXISTS ai_inference_log (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    call_type    VARCHAR(30) NOT NULL,
    model        VARCHAR(60) NOT NULL,
    input_text   TEXT NOT NULL,
    output_text  TEXT NOT NULL,
    parsed_type  VARCHAR(30),
    outcome      VARCHAR(20),
    latency_ms   INTEGER,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE ai_inference_log');
  await run(`CREATE INDEX IF NOT EXISTS idx_ailog_user   ON ai_inference_log(user_id, created_at DESC)`, 'INDEX ailog_user');
  await run(`CREATE INDEX IF NOT EXISTS idx_ailog_outcome ON ai_inference_log(outcome, call_type)`,       'INDEX ailog_outcome');

  // ── Kemi Agent tables ────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS conversation_history (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    whatsapp_number VARCHAR     NOT NULL,
    role            VARCHAR     NOT NULL CHECK (role IN ('user','assistant')),
    content         TEXT        NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now(),
    session_date    DATE        DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE
  )`, 'CREATE conversation_history');
  await run(`CREATE INDEX IF NOT EXISTS idx_conv_hist_number_date
    ON conversation_history(whatsapp_number, created_at DESC)`, 'INDEX conversation_history');
  await run(`ALTER TABLE conversation_history ALTER COLUMN session_date SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE`, 'WAT default conversation_history.session_date');

  await run(`CREATE TABLE IF NOT EXISTS trader_facts (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    whatsapp_number         VARCHAR     UNIQUE NOT NULL,
    language_preference     VARCHAR     DEFAULT 'auto',
    business_type           VARCHAR,
    top_products            JSONB       DEFAULT '[]',
    typical_lead_time_days  INTEGER     DEFAULT 2,
    rolling_summary         TEXT,
    summary_updated_at      TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ DEFAULT now()
  )`, 'CREATE trader_facts');

  await run(`CREATE TABLE IF NOT EXISTS debts (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    whatsapp_number VARCHAR     NOT NULL,
    debtor_name     VARCHAR     NOT NULL,
    amount          BIGINT      NOT NULL,
    item            VARCHAR,
    note            TEXT,
    status          VARCHAR     DEFAULT 'outstanding'
                    CHECK (status IN ('outstanding','settled')),
    created_at      TIMESTAMPTZ DEFAULT now(),
    settled_at      TIMESTAMPTZ
  )`, 'CREATE debts');
  await run(`CREATE INDEX IF NOT EXISTS idx_debts_number_status
    ON debts(whatsapp_number, status)`, 'INDEX debts');

  await run(`CREATE TABLE IF NOT EXISTS goals (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    whatsapp_number VARCHAR     NOT NULL,
    type            VARCHAR     NOT NULL CHECK (type IN ('revenue','profit')),
    amount          BIGINT      NOT NULL,
    period          VARCHAR     NOT NULL CHECK (period IN ('daily','weekly','monthly')),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
  )`, 'CREATE goals');
  await run(`CREATE INDEX IF NOT EXISTS idx_goals_number ON goals(whatsapp_number)`, 'INDEX goals');

  // ── fuzzystrmatch extension (required for LEVENSHTEIN in search_products tool) ─
  await run(`CREATE EXTENSION IF NOT EXISTS fuzzystrmatch`, 'CREATE EXTENSION fuzzystrmatch');

  // ── Goals unique constraint — deduplicate existing rows then enforce uniqueness ─
  await run(`
    DELETE FROM goals g1
    USING goals g2
    WHERE g1.whatsapp_number = g2.whatsapp_number
      AND g1.type = g2.type
      AND g1.period = g2.period
      AND g1.created_at < g2.created_at
  `, 'DEDUP goals');
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_unique ON goals(whatsapp_number, type, period)`, 'UNIQUE INDEX goals');

  await run(`CREATE TABLE IF NOT EXISTS user_sessions (
    token       TEXT         PRIMARY KEY,
    user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    expires_at  TIMESTAMPTZ  DEFAULT NOW() + INTERVAL '30 days'
  )`, 'CREATE user_sessions');
  await run(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)`, 'INDEX user_sessions');

  // ── Stock intelligence materialized view (Kemi agent) ──────────────────────────
  // Only created if it doesn't exist. Refreshed every 15 min by digest.js cron.
  await run(`CREATE MATERIALIZED VIEW IF NOT EXISTS stock_intelligence_mv AS
  WITH
    sales_7d AS (
      SELECT
        pt.user_id,
        pt.product_id,
        COALESCE(SUM(pt.quantity), 0)::NUMERIC / 7.0 AS velocity_7d
      FROM product_transactions pt
      WHERE pt.transaction_type = 'sale'
        AND pt.created_at > NOW() - INTERVAL '7 days'
      GROUP BY pt.user_id, pt.product_id
    ),
    sales_28d AS (
      SELECT
        pt.user_id,
        pt.product_id,
        COALESCE(SUM(pt.quantity), 0)::NUMERIC / 28.0 AS velocity_28d
      FROM product_transactions pt
      WHERE pt.transaction_type = 'sale'
        AND pt.created_at > NOW() - INTERVAL '28 days'
      GROUP BY pt.user_id, pt.product_id
    ),
    last_sold AS (
      SELECT DISTINCT ON (product_id)
        product_id,
        created_at AS last_sold_at
      FROM product_transactions
      WHERE transaction_type = 'sale'
      ORDER BY product_id, created_at DESC
    )
  SELECT
    u.whatsapp_number,
    p.id            AS product_id,
    p.product_name,
    p.unit,
    p.current_stock,
    COALESCE(s7.velocity_7d,   0)::NUMERIC AS velocity_7d,
    COALESCE(s28.velocity_28d, 0)::NUMERIC AS velocity_28d,
    COALESCE(tf.typical_lead_time_days, 2) AS lead_time_days,
    CASE
      WHEN COALESCE(s7.velocity_7d, 0) <= 0 THEN NULL
      ELSE ROUND((p.current_stock / s7.velocity_7d)::NUMERIC, 1)
    END AS days_of_cover,
    CASE
      WHEN COALESCE(s28.velocity_28d, 0) <= 0 THEN NULL
      ELSE ROUND((COALESCE(s7.velocity_7d, 0) / s28.velocity_28d)::NUMERIC, 2)
    END AS trend,
    CASE
      WHEN COALESCE(s7.velocity_7d, 0) <= 0 THEN FALSE
      WHEN (p.current_stock / NULLIF(s7.velocity_7d, 0))
           < COALESCE(tf.typical_lead_time_days, 2) * 1.5 THEN TRUE
      ELSE FALSE
    END AS reorder_suggested,
    CASE
      WHEN p.current_stock <= 0                                    THEN 100
      WHEN COALESCE(s7.velocity_7d, 0) <= 0                       THEN 0
      WHEN p.current_stock / s7.velocity_7d < 1                   THEN 90
      WHEN p.current_stock / s7.velocity_7d < 2                   THEN 70
      WHEN p.current_stock / s7.velocity_7d
           < COALESCE(tf.typical_lead_time_days, 2) * 1.5         THEN 50
      ELSE GREATEST(0, LEAST(30,
             30 - ROUND((p.current_stock / s7.velocity_7d) * 3)::INTEGER))
    END AS stockout_risk_score,
    CASE
      WHEN COALESCE(s28.velocity_28d, 0) < 0.5
        AND (
          COALESCE(s7.velocity_7d, 0) <= 0
          OR p.current_stock / NULLIF(s7.velocity_7d, 0) > 14
        ) THEN TRUE
      ELSE FALSE
    END AS is_slow_mover,
    ls.last_sold_at
  FROM products p
  JOIN  users        u  ON u.id = p.user_id
  LEFT JOIN sales_7d  s7  ON s7.user_id  = p.user_id AND s7.product_id  = p.id
  LEFT JOIN sales_28d s28 ON s28.user_id = p.user_id AND s28.product_id = p.id
  LEFT JOIN last_sold ls  ON ls.product_id = p.id
  LEFT JOIN trader_facts tf ON tf.whatsapp_number = u.whatsapp_number
  WHERE p.is_active = TRUE`, 'CREATE stock_intelligence_mv');

  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_intel_mv_unique
    ON stock_intelligence_mv(whatsapp_number, product_id)`, 'UNIQUE INDEX stock_intelligence_mv');

  // ── Reseller Ordering Agent tables (separate product, shares this DB/number/hosting) ─
  // Every table is scoped by seller_id from day one (tenant-aware, even with one seller
  // live in V1). Prefixed reseller_ to keep it grep-ably separate from BizPulse's own
  // trader/transaction schema above — this is a different product, not a Kemi feature.
  await run(`CREATE TABLE IF NOT EXISTS reseller_sellers (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(200) NOT NULL,
    business_name       VARCHAR(200) NOT NULL,
    code                VARCHAR(50) UNIQUE NOT NULL,
    whatsapp_number     VARCHAR(20) UNIQUE NOT NULL,
    bank_account_name   VARCHAR(200),
    bank_account_number VARCHAR(20),
    bank_name           VARCHAR(100),
    active              BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    otp_code            VARCHAR(10),
    otp_expires_at      TIMESTAMPTZ
  )`, 'CREATE reseller_sellers');

  await run(`CREATE TABLE IF NOT EXISTS reseller_catalog_items (
    id                   SERIAL PRIMARY KEY,
    seller_id            INTEGER REFERENCES reseller_sellers(id) ON DELETE CASCADE,
    item_number          INTEGER NOT NULL,
    name                 VARCHAR(200) NOT NULL,
    description          TEXT,
    price_naira          NUMERIC(15,2) NOT NULL DEFAULT 0,
    variant_info         VARCHAR(200),
    source_type          VARCHAR(20) NOT NULL DEFAULT 'seller_owned'
                         CHECK (source_type IN ('seller_owned','supplier_dependent')),
    current_stock        NUMERIC(12,2),
    total_ever_received  NUMERIC(12,2) DEFAULT 0,
    is_active            BOOLEAN DEFAULT TRUE,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(seller_id, item_number)
  )`, 'CREATE reseller_catalog_items');
  await run(`CREATE INDEX IF NOT EXISTS idx_reseller_catalog_seller ON reseller_catalog_items(seller_id, is_active)`, 'INDEX reseller_catalog_items');

  // Atomic per-seller item-number sequence — same race-safe UPSERT pattern as receipt_counters.
  await run(`CREATE TABLE IF NOT EXISTS reseller_catalog_counters (
    seller_id   INTEGER PRIMARY KEY REFERENCES reseller_sellers(id) ON DELETE CASCADE,
    next_number INTEGER NOT NULL DEFAULT 1
  )`, 'CREATE reseller_catalog_counters');

  await run(`CREATE TABLE IF NOT EXISTS reseller_orders (
    id                       SERIAL PRIMARY KEY,
    seller_id                INTEGER REFERENCES reseller_sellers(id) ON DELETE CASCADE,
    customer_phone           VARCHAR(20) NOT NULL,
    customer_name            VARCHAR(200),
    status                   VARCHAR(30) NOT NULL DEFAULT 'pending_verification'
                             CHECK (status IN ('pending_verification','confirmed','declined',
                                                'awaiting_payment','payment_received','paid',
                                                'delivered','cancelled')),
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    confirmed_at             TIMESTAMPTZ,
    paid_at                  TIMESTAMPTZ,
    delivered_at             TIMESTAMPTZ,
    cancelled_at             TIMESTAMPTZ,
    payment_receipt_media_id VARCHAR(200),
    notes                    TEXT
  )`, 'CREATE reseller_orders');
  await run(`CREATE INDEX IF NOT EXISTS idx_reseller_orders_seller_status ON reseller_orders(seller_id, status)`, 'INDEX reseller_orders seller_status');
  await run(`CREATE INDEX IF NOT EXISTS idx_reseller_orders_customer ON reseller_orders(customer_phone)`, 'INDEX reseller_orders customer');

  await run(`CREATE TABLE IF NOT EXISTS reseller_order_items (
    id                    SERIAL PRIMARY KEY,
    order_id              INTEGER REFERENCES reseller_orders(id) ON DELETE CASCADE,
    catalog_item_id       INTEGER REFERENCES reseller_catalog_items(id) ON DELETE SET NULL,
    item_number_snapshot  INTEGER NOT NULL,
    item_name_snapshot    VARCHAR(200) NOT NULL,
    unit_price_snapshot   NUMERIC(15,2) NOT NULL DEFAULT 0,
    quantity              NUMERIC(10,2) NOT NULL DEFAULT 1,
    variant               VARCHAR(200),
    line_total            NUMERIC(15,2) NOT NULL DEFAULT 0
  )`, 'CREATE reseller_order_items');
  await run(`CREATE INDEX IF NOT EXISTS idx_reseller_order_items_order ON reseller_order_items(order_id)`, 'INDEX reseller_order_items');
  // Migration for tables created before ON DELETE SET NULL was added above —
  // without it, a catalog item that has ever been ordered can't be deleted.
  await run(`ALTER TABLE reseller_order_items DROP CONSTRAINT IF EXISTS reseller_order_items_catalog_item_id_fkey`, 'DROP old reseller_order_items catalog_item_id FK');
  await run(`ALTER TABLE reseller_order_items ADD CONSTRAINT reseller_order_items_catalog_item_id_fkey
    FOREIGN KEY (catalog_item_id) REFERENCES reseller_catalog_items(id) ON DELETE SET NULL`, 'ADD reseller_order_items catalog_item_id FK ON DELETE SET NULL');

  // Session-memory mapping from Section 4a: identify a customer's seller once, reuse it
  // for the rest of that relationship rather than asking again on every message.
  await run(`CREATE TABLE IF NOT EXISTS reseller_customer_seller_link (
    phone         VARCHAR(20) PRIMARY KEY,
    seller_id     INTEGER REFERENCES reseller_sellers(id) ON DELETE CASCADE,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE reseller_customer_seller_link');
  await run(`CREATE INDEX IF NOT EXISTS idx_reseller_cust_link_seller ON reseller_customer_seller_link(seller_id)`, 'INDEX reseller_customer_seller_link');

  await run(`CREATE TABLE IF NOT EXISTS reseller_conversation_history (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_phone VARCHAR(20) NOT NULL,
    role           VARCHAR     NOT NULL CHECK (role IN ('user','assistant')),
    content        TEXT        NOT NULL,
    created_at     TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE reseller_conversation_history');
  await run(`CREATE INDEX IF NOT EXISTS idx_reseller_conv_hist_phone ON reseller_conversation_history(customer_phone, created_at DESC)`, 'INDEX reseller_conversation_history');

  // Audit trail per the source prompt's Section 4 — what the agent parsed/decided each
  // turn, for debugging parse accuracy and the before/after time-saved metrics (Section 6).
  await run(`CREATE TABLE IF NOT EXISTS reseller_agent_log (
    id                  SERIAL PRIMARY KEY,
    seller_id           INTEGER REFERENCES reseller_sellers(id) ON DELETE SET NULL,
    customer_phone      VARCHAR(20),
    whatsapp_message_id VARCHAR(200),
    raw_message         TEXT,
    parsed_tool_calls   JSONB DEFAULT '[]',
    agent_response_text TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
  )`, 'CREATE reseller_agent_log');
  await run(`CREATE INDEX IF NOT EXISTS idx_reseller_agent_log_seller ON reseller_agent_log(seller_id, created_at DESC)`, 'INDEX reseller_agent_log');

  // Seller dashboard login sessions — mirrors user_sessions, fed by a WhatsApp OTP
  // (no password to remember, consistent with meeting a low-tech seller where she is).
  await run(`CREATE TABLE IF NOT EXISTS reseller_seller_sessions (
    token      TEXT        PRIMARY KEY,
    seller_id  INTEGER     NOT NULL REFERENCES reseller_sellers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days'
  )`, 'CREATE reseller_seller_sessions');
  await run(`CREATE INDEX IF NOT EXISTS idx_reseller_seller_sessions_seller ON reseller_seller_sessions(seller_id)`, 'INDEX reseller_seller_sessions');

  console.log('✅ Database tables ready.');
}

// ─────────────────────────────────────────────
// WhatsApp message log helpers
// Used by webhook to record every inbound message and its processing result.
// ─────────────────────────────────────────────
const MessageModel = {
  /**
   * Insert a new inbound message row. Returns { id, duplicate }.
   * If whatsappMessageId already exists, returns { id: existing_id, duplicate: true }
   * so the caller can skip processing.
   */
  async logInbound(phoneNumber, userId, messageText, whatsappMessageId = null) {
    // Dedup check — Meta retries can send the same message_id twice
    if (whatsappMessageId) {
      const existing = await pool.query(
        `SELECT id FROM whatsapp_messages WHERE whatsapp_message_id = $1 LIMIT 1`,
        [whatsappMessageId]
      );
      if (existing.rows.length > 0) {
        return { id: existing.rows[0].id, duplicate: true };
      }
    }
    const res = await pool.query(
      `INSERT INTO whatsapp_messages (phone_number, user_id, message_text, direction, status, whatsapp_message_id)
       VALUES ($1, $2, $3, 'inbound', 'received', $4)
       RETURNING id`,
      [phoneNumber, userId || null, messageText, whatsappMessageId || null]
    );
    return { id: res.rows[0]?.id, duplicate: false };
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

module.exports = { query, withTransaction, initDb, pool, MessageModel };
