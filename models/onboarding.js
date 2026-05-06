'use strict';

const { query } = require('./db');

const OnboardingModel = {
  async getSession(phone) {
    const res = await query(
      `SELECT * FROM onboarding_sessions WHERE phone = $1 AND expires_at > NOW()`,
      [phone]
    );
    return res.rows[0] || null;
  },

  async createSession(phone) {
    await query(
      `INSERT INTO onboarding_sessions (phone, step, collected, created_at, expires_at)
       VALUES ($1, 'name', '{}', NOW(), NOW() + INTERVAL '30 minutes')
       ON CONFLICT (phone) DO UPDATE
         SET step = 'name', collected = '{}',
             created_at = NOW(), expires_at = NOW() + INTERVAL '30 minutes'`,
      [phone]
    );
  },

  async updateSession(phone, step, collected) {
    await query(
      `UPDATE onboarding_sessions
       SET step = $2, collected = $3, expires_at = NOW() + INTERVAL '30 minutes'
       WHERE phone = $1`,
      [phone, step, JSON.stringify(collected)]
    );
  },

  async deleteSession(phone) {
    await query(
      `DELETE FROM onboarding_sessions WHERE phone = $1`,
      [phone]
    );
  },
};

module.exports = OnboardingModel;
