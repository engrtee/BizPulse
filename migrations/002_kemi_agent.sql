-- ═══════════════════════════════════════════════════════════
-- Migration 002 — Kemi Agent
-- New tables : conversation_history, trader_facts, debts, goals
-- New view   : stock_intelligence_mv (materialized)
-- Run once against production DB.
-- NEVER drops or alters existing tables.
-- ═══════════════════════════════════════════════════════════

-- 1. Conversation history (rolling window, 7-day TTL)
CREATE TABLE IF NOT EXISTS conversation_history (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number VARCHAR     NOT NULL,
  role            VARCHAR     NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  session_date    DATE        DEFAULT CURRENT_DATE
);
CREATE INDEX IF NOT EXISTS idx_conv_hist_number_date
  ON conversation_history(whatsapp_number, created_at DESC);

-- 2. Trader facts (per-trader language prefs and rolling summary)
CREATE TABLE IF NOT EXISTS trader_facts (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number         VARCHAR     UNIQUE NOT NULL,
  language_preference     VARCHAR     DEFAULT 'auto',
  business_type           VARCHAR,
  top_products            JSONB       DEFAULT '[]',
  typical_lead_time_days  INTEGER     DEFAULT 2,
  rolling_summary         TEXT,
  summary_updated_at      TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ DEFAULT now()
);

-- 3. Debts (Kemi-native — separate from legacy debtors table)
CREATE TABLE IF NOT EXISTS debts (
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
);
CREATE INDEX IF NOT EXISTS idx_debts_number_status
  ON debts(whatsapp_number, status);

-- 4. Goals
CREATE TABLE IF NOT EXISTS goals (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number VARCHAR     NOT NULL,
  type            VARCHAR     NOT NULL CHECK (type IN ('revenue','profit')),
  amount          BIGINT      NOT NULL,
  period          VARCHAR     NOT NULL CHECK (period IN ('daily','weekly','monthly')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goals_number
  ON goals(whatsapp_number);

-- 5. Stock intelligence materialized view
--    Computed from product_transactions + products + users + trader_facts.
--    Refreshed every 15 min by cron (CONCURRENTLY once unique index exists).

DROP MATERIALIZED VIEW IF EXISTS stock_intelligence_mv;

CREATE MATERIALIZED VIEW stock_intelligence_mv AS
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

  -- days_of_cover
  CASE
    WHEN COALESCE(s7.velocity_7d, 0) <= 0 THEN NULL
    ELSE ROUND((p.current_stock / s7.velocity_7d)::NUMERIC, 1)
  END AS days_of_cover,

  -- trend: >1.2 accelerating, <0.8 decelerating
  CASE
    WHEN COALESCE(s28.velocity_28d, 0) <= 0 THEN NULL
    ELSE ROUND((COALESCE(s7.velocity_7d, 0) / s28.velocity_28d)::NUMERIC, 2)
  END AS trend,

  -- reorder_suggested
  CASE
    WHEN COALESCE(s7.velocity_7d, 0) <= 0 THEN FALSE
    WHEN (p.current_stock / NULLIF(s7.velocity_7d, 0))
         < COALESCE(tf.typical_lead_time_days, 2) * 1.5 THEN TRUE
    ELSE FALSE
  END AS reorder_suggested,

  -- stockout_risk_score 0-100
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

  -- is_slow_mover: barely selling and lots of stock remaining
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
WHERE p.is_active = TRUE;

-- Unique index enables REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX idx_stock_intel_mv_unique
  ON stock_intelligence_mv(whatsapp_number, product_id);
