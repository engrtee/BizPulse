'use strict';

const { query } = require('../../models/db');

/**
 * Return today's WAT date as YYYY-MM-DD.
 */
function todayWAT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

/**
 * Return yesterday's WAT date as YYYY-MM-DD.
 */
function yesterdayWAT() {
  return new Date(Date.now() - 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

/**
 * Query stock_intelligence_mv and bucket every product into one of six lists.
 * All arithmetic is done in SQL — this function only categorises rows.
 *
 * @param {string} whatsappNumber
 * @returns {object} { urgent_restock, plan_restock, slow_movers,
 *                     trending_up, stockouts_today, healthy }
 */
async function getStockIntelligence(whatsappNumber) {
  const res = await query(
    `SELECT product_name, unit, current_stock, velocity_7d, velocity_28d,
            lead_time_days, days_of_cover, trend, reorder_suggested,
            stockout_risk_score, is_slow_mover, last_sold_at
     FROM stock_intelligence_mv
     WHERE whatsapp_number = $1
     ORDER BY stockout_risk_score DESC`,
    [whatsappNumber]
  );

  const result = {
    urgent_restock:  [],
    plan_restock:    [],
    slow_movers:     [],
    trending_up:     [],
    stockouts_today: [],
    healthy:         [],
  };

  for (const r of res.rows) {
    const stock     = parseFloat(r.current_stock)  || 0;
    const daysLeft  = r.days_of_cover !== null ? parseFloat(r.days_of_cover) : null;
    const leadTime  = parseInt(r.lead_time_days, 10) || 2;
    const trend     = r.trend !== null ? parseFloat(r.trend) : null;
    const v7        = parseFloat(r.velocity_7d)    || 0;
    const v28       = parseFloat(r.velocity_28d)   || 0;

    if (stock <= 0) {
      result.stockouts_today.push({ product: r.product_name });
      continue;
    }

    if (daysLeft !== null && daysLeft < leadTime) {
      result.urgent_restock.push({
        product:      r.product_name,
        current_stock: stock,
        days_left:    Math.round(daysLeft),
        velocity_7d:  Math.round(v7 * 10) / 10,
        unit:         r.unit || 'units',
      });
      continue;
    }

    if (daysLeft !== null && daysLeft < leadTime * 1.5) {
      result.plan_restock.push({
        product:      r.product_name,
        current_stock: stock,
        days_left:    Math.round(daysLeft),
        velocity_7d:  Math.round(v7 * 10) / 10,
        unit:         r.unit || 'units',
      });
      continue;
    }

    if (r.is_slow_mover) {
      result.slow_movers.push({
        product:       r.product_name,
        current_stock: stock,
        days_of_cover: daysLeft,
        last_sold_at:  r.last_sold_at || null,
      });
      continue;
    }

    if (trend !== null && trend > 1.2) {
      const growthPct = Math.round((trend - 1) * 100);
      result.trending_up.push({
        product:      r.product_name,
        velocity_7d:  Math.round(v7 * 10) / 10,
        velocity_28d: Math.round(v28 * 10) / 10,
        growth_pct:   growthPct,
      });
      continue;
    }

    result.healthy.push({
      product:       r.product_name,
      days_of_cover: daysLeft,
    });
  }

  return result;
}

/**
 * Assemble a complete data pack for the nightly digest.
 * Four SQL queries run in parallel — no Claude involved at this stage.
 *
 * @param {string} whatsappNumber
 * @returns {object} Combined data pack ready for narration by Claude
 */
async function getDailySummaryPack(whatsappNumber) {
  const today     = todayWAT();
  const yesterday = yesterdayWAT();

  const [todayRes, yesterdayRes, goalRes, stockIntel] = await Promise.all([

    // 1. Today's sales from product_transactions
    query(
      `SELECT
         COALESCE(SUM(pt.total_amount), 0)::NUMERIC                          AS total_revenue,
         COALESCE(SUM(pt.quantity),     0)::NUMERIC                          AS total_units,
         COUNT(*)                                                             AS transaction_count,
         json_agg(
           json_build_object(
             'product', p.product_name,
             'units_sold', pt.quantity,
             'revenue', pt.total_amount,
             'unit', p.unit
           )
           ORDER BY pt.total_amount DESC NULLS LAST
         ) FILTER (WHERE pt.id IS NOT NULL)                                  AS all_products
       FROM product_transactions pt
       JOIN products p ON p.id = pt.product_id
       JOIN users    u ON u.id = pt.user_id
       WHERE u.whatsapp_number = $1
         AND pt.transaction_date = $2
         AND pt.transaction_type = 'sale'`,
      [whatsappNumber, today]
    ),

    // 2. Yesterday's sales for comparison
    query(
      `SELECT
         COALESCE(SUM(pt.total_amount), 0)::NUMERIC AS total_revenue,
         COALESCE(SUM(pt.quantity),     0)::NUMERIC AS total_units
       FROM product_transactions pt
       JOIN users u ON u.id = pt.user_id
       WHERE u.whatsapp_number = $1
         AND pt.transaction_date = $2
         AND pt.transaction_type = 'sale'`,
      [whatsappNumber, yesterday]
    ),

    // 3. Goals for this trader
    query(
      `SELECT type, amount, period FROM goals WHERE whatsapp_number = $1`,
      [whatsappNumber]
    ),

    // 4. Stock intelligence (already async)
    getStockIntelligence(whatsappNumber),
  ]);

  const todayRow     = todayRes.rows[0]     || {};
  const yesterdayRow = yesterdayRes.rows[0] || {};

  const todayRevenue    = parseFloat(todayRow.total_revenue)     || 0;
  const todayUnits      = parseFloat(todayRow.total_units)       || 0;
  const txCount         = parseInt(todayRow.transaction_count, 10) || 0;
  const yesterdayRevenue = parseFloat(yesterdayRow.total_revenue) || 0;
  const yesterdayUnits   = parseFloat(yesterdayRow.total_units)  || 0;

  // Sort product list and pick top 3 by revenue and units
  const allProducts = Array.isArray(todayRow.all_products) ? todayRow.all_products : [];
  const topByRevenue = [...allProducts]
    .sort((a, b) => parseFloat(b.revenue) - parseFloat(a.revenue))
    .slice(0, 3);
  const topByUnits = [...allProducts]
    .sort((a, b) => parseFloat(b.units_sold) - parseFloat(a.units_sold))
    .slice(0, 3);

  // Revenue delta vs yesterday
  const revenueDelta    = todayRevenue - yesterdayRevenue;
  const revenueDeltaPct = yesterdayRevenue > 0
    ? Math.round((revenueDelta / yesterdayRevenue) * 100)
    : null;

  // Goal progress
  const goalProgress = goalRes.rows.map(g => {
    // For daily goals, compare to today; weekly/monthly would need broader query
    // — keeping it simple here, Kemi narrates from the number
    return {
      type:     g.type,
      amount:   parseInt(g.amount, 10),
      period:   g.period,
      progress: g.period === 'daily' ? todayRevenue : null,
    };
  });

  return {
    today: {
      date:              today,
      total_revenue:     todayRevenue,
      total_units:       todayUnits,
      transaction_count: txCount,
      top_by_revenue:    topByRevenue,
      top_by_units:      topByUnits,
    },
    yesterday: {
      total_revenue: yesterdayRevenue,
      total_units:   yesterdayUnits,
    },
    comparison: {
      revenue_delta:     revenueDelta,
      revenue_delta_pct: revenueDeltaPct,
      units_delta:       todayUnits - yesterdayUnits,
    },
    stock_intelligence: stockIntel,
    goal_progress:      goalProgress,
  };
}

module.exports = { getStockIntelligence, getDailySummaryPack, todayWAT, yesterdayWAT };
