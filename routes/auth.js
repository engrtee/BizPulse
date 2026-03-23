/**
 * routes/auth.js
 * Google OAuth 2.0 flow for connecting a user's Google Drive.
 *
 * GET /api/auth/google    → Redirect user to Google consent screen
 * GET /api/auth/callback  → Receive code, exchange for tokens, create Sheet
 *
 * The userId is passed through the OAuth state parameter so we know
 * which user to attach the tokens to after the callback.
 */

'use strict';

require('dotenv').config();
const express       = require('express');
const router        = express.Router();
const { google }    = require('googleapis');

const UserModel     = require('../models/user');
const SheetsService = require('../services/sheets');

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
];

// ─────────────────────────────────────────────
// GET /api/auth/google
// Frontend calls this after collecting user details.
// Expects query param: ?userId=<id>
// ─────────────────────────────────────────────
router.get('/google', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const auth = makeOAuth2Client();
  const url  = auth.generateAuthUrl({
    access_type:   'offline',
    scope:         SCOPES,
    prompt:        'consent',       // force refresh_token to always be returned
    state:         String(userId),  // passed back in callback
  });

  res.redirect(url);
});

// ─────────────────────────────────────────────
// GET /api/auth/callback
// Google redirects here after user grants permission.
// ─────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;

  if (error) {
    console.error('[Auth] Google OAuth error:', error);
    return res.redirect(`${process.env.BASE_URL}?auth=error&reason=${error}`);
  }
  if (!code || !userId) {
    return res.redirect(`${process.env.BASE_URL}?auth=error&reason=missing_params`);
  }

  try {
    const auth       = makeOAuth2Client();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    // Load the user so we can build their Sheet with their name/biz
    const user = await UserModel.findById(userId);
    if (!user) {
      return res.redirect(`${process.env.BASE_URL}?auth=error&reason=user_not_found`);
    }

    // Temporarily attach tokens so createUserSheet can use them
    const userWithTokens = {
      ...user,
      google_access_token:  tokens.access_token,
      google_refresh_token: tokens.refresh_token,
    };

    // Create the personal Google Sheet
    let sheetId = null;
    try {
      sheetId = await SheetsService.createUserSheet(userWithTokens);
      console.log(`[Auth] Sheet created for ${user.name}: ${sheetId}`);
    } catch (sheetErr) {
      console.error('[Auth] Sheet creation failed:', sheetErr.message);
      // Non-fatal: user is still registered, they just won't have a Sheet yet
    }

    // Persist tokens and sheet ID to DB
    await UserModel.saveGoogleTokens(userId, {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      sheetId,
    });

    // Redirect to frontend with success flag
    res.redirect(`${process.env.BASE_URL}?auth=success&userId=${userId}&name=${encodeURIComponent(user.name)}`);
  } catch (err) {
    console.error('[Auth] Callback error:', err.message);
    res.redirect(`${process.env.BASE_URL}?auth=error&reason=server_error`);
  }
});

module.exports = router;
