/**
 * jobs/weeklyProfitNote.js
 * Batch 3 — Sunday evening WAT push summarising the trader's week
 * (revenue/profit/margin) via the weekly_profit_summary template (built in
 * Batch 0, never wired to a caller until now).
 *
 * Honest degradation: if cost price is missing for more than 30% of this
 * week's sold items, the profit figure is unreliable — say so plainly
 * instead of presenting a falsely precise number.
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel       = require('../models/user');
const WhatsAppService = require('../services/whatsapp');
const { query }       = require('../models/db');
const { checkPushBudget, recordPush } = require('../services/pushBudget');
const { calcMargin }  = require('../utils/naira');
const { todayWAT }    = require('../utils/formatter');

function weekStartWAT() {
  const today = new Date(todayWAT() + 'T12:00:00Z');
  const dayOfWeek = today.getUTCDay(); // 0 = Sun
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - daysSinceMonday);
  return start.toISOString().slice(0, 10);
}

async function getWeekTotals(userId, start, end) {
  const res = await query(
    `SELECT COALESCE(SUM(revenue), 0)::NUMERIC AS revenue,
            COALESCE(SUM(profit), 0)::NUMERIC  AS profit
     FROM transactions
     WHERE user_id = $1 AND date BETWEEN $2 AND $3`,
    [userId, start, end]
  );
  return {
    revenue: parseFloat(res.rows[0].revenue) || 0,
    profit:  parseFloat(res.rows[0].profit)  || 0,
  };
}

/** Fraction of this week's sold line-items that have no cost price on file. */
async function getMissingCostFraction(userId, start, end) {
  const res = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE p.last_purchase_price IS NULL)::int AS missing
     FROM product_transactions pt
     JOIN products p ON p.id = pt.product_id
     WHERE pt.user_id = $1 AND pt.transaction_type = 'sale'
       AND pt.transaction_date BETWEEN $2 AND $3`,
    [userId, start, end]
  );
  const { total, missing } = res.rows[0];
  return total > 0 ? missing / total : 0;
}

async function getTopProduct(userId, start, end) {
  const res = await query(
    `SELECT p.product_name, SUM(pt.total_amount)::NUMERIC AS revenue
     FROM product_transactions pt
     JOIN products p ON p.id = pt.product_id
     WHERE pt.user_id = $1 AND pt.transaction_type = 'sale'
       AND pt.transaction_date BETWEEN $2 AND $3
     GROUP BY p.product_name
     ORDER BY revenue DESC
     LIMIT 1`,
    [userId, start, end]
  );
  return res.rows[0] || null;
}

async function runWeeklyProfitNote() {
  console.log(`[Cron] 📈 Weekly profit note started at ${new Date().toISOString()}`);
  try {
    const users = await UserModel.findAllActive();
    const start = weekStartWAT();
    const end   = todayWAT();

    for (const user of users) {
      if (!user.whatsapp_number) continue;
      try {
        const { revenue, profit } = await getWeekTotals(user.id, start, end);
        if (revenue === 0 && profit === 0) continue; // no activity this week — nothing to report

        if (!(await checkPushBudget(user.id, 'weekly_profit_note'))) {
          console.log(`[Cron] ⏭ Weekly profit note skipped for ${user.name} — weekly push budget spent`);
          continue;
        }

        const margin = calcMargin(profit, revenue);

        const missingFraction = await getMissingCostFraction(user.id, start, end);
        let extraLine;
        if (missingFraction > 0.30) {
          extraLine = `Note: cost price is missing for some items this week, so profit may be understated — add it with "received X units at Y each" for a more accurate number.`;
        } else {
          const top = await getTopProduct(user.id, start, end);
          extraLine = top
            ? `Top seller: ${top.product_name} (₦${Number(top.revenue).toLocaleString('en-NG')}).`
            : '';
        }

        await WhatsAppService.sendWeeklyProfitTemplate(user.whatsapp_number, {
          firstName: user.name.split(' ')[0],
          shopName:  user.biz_name || user.name,
          revenue,
          profit,
          marginPct: margin.toFixed(1),
          extraLine,
        });
        await recordPush(user.id, 'weekly_profit_note');
        console.log(`[Cron] 📈 Weekly profit note sent to ${user.name}`);
      } catch (err) {
        console.error(`[Cron] Weekly profit note failed for ${user.name}:`, err.message);
      }
    }
    console.log('[Cron] ✅ Weekly profit note job complete.');
  } catch (err) {
    console.error('[Cron] Fatal weekly profit note error:', err.message);
  }
}

// Sunday 7:00 PM WAT
cron.schedule('0 19 * * 0', async () => {
  console.log('[Cron] 📈 Weekly profit note firing:', new Date().toISOString());
  try {
    await runWeeklyProfitNote();
  } catch (err) {
    console.error('[Cron] Weekly profit note failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });
console.log('[Cron] Weekly profit note scheduled for Sunday 7:00 PM WAT.');

module.exports = { runWeeklyProfitNote, weekStartWAT, getMissingCostFraction };
