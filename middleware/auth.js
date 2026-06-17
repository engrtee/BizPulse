'use strict';

const crypto = require('crypto');
const { query } = require('../models/db');

const COOKIE_NAME = 'bizpulse_session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  path:     '/',
  maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days in ms
  secure:   process.env.NODE_ENV === 'production',
};

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(userId, res) {
  const token = generateToken();
  await query(
    `INSERT INTO user_sessions (token, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [token, userId]
  );
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
  return token;
}

async function destroySession(token, res) {
  if (token) {
    await query(`DELETE FROM user_sessions WHERE token = $1`, [token]).catch(() => {});
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/**
 * Middleware: validate session cookie and attach req.authUserId.
 * On 401: returns JSON so the frontend can detect and redirect to login.
 * When claimedUserId is provided (from body/query/params), validates it matches the session.
 */
async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Session expired. Please log in again.', requireLogin: true });
  }

  try {
    const result = await query(
      `SELECT user_id FROM user_sessions
       WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );
    if (!result.rows.length) {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.status(401).json({ error: 'Session expired. Please log in again.', requireLogin: true });
    }

    req.authUserId = result.rows[0].user_id;

    // If the request contains a userId claim, verify it matches the session
    const claimed = parseInt(
      req.body?.userId || req.query?.userId || req.params?.userId, 10
    );
    if (claimed && claimed !== req.authUserId) {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    next();
  } catch (err) {
    console.error('[Auth] Session validation failed:', err.message);
    return res.status(500).json({ error: 'Auth check failed. Please try again.' });
  }
}

module.exports = { createSession, destroySession, requireAuth, COOKIE_NAME };
