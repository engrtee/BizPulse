/**
 * services/pushBudget.js
 * Batch 3 (A2-5/A2-7) — shared weekly send-volume budget across every
 * proactive WhatsApp push. Before this, five separate cron jobs (now six,
 * plus this batch's two new ones) each decided independently whether to
 * message a trader, with nothing coordinating total volume — an active
 * user could get a 6pm reminder, an 8pm digest, a 10am nudge, and a 7:30am
 * briefing all in one day.
 *
 * Weekly cap: 10 proactive WhatsApp sends per rolling 7 days per trader.
 * out_of_stock alerts are exempt — time-sensitive lost-revenue information,
 * not an engagement nudge — but are still logged here for admin visibility.
 */

'use strict';

const { query } = require('../models/db');

const WEEKLY_CAP = 10;
// sheet_* pushes belong to Sheets mode, an opt-in feature whose whole point is being told when
// something sells and seeing stock morning/night — the owner asked for them, so they don't spend
// the engagement-nudge budget (still logged for admin visibility).
const CAP_EXEMPT_TYPES = new Set(['out_of_stock', 'sheet_sold', 'sheet_morning', 'sheet_night']);

/** Returns true if this trader has room in their weekly budget for pushType. */
async function checkPushBudget(userId, pushType) {
  if (CAP_EXEMPT_TYPES.has(pushType)) return true;
  const res = await query(
    `SELECT COUNT(*)::int AS n FROM push_log
     WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '7 days'
       AND push_type <> ALL($2::text[])`,
    [userId, [...CAP_EXEMPT_TYPES]]
  );
  return res.rows[0].n < WEEKLY_CAP;
}

/** Record a push after it's actually been sent. */
async function recordPush(userId, pushType) {
  await query(`INSERT INTO push_log (user_id, push_type) VALUES ($1, $2)`, [userId, pushType]);
}

module.exports = { checkPushBudget, recordPush, WEEKLY_CAP, CAP_EXEMPT_TYPES };
