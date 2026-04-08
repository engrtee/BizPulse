/**
 * models/user.js
 * All PostgreSQL queries for the users table.
 */

'use strict';

const { query } = require('./db');
const { normalizePhone } = require('../utils/phone');

const UserModel = {
  /** Find a user by their WhatsApp number (used on every inbound message).
   *  Normalises both the incoming number AND the stored value at query time,
   *  so it works regardless of what format is stored in the DB. */
  async findByWhatsapp(whatsappNumber) {
    const canonical = normalizePhone(whatsappNumber);
    const res = await query(
      `SELECT * FROM users
       WHERE active = TRUE
         AND CASE
           WHEN whatsapp_number ~ '^0[789][0-9]{9}$'
             THEN '234' || SUBSTRING(whatsapp_number, 2)
           WHEN whatsapp_number ~ '^\\+?234[789][0-9]{9}$'
             THEN REGEXP_REPLACE(whatsapp_number, '^\\+', '')
           ELSE whatsapp_number
         END = $1
       LIMIT 1`,
      [canonical]
    );
    return res.rows[0] || null;
  },

  /** Find by email (used during registration) */
  async findByEmail(email) {
    const res = await query(
      'SELECT * FROM users WHERE email = $1 LIMIT 1',
      [email.toLowerCase().trim()]
    );
    return res.rows[0] || null;
  },

  /** Find by id */
  async findById(id) {
    const res = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
    return res.rows[0] || null;
  },

  /** Return all active users (used by the 7pm cron job) */
  async findAllActive() {
    const res = await query(
      'SELECT * FROM users WHERE active = TRUE ORDER BY id'
    );
    return res.rows;
  },

  /** Create a new user during web registration */
  async create({ name, email, bizName, bizType, state, whatsappNumber }) {
    const normalized = whatsappNumber ? normalizePhone(whatsappNumber) : null;
    const res = await query(
      `INSERT INTO users (name, email, biz_name, biz_type, state, whatsapp_number)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, email.toLowerCase().trim(), bizName, bizType, state, normalized || null]
    );
    return res.rows[0];
  },

  /** Save Google OAuth tokens after user connects Drive */
  async saveGoogleTokens(userId, { accessToken, refreshToken, sheetId }) {
    const res = await query(
      `UPDATE users
       SET google_access_token = $1,
           google_refresh_token = $2,
           sheet_id = $3
       WHERE id = $4
       RETURNING *`,
      [accessToken, refreshToken, sheetId, userId]
    );
    return res.rows[0];
  },

  /** Refresh the access token (called automatically when 401 returned) */
  async updateAccessToken(userId, newAccessToken) {
    await query(
      'UPDATE users SET google_access_token = $1 WHERE id = $2',
      [newAccessToken, userId]
    );
  },

  /** Update last entry date, recalculate streak, and track message activity */
  async touchLastEntry(userId) {
    const cur = await query(
      'SELECT last_entry_date, streak, first_message_date, total_messages_sent FROM users WHERE id = $1',
      [userId]
    );
    if (!cur.rows[0]) return;

    const { last_entry_date, streak, first_message_date, total_messages_sent } = cur.rows[0];
    const today     = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

    let newStreak = 1;
    if (last_entry_date) {
      const lastDate = new Date(last_entry_date).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      if (lastDate === today)     newStreak = streak || 1;
      else if (lastDate === yesterday) newStreak = (streak || 0) + 1;
      // else streak resets to 1
    }

    await query(
      `UPDATE users
       SET last_entry_date        = (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE,
           streak                 = $1,
           last_message_date      = (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE,
           total_messages_sent    = total_messages_sent + 1,
           first_message_date     = COALESCE(first_message_date, (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE)
       WHERE id = $2`,
      [newStreak, userId]
    );
    return newStreak;
  },

  /** Return total messages sent for a user (used for milestone detection) */
  async getTotalMessages(userId) {
    const res = await query(
      'SELECT total_messages_sent FROM users WHERE id = $1',
      [userId]
    );
    return parseInt(res.rows[0]?.total_messages_sent, 10) || 0;
  },

  /** Admin dashboard stats */
  async getAdminStats() {
    const res = await query(`
      SELECT
        COUNT(*)                                                                  AS total_users,
        COUNT(first_message_date)                                                 AS activated,
        COUNT(CASE WHEN last_message_date >= CURRENT_DATE - INTERVAL '7 days'
                   THEN 1 END)                                                   AS active_this_week,
        COUNT(CASE WHEN last_message_date >= CURRENT_DATE - INTERVAL '14 days'
                    AND last_message_date <  CURRENT_DATE - INTERVAL '5 days'
                   THEN 1 END)                                                   AS at_risk,
        COUNT(CASE WHEN last_message_date <  CURRENT_DATE - INTERVAL '14 days'
                    OR last_message_date IS NULL AND first_message_date IS NOT NULL
                   THEN 1 END)                                                   AS churned,
        ROUND(AVG(total_messages_sent), 1)                                       AS avg_messages_per_user
      FROM users WHERE active = TRUE
    `);
    return res.rows[0];
  },

  /** New registrations in last N days */
  async getRecentRegistrations(days = 7) {
    const res = await query(
      `SELECT DATE(created_at AT TIME ZONE 'Africa/Lagos') AS day, COUNT(*) AS count
       FROM users
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY day ORDER BY day DESC`,
      [days]
    );
    return res.rows;
  },

  /** Users who haven't messaged in N+ days (for retention nudges) */
  async findInactiveFor(days) {
    const res = await query(
      `SELECT * FROM users
       WHERE active = TRUE
         AND whatsapp_number IS NOT NULL
         AND first_message_date IS NOT NULL
         AND (
           last_message_date IS NULL
           OR last_message_date = CURRENT_DATE - $1::INTEGER * INTERVAL '1 day'
         )
       ORDER BY id`,
      [days]
    );
    return res.rows;
  },

  /** Update user profile settings from the frontend */
  async update(userId, { name, email, bizName, bizType, state, whatsappNumber }) {
    const res = await query(
      `UPDATE users
       SET name = $1, email = $2, biz_name = $3, biz_type = $4, state = $5
           ${whatsappNumber !== undefined ? ', whatsapp_number = $7' : ''}
       WHERE id = $6
       RETURNING *`,
      whatsappNumber !== undefined
        ? [name, email, bizName, bizType, state, userId, whatsappNumber]
        : [name, email, bizName, bizType, state, userId]
    );
    return res.rows[0];
  },

  /** Soft-delete a user (keeps their data intact) */
  async deactivate(userId) {
    await query('UPDATE users SET active = FALSE WHERE id = $1', [userId]);
  },

  /** Return all users with their transaction count — for admin user table. */
  async findAllWithStats() {
    const res = await query(`
      SELECT u.*,
        COUNT(t.id)                      AS total_entries,
        MAX(t.created_at)                AS last_transaction_at,
        COALESCE(SUM(t.revenue), 0)      AS total_revenue
      FROM users u
      LEFT JOIN transactions t ON t.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    return res.rows;
  },

  /** Return at-risk users: inactive 5–14 days, for admin nudge panel. */
  async findAtRisk() {
    const res = await query(`
      SELECT *
      FROM users
      WHERE active = TRUE
        AND first_message_date IS NOT NULL
        AND last_message_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE - INTERVAL '14 days'
        AND last_message_date <  (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::DATE - INTERVAL '4 days'
      ORDER BY last_message_date ASC
    `);
    return res.rows;
  },
};

module.exports = UserModel;
