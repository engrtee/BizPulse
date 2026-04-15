/**
 * services/messageVariants.js
 *
 * Logs retention nudge sends and tracks conversion outcomes.
 *
 * logSent()      — records every nudge to message_log (called after WhatsApp send)
 * trackOutcome() — marks whether a nudge led to a log entry within 48 hours
 *                  (called non-blocking inside handleDailyEntry in webhook.js)
 */

'use strict';

const { query } = require('../models/db');

/**
 * Log that a retention nudge was sent to a user.
 * Non-throwing — failure is silently swallowed so it never blocks message delivery.
 *
 * @param {number} userId       - users.id
 * @param {string} messageType  - e.g. 'retention_day3'
 * @param {string} variantName  - format letter used: 'A', 'B', 'C', or 'D'
 */
async function logSent(userId, messageType, variantName) {
  try {
    await query(
      `INSERT INTO message_log (user_id, message_type, variant_name)
       VALUES ($1, $2, $3)`,
      [userId, messageType, variantName]
    );
  } catch (err) {
    console.error('[MessageVariants] logSent error:', err.message);
  }
}

/**
 * Attribute a new log entry back to any pending nudge within the last 48 hours.
 * Called non-blocking after a successful daily_entry save.
 *
 * Updates message_log rows where:
 *   - user_id matches
 *   - user_logged_next_day is still NULL (outcome not yet recorded)
 *   - sent_at was within the last 48 hours
 *
 * @param {number} userId - users.id
 */
async function trackOutcome(userId) {
  try {
    // Get timestamp of the most recent transaction
    const txRes = await query(
      `SELECT created_at FROM transactions
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (!txRes.rows.length) return;

    const loggedAt = txRes.rows[0].created_at;

    await query(
      `UPDATE message_log
       SET
         user_logged_next_day = TRUE,
         days_to_next_log     = GREATEST(0, EXTRACT(DAY FROM ($1::TIMESTAMPTZ - sent_at))::INTEGER)
       WHERE user_id            = $2
         AND user_logged_next_day IS NULL
         AND sent_at            > ($1::TIMESTAMPTZ - INTERVAL '48 hours')`,
      [loggedAt, userId]
    );
  } catch (err) {
    console.error('[MessageVariants] trackOutcome error:', err.message);
  }
}

module.exports = { logSent, trackOutcome };
