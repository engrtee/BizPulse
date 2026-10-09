/**
 * services/sheets/client.js
 * Read-only Google Sheets access for Sheets mode (opt-in per business).
 *
 * Auth is a single BizPulse service account — the owner shares their sheet with
 * its email as Viewer. No OAuth, no Google login for the trader, and Google itself
 * enforces read-only. (This is not the removed OAuth integration — see CLAUDE.md Fix 3.)
 */

'use strict';

const { google } = require('googleapis');

let _sheets = null;
let _email = null;

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    // Hosting dashboards often keep the quotes people wrap around a pasted value ('{...}'), so strip stray quotes from either end (even unbalanced).
    let v = raw.trim().replace(/^['"`]+/, '').replace(/['"`]+$/, '').trim();
    const text = v.startsWith('{') ? v : Buffer.from(v, 'base64').toString('utf8');
    const creds = JSON.parse(text);
    return creds;
  } catch (e) {
    console.error('[Sheets] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON/base64 JSON:', e.message);
    return null;
  }
}

function isConfigured() {
  return !!loadCredentials();
}

/** The email owners must share their sheet with. */
function getServiceAccountEmail() {
  if (_email) return _email;
  const creds = loadCredentials();
  _email = creds ? creds.client_email : null;
  return _email;
}

function getApi() {
  if (_sheets) return _sheets;
  const creds = loadCredentials();
  if (!creds) throw new Error('SHEETS_NOT_CONFIGURED');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

/** Pull the spreadsheet id out of a pasted link (or accept a bare id). */
function extractSpreadsheetId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{30,}$/.test(s) ? s : null;
}

/** Map a Google API failure to a short code the tool layer can narrate. */
function classifyError(err) {
  if (err.message === 'SHEETS_NOT_CONFIGURED') return 'not_configured';
  if (/has not been used|is disabled|accessNotConfigured/i.test(err.message || '')) return 'api_disabled';
  const code = err.code || err.status || err.response?.status;
  if (code === 403 || code === 404) return 'no_access';
  if (code === 429) return 'rate_limited';
  return 'unavailable';
}

/** Returns { title, tabs: [tabTitle] }. Throws on no access. */
async function getMeta(spreadsheetId) {
  const res = await getApi().spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties.title',
  });
  return {
    title: res.data.properties.title,
    tabs: res.data.sheets.map(s => s.properties.title),
  };
}

/** Raw rows for one tab (array of arrays). Dates come back as serial numbers. */
async function readTab(spreadsheetId, tabTitle) {
  const res = await getApi().spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabTitle.replace(/'/g, "''")}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  return res.data.values || [];
}

module.exports = {
  isConfigured, getServiceAccountEmail, extractSpreadsheetId,
  classifyError, getMeta, readTab,
};
