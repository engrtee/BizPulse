/**
 * jobs/retentionNudge.js
 * Daily cron job that sends WhatsApp nudges to inactive users.
 * Runs at 10:00 AM WAT (9:00 AM UTC) every day.
 *
 * Nudge schedule (different message per inactivity length):
 *   Day 3:  Gentle check-in
 *   Day 5:  Streak reminder
 *   Day 7:  Concern message
 *   Day 14: Re-engagement
 *
 * NOTE: findInactiveFor(days) returns users inactive for EXACTLY that many days,
 * so each user receives at most one nudge per day.
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel       = require('../models/user');
const WhatsAppService = require('../services/whatsapp');

const NUDGE_DAYS = [3, 5, 7, 14];

function getNudgeMessage(firstName, days) {
  switch (days) {
    case 3:
      return `Hi ${firstName} 👋 How did business go today? Just send your numbers and I'll handle the rest.`;
    case 5:
      return `Hey ${firstName}, your last summary was 5 days ago. Even a quick message keeps your streak going 📊`;
    case 7:
      return `${firstName}, I haven't heard from you in a week. Everything okay? I'm here when you're ready.`;
    case 14:
      return `${firstName}, your BizPulse account is still active. Businesses that track consistently are 3x more likely to spot problems early. Ready to start again?`;
    default:
      return null;
  }
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

        const firstName = user.name.split(' ')[0];
        const message   = getNudgeMessage(firstName, days);
        if (!message) continue;

        try {
          await WhatsAppService.sendMessage(user.whatsapp_number, message);
          console.log(`[Retention] ✅ Nudged ${user.name} (day-${days})`);
        } catch (err) {
          console.error(`[Retention] ❌ Failed for ${user.name}:`, err.message);
        }
      }
    }

    console.log('[Retention] ✅ Nudge job complete.');
  } catch (err) {
    console.error('[Retention] Fatal error:', err.message);
  }
}

/**
 * Schedule: 10:00 AM WAT = 9:00 AM UTC every day.
 */
function scheduleRetentionNudge() {
  cron.schedule('0 9 * * *', runRetentionNudge, { timezone: 'UTC' });
  console.log('[Cron] Retention nudge job scheduled for 10:00 AM WAT (9:00 AM UTC).');
}

module.exports = { scheduleRetentionNudge, runRetentionNudge };
