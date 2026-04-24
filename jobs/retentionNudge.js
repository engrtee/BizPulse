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
function getFallbackMessage(user, days) {
  const firstName = (user.name || 'there').split(' ')[0];
  const biz       = (user.biz_type || '').toLowerCase();

  const isFragrance = /fragrance|perfume|oud|attar|oil|scent/i.test(biz);
  const isProvision = /provision|retail|grocery|fmcg|store|shop|supermarket/i.test(biz);
  const isFashion   = /fashion|fabric|clothing|ankara|lace|tailor|dress/i.test(biz);
  const isFood      = /food|restaurant|catering|bakery|kitchen|snack|buka/i.test(biz);
  const isBeauty    = /beauty|hair|cosmetic|salon|makeup|wig/i.test(biz);

  if (days === 3) {
    if (isFragrance)
      return `${firstName} 🧴 Three days since your last log. Your oud and rose numbers are getting stale.\nSend today's sales — one line: _sold 3 oud 8k, 2 rose 6k_`;
    if (isProvision)
      return `${firstName} 🏪 Three days without a log. Your stock levels are going stale.\nQuick update: _sold 20 indomie 3k, 10 peak milk 9k_`;
    if (isFashion)
      return `${firstName} 👗 Three days since your last entry. Let me know what sold — one line: _sold 5 yards ankara 15k, 3 yards lace 12k_`;
    if (isFood)
      return `${firstName} 🍲 Three days since your last log. What did you sell today?\nOne line: _revenue 45k, ingredients 12k_`;
    if (isBeauty)
      return `${firstName} 💅 Three days since your last log. Which products sold this week?\nOne line: _sold 2 wigs 25k, 3 relaxer 6k_`;
    return `Hi ${firstName} 👋 Three days since your last log. How did business go? Just send your numbers and I'll handle the rest.`;
  }

  if (days === 5) {
    return `Hey ${firstName}, your last log was 5 days ago. Even a quick message keeps your streak alive 📊`;
  }

  if (days === 7) {
    if (isFragrance)
      return `${firstName}, it's been a week. You don't know right now if your musk is about to run out.\nThat's a customer you lose to the seller next door.\n30 seconds: _sold 5 oud, 3 rose_ 🧴`;
    if (isProvision)
      return `${firstName}, 7 days without a log. Your stock numbers are stale — you're probably selling Indomie and Peak Milk without knowing how close you are to running out.\nWhat did you sell this week? 🏪`;
    if (isFashion)
      return `${firstName}, a week without a log. You don't know which fabrics are moving fastest right now. That's inventory decisions made blind.\n30 seconds: _sold 10 yards ankara, 5 yards lace_ 👗`;
    if (isFood)
      return `${firstName}, 7 days without a log. Your profit numbers are completely dark right now.\nWhat did you earn this week? 🍲`;
    if (isBeauty)
      return `${firstName}, a week without a log. You don't know your best-selling products right now — you're restocking by guesswork.\nQuick update: _sold 2 wigs 30k_ 💅`;
    return `${firstName}, I haven't heard from you in a week. Your stock data is going stale. I'm here when you're ready.`;
  }

  if (days === 14) {
    return (
      `${firstName}, your BizPulse account is still active — but your stock data is 14 days old.\n\n` +
      `That means your numbers no longer reflect reality. Every sale you've made without logging is a gap in your records.\n\n` +
      `Ready to start again? Just send what you sold today.`
    );
  }

  return null;
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
            const fallback = getFallbackMessage(user, days);
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
