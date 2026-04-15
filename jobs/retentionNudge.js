/**
 * jobs/retentionNudge.js
 * Daily cron job that sends personalised WhatsApp nudges to inactive users.
 * Runs at 10:00 AM WAT every day.
 *
 * Nudge schedule (different message per inactivity length):
 *   Day 3:  Gentle check-in
 *   Day 5:  Streak reminder
 *   Day 7:  Concern message
 *   Day 14: Re-engagement
 *
 * Messages are personalised using:
 *   - Business persona (craft_identity, dream_outcome, key_metric, etc.)
 *   - 4 rotating formats (A/B/C/D) based on total days logged
 *   - Never sends the same format twice in a row to the same user
 *
 * NOTE: findInactiveFor(days) returns users inactive for EXACTLY that many days,
 * so each user receives at most one nudge per day.
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel          = require('../models/user');
const WhatsAppService    = require('../services/whatsapp');
const { getPersona }     = require('../services/personaEngine');
const { buildNudgeMessage } = require('../services/nudgeBuilder');
const { logSent }        = require('../services/messageVariants');
const { query }          = require('../models/db');

const NUDGE_DAYS = [3, 5, 7, 14];

/** Plain fallback — used if personalised build fails for any reason */
function getFallbackMessage(firstName, days) {
  switch (days) {
    case 3:  return `Hi ${firstName} 👋 How did business go today? Just send your numbers and I'll handle the rest.`;
    case 5:  return `Hey ${firstName}, your last summary was 5 days ago. Even a quick message keeps your streak going 📊`;
    case 7:  return `${firstName}, I haven't heard from you in a week. Everything okay? I'm here when you're ready.`;
    case 14: return `${firstName}, your BizPulse account is still active. Businesses that track consistently are 3x more likely to spot problems early. Ready to start again?`;
    default: return null;
  }
}

/** Total distinct days a user has ever logged (for format selection) */
async function getTotalLogDays(userId) {
  const res = await query(
    `SELECT COUNT(DISTINCT date) AS total FROM transactions WHERE user_id = $1`,
    [userId]
  );
  return parseInt(res.rows[0]?.total || 0, 10);
}

/**
 * Main nudge job function.
 * Exported so it can be triggered on-demand for testing.
 */
async function runRetentionNudge() {
  console.log(`[Retention] 🔔 Nudge job started at ${new Date().toISOString()}`);

  try {
    for (const days of NUDGE_DAYS) {
      const users = await UserModel.findInactiveFor(days);

      if (users.length === 0) {
        console.log(`[Retention] No users at day-${days} inactivity.`);
        continue;
      }

      console.log(`[Retention] ${users.length} user(s) at day-${days} inactivity — sending nudges...`);

      for (const user of users) {
        if (!user.whatsapp_number) continue;

        const firstName   = user.name.split(' ')[0];
        const messageType = `retention_day${days}`;

        try {
          // Fetch persona + log days in parallel
          const [persona, totalLogDays] = await Promise.all([
            getPersona(user),
            getTotalLogDays(user.id),
          ]);

          const { text, format } = await buildNudgeMessage(
            user, persona, days, totalLogDays, messageType
          );

          await WhatsAppService.sendMessage(user.whatsapp_number, text);

          // Log the send non-blocking — never let this block message delivery
          logSent(user.id, messageType, format).catch(() => {});

          console.log(`[Retention] ✅ Nudged ${user.name} (day-${days}, format-${format})`);
        } catch (err) {
          // Personalised message failed — fall back to plain message
          console.error(`[Retention] ⚠️ Personalised nudge failed for ${user.name}:`, err.message);
          try {
            const fallback = getFallbackMessage(firstName, days);
            if (fallback) {
              await WhatsAppService.sendMessage(user.whatsapp_number, fallback);
              logSent(user.id, messageType, 'fallback').catch(() => {});
              console.log(`[Retention] ✅ Sent fallback to ${user.name} (day-${days})`);
            }
          } catch (fallbackErr) {
            console.error(`[Retention] ❌ Fallback also failed for ${user.name}:`, fallbackErr.message);
          }
        }
      }
    }

    console.log('[Retention] ✅ Nudge job complete.');
  } catch (err) {
    console.error('[Retention] Fatal error:', err.message);
  }
}

// ── Schedule — fires automatically when this module is required ──

// 10:00 AM WAT — retention nudges for inactive users
cron.schedule('0 10 * * *', async () => {
  console.log('[Retention] 🔔 Nudge job firing:', new Date().toISOString());
  try {
    await runRetentionNudge();
    console.log('[Retention] 🔔 Nudge job completed.');
  } catch (err) {
    console.error('[Retention] Nudge job failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });

console.log('[Cron] Retention nudge scheduled for 10:00 AM WAT.');

module.exports = { runRetentionNudge };
