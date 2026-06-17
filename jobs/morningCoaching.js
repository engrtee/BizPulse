/**
 * jobs/morningCoaching.js
 * Daily 7:30am WAT morning stock briefing for users who have logged opening stock.
 *
 * - Users with opening_stock_logged = true → stock traffic-light briefing
 * - Users without opening stock → skipped (onboarding prompt sent via webhook)
 *
 * Runs every day at 7:30 AM Africa/Lagos timezone.
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel       = require('../models/user');
const ProductModel    = require('../models/product');
const WhatsAppService = require('../services/whatsapp');
const { getPersona }  = require('../services/personaEngine');

// ── Main job ──────────────────────────────────────────────────────────────
async function runMorningCoaching() {
  console.log(`[Morning Coaching] 🌟 Starting at ${new Date().toISOString()}`);

  try {
    const users = await UserModel.findAllActive();

    if (users.length === 0) {
      console.log('[Morning Coaching] No active users yet.');
      return;
    }

    // Only send to users active in last 14 days who have declared opening stock
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const eligible = users.filter(u =>
      u.whatsapp_number &&
      u.opening_stock_logged &&
      u.last_message_date >= cutoffDate
    );
    const skipped  = users.filter(u => u.whatsapp_number && !u.opening_stock_logged).length;

    console.log(`[Morning Coaching] ${eligible.length} eligible (stock logged), ${skipped} skipped (no opening stock yet)`);

    for (const user of eligible) {
      try {
        const firstName = user.name.split(' ')[0];

        // Fetch persona + products in parallel
        const [persona, products] = await Promise.all([
          getPersona(user),
          ProductModel.getWithHealth(user.id),
        ]);

        if (!products || products.length === 0) {
          console.log(`[Morning Coaching] ⚠️ No products for ${user.name} — skipping`);
          continue;
        }

        // Compute staleness from the most recently updated product
        const latestUpdate = products.reduce((latest, p) => {
          const t = new Date(p.updated_at || 0).getTime();
          return t > latest ? t : latest;
        }, 0);
        const lastUpdateDaysAgo = latestUpdate
          ? Math.floor((Date.now() - latestUpdate) / (1000 * 60 * 60 * 24))
          : 99;

        const bizEmoji = persona.craft_emoji || '📊';

        await WhatsAppService.sendMorningStockBriefing(
          user.whatsapp_number, firstName, bizEmoji, products, lastUpdateDaysAgo
        );

        console.log(`[Morning Coaching] ✅ Briefing sent to ${user.name} (${products.length} products, ${lastUpdateDaysAgo}d stale)`);
      } catch (err) {
        console.error(`[Morning Coaching] ❌ Failed for ${user.name}:`, err.message);
      }
    }

    console.log('[Morning Coaching] ✅ Completed.');
  } catch (err) {
    console.error('[Morning Coaching] Fatal error:', err.message);
  }
}

// ── Schedule: 7:30 AM WAT every day ──────────────────────────────────────
cron.schedule('30 7 * * *', async () => {
  console.log('[Cron] 🌟 Morning stock briefing firing:', new Date().toISOString());
  try {
    await runMorningCoaching();
  } catch (err) {
    console.error('[Cron] Morning coaching failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });

console.log('[Cron] Morning stock briefing scheduled for 7:30 AM WAT.');

module.exports = { runMorningCoaching };
