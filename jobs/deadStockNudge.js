/**
 * jobs/deadStockNudge.js
 * Batch 3 — midweek WAT push naming a trader's slow-moving products, read
 * from stock_intelligence_mv.is_slow_mover (already computed — see
 * CLAUDE.md's Inventory section). Plain WhatsApp message, matching the
 * convention every other trader-facing proactive job already uses (no Meta
 * template needed — this is internal to the trader, not a third party).
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel       = require('../models/user');
const WhatsAppService = require('../services/whatsapp');
const { query }       = require('../models/db');
const { checkPushBudget, recordPush } = require('../services/pushBudget');

async function getSlowMovers(whatsappNumber) {
  const res = await query(
    `SELECT product_name, unit, current_stock, last_sold_at
     FROM stock_intelligence_mv
     WHERE whatsapp_number = $1 AND is_slow_mover = TRUE
     ORDER BY current_stock DESC
     LIMIT 5`,
    [whatsappNumber]
  );
  return res.rows;
}

function buildNudgeMessage(firstName, slowMovers) {
  const lines = slowMovers.map(p => {
    const stock = parseFloat(p.current_stock) || 0;
    const daysSinceLastSale = p.last_sold_at
      ? Math.floor((Date.now() - new Date(p.last_sold_at).getTime()) / 86400000)
      : null;
    const staleness = daysSinceLastSale !== null
      ? ` — last sold ${daysSinceLastSale} day${daysSinceLastSale === 1 ? '' : 's'} ago`
      : ' — no sales on record';
    return `• ${p.product_name}: ${stock.toLocaleString('en-NG')} ${p.unit || 'units'}${staleness}`;
  });

  return (
    `📦 ${firstName}, these items are barely moving:\n\n` +
    lines.join('\n') +
    `\n\nConsider a discount, bundle, or clearance push to free up the cash tied up in them.`
  );
}

async function runDeadStockNudge() {
  console.log(`[Cron] 🐌 Dead-stock nudge started at ${new Date().toISOString()}`);
  try {
    const users = await UserModel.findAllActive();

    for (const user of users) {
      if (!user.whatsapp_number) continue;
      try {
        const slowMovers = await getSlowMovers(user.whatsapp_number);
        if (!slowMovers || slowMovers.length === 0) continue;

        if (!(await checkPushBudget(user.id, 'dead_stock_nudge'))) {
          console.log(`[Cron] ⏭ Dead-stock nudge skipped for ${user.name} — weekly push budget spent`);
          continue;
        }

        const firstName = user.name.split(' ')[0];
        const message = buildNudgeMessage(firstName, slowMovers);

        await WhatsAppService.sendMessage(user.whatsapp_number, message);
        await recordPush(user.id, 'dead_stock_nudge');
        console.log(`[Cron] 🐌 Dead-stock nudge sent to ${user.name} (${slowMovers.length} slow movers)`);
      } catch (err) {
        console.error(`[Cron] Dead-stock nudge failed for ${user.name}:`, err.message);
      }
    }
    console.log('[Cron] ✅ Dead-stock nudge job complete.');
  } catch (err) {
    console.error('[Cron] Fatal dead-stock nudge error:', err.message);
  }
}

// Wednesday 9:00 AM WAT — clear of the morning/evening clusters
cron.schedule('0 9 * * 3', async () => {
  console.log('[Cron] 🐌 Dead-stock nudge firing:', new Date().toISOString());
  try {
    await runDeadStockNudge();
  } catch (err) {
    console.error('[Cron] Dead-stock nudge failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });
console.log('[Cron] Dead-stock nudge scheduled for Wednesday 9:00 AM WAT.');

module.exports = { runDeadStockNudge };
