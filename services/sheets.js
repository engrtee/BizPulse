/**
 * services/sheets.js
 * Google Sheets API integration.
 *
 * On registration: createUserSheet() → creates a personal spreadsheet with 4 tabs.
 * On each entry:   appendTransaction() / appendInventory() / appendCustomers()
 * On cron job:     readSummaryData() → pulls totals for the email.
 *
 * Token refresh is handled automatically — if a 401 is returned, we use the
 * stored refresh token to get a new access token, save it to the DB, and retry.
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const UserModel  = require('../models/user');

// ---------- OAuth2 client factory ----------

function makeOAuth2Client(user) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({
    access_token:  user.google_access_token,
    refresh_token: user.google_refresh_token,
  });

  // Auto-refresh: save new access token to DB when Google issues one
  auth.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await UserModel.updateAccessToken(user.id, tokens.access_token);
    }
  });

  return auth;
}

// ---------- Sheet column headers ----------

const HEADERS = {
  Transactions: [
    ['Date', 'Revenue (₦)', 'Total Expenses (₦)', 'Expense Breakdown', 'Profit (₦)', 'Margin (%)', 'Customers', 'Notes'],
  ],
  Inventory: [
    ['Date', 'Item', 'Quantity', 'Direction (Received/Sold)', 'Unit Price (₦)', 'Total Value (₦)', 'Balance After'],
  ],
  Customers: [
    ['Date', 'Customer Count', 'Notes'],
  ],
  Summary: [
    ['Month', 'Total Revenue (₦)', 'Total Expenses (₦)', 'Total Profit (₦)', 'Avg Margin (%)', 'Total Customers'],
  ],
};

// ---------- Public API ----------

/**
 * Create a new Google Sheet for a newly registered user.
 * Returns the spreadsheet ID to store in the DB.
 * @param {object} user  Full user record (needs google_access_token, google_refresh_token)
 */
async function createUserSheet(user) {
  const auth   = makeOAuth2Client(user);
  const sheets = google.sheets({ version: 'v4', auth });
  const drive  = google.drive({ version: 'v3', auth });

  // Create the spreadsheet
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `BizPulse — ${user.biz_name || user.name}` },
      sheets: [
        { properties: { title: 'Transactions', index: 0 } },
        { properties: { title: 'Inventory',    index: 1 } },
        { properties: { title: 'Customers',    index: 2 } },
        { properties: { title: 'Summary',      index: 3 } },
      ],
    },
  });

  const spreadsheetId = createRes.data.spreadsheetId;

  // Write headers to each tab
  const headerRequests = Object.entries(HEADERS).map(([tab, rows]) => ({
    range:          `${tab}!A1`,
    majorDimension: 'ROWS',
    values:         rows,
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data:             headerRequests,
    },
  });

  // Bold the header rows and freeze them
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: createRes.data.sheets.map((s) => ({
        repeatCell: {
          range: {
            sheetId:       s.properties.sheetId,
            startRowIndex: 0,
            endRowIndex:   1,
          },
          cell: {
            userEnteredFormat: {
              textFormat:      { bold: true },
              backgroundColor: { red: 0.059, green: 0.153, blue: 0.267 }, // --navy
              foregroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
          fields: 'userEnteredFormat(textFormat,backgroundColor,foregroundColor)',
        },
      })).concat(
        createRes.data.sheets.map((s) => ({
          updateSheetProperties: {
            properties: { sheetId: s.properties.sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        }))
      ),
    },
  });

  return spreadsheetId;
}

/**
 * Append a daily transaction row to the Transactions tab.
 */
async function appendTransaction(user, { date, revenue, totalExpenses, expenseBreakdown, profit, margin, customers, notes }) {
  const auth   = makeOAuth2Client(user);
  const sheets = google.sheets({ version: 'v4', auth });

  const breakdownStr = Object.entries(expenseBreakdown || {})
    .map(([k, v]) => `${k}: ₦${Number(v).toLocaleString('en-NG')}`)
    .join(', ');

  await sheets.spreadsheets.values.append({
    spreadsheetId:    user.sheet_id,
    range:            'Transactions!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        date || new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }),
        revenue,
        totalExpenses,
        breakdownStr,
        profit,
        margin,
        customers || 0,
        notes || '',
      ]],
    },
  });
}

/**
 * Append a stock movement to the Inventory tab.
 */
async function appendInventory(user, { date, item, quantity, direction, unitPrice, totalValue, balanceAfter }) {
  const auth   = makeOAuth2Client(user);
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId:    user.sheet_id,
    range:            'Inventory!A:G',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        date || new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }),
        item,
        quantity,
        direction,
        unitPrice || 0,
        totalValue || 0,
        balanceAfter || 0,
      ]],
    },
  });
}

/**
 * Append a customer count row to the Customers tab.
 */
async function appendCustomers(user, { date, count, notes }) {
  const auth   = makeOAuth2Client(user);
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId:    user.sheet_id,
    range:            'Customers!A:C',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        date || new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }),
        count,
        notes || '',
      ]],
    },
  });
}

/**
 * Read summary data for a specific date from the Transactions tab.
 * Used by the cron job to build the evening email.
 * Returns aggregated { revenue, totalExpenses, profit, margin, customers, allBreakdowns }
 */
async function readDayData(user, date) {
  const auth   = makeOAuth2Client(user);
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: user.sheet_id,
    range:         'Transactions!A:H',
  });

  const rows = res.data.values || [];
  // Skip header row, filter by date
  const dayRows = rows.slice(1).filter((r) => r[0] === date);

  let revenue = 0, totalExpenses = 0, profit = 0, customers = 0;
  const allBreakdowns = [];

  for (const row of dayRows) {
    revenue       += parseFloat(row[1]) || 0;
    totalExpenses += parseFloat(row[2]) || 0;
    profit        += parseFloat(row[4]) || 0;
    customers     += parseInt(row[6], 10) || 0;
    if (row[3]) allBreakdowns.push(row[3]); // raw string breakdowns
  }

  const margin = revenue > 0 ? parseFloat(((profit / revenue) * 100).toFixed(2)) : 0;

  return { revenue, totalExpenses, profit, margin, customers, allBreakdowns };
}

module.exports = { createUserSheet, appendTransaction, appendInventory, appendCustomers, readDayData };
