/**
 * models/user.js
 * All PostgreSQL queries for the users table.
 */

'use strict';

const { query } = require('./db');

const UserModel = {
  /** Find a user by their WhatsApp number (used on every inbound message).
   *  Normalises both sides — Meta sends numbers without the leading +,
   *  but users may register with or without it. */
  async findByWhatsapp(whatsappNumber) {
    const normalised = whatsappNumber.replace(/^\+/, '');
    const res = await query(
      `SELECT * FROM users
       WHERE REPLACE(whatsapp_number, '+', '') = $1 AND active = TRUE LIMIT 1`,
      [normalised]
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
    const res = await query(
      `INSERT INTO users (name, email, biz_name, biz_type, state, whatsapp_number)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, email.toLowerCase().trim(), bizName, bizType, state, whatsappNumber]
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

  /** Update last entry date and recalculate streak */
  async touchLastEntry(userId) {
    // Get current last_entry_date and streak
    const cur = await query(
      'SELECT last_entry_date, streak FROM users WHERE id = $1',
      [userId]
    );
    if (!cur.rows[0]) return;

    const { last_entry_date, streak } = cur.rows[0];
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

    let newStreak = 1;
    if (last_entry_date) {
      const lastDate = new Date(last_entry_date).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      if (lastDate === today) {
        // Already logged today — keep streak as is
        newStreak = streak || 1;
      } else if (lastDate === yesterday) {
        // Consecutive day — increment
        newStreak = (streak || 0) + 1;
      }
      // else streak resets to 1
    }

    await query(
      'UPDATE users SET last_entry_date = CURRENT_DATE, streak = $1 WHERE id = $2',
      [newStreak, userId]
    );
    return newStreak;
  },

  /** Update user profile settings from the frontend */
  async update(userId, { name, email, bizName, bizType, state }) {
    const res = await query(
      `UPDATE users
       SET name = $1, email = $2, biz_name = $3, biz_type = $4, state = $5
       WHERE id = $6
       RETURNING *`,
      [name, email, bizName, bizType, state, userId]
    );
    return res.rows[0];
  },

  /** Soft-delete a user (keeps their data intact) */
  async deactivate(userId) {
    await query('UPDATE users SET active = FALSE WHERE id = $1', [userId]);
  },
};

module.exports = UserModel;
