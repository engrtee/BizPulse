/**
 * models/sheetConnection.js
 * A business's link to its Google Sheet (Sheets mode). One per user.
 * Sheets mode is read-only by design: the sheet is the source of truth, so this
 * model never touches transactions/products.
 */

'use strict';

const { query } = require('./db');

const SheetConnectionModel = {
  async getByUserId(userId) {
    const res = await query('SELECT * FROM sheet_connections WHERE user_id = $1', [userId]);
    return res.rows[0] || null;
  },

  async getActiveByWhatsapp(whatsappNumber) {
    const res = await query(
      `SELECT c.* FROM sheet_connections c JOIN users u ON u.id = c.user_id
       WHERE u.whatsapp_number = $1 AND c.status IN ('active', 'access_lost')`,
      [whatsappNumber]
    );
    return res.rows[0] || null;
  },

  /** Active connections joined with the owner, for the cron jobs. */
  async listActive() {
    const res = await query(
      `SELECT c.*, u.name AS user_name, u.whatsapp_number
       FROM sheet_connections c JOIN users u ON u.id = c.user_id
       WHERE c.status = 'active' AND u.active = TRUE AND u.whatsapp_number IS NOT NULL
       ORDER BY c.id`
    );
    return res.rows;
  },

  async upsert({ userId, spreadsheetId, title, mapping }) {
    const res = await query(
      `INSERT INTO sheet_connections (user_id, spreadsheet_id, title, mapping, status, baselined, last_error)
       VALUES ($1, $2, $3, $4, 'active', FALSE, NULL)
       ON CONFLICT (user_id) DO UPDATE
         SET spreadsheet_id = EXCLUDED.spreadsheet_id, title = EXCLUDED.title,
             mapping = EXCLUDED.mapping, status = 'active', baselined = FALSE, last_error = NULL
       RETURNING *`,
      [userId, spreadsheetId, title, JSON.stringify(mapping)]
    );
    // A new sheet means a new baseline: forget the old sheet's seen rows.
    await query('DELETE FROM sheet_seen_sales WHERE connection_id = $1', [res.rows[0].id]);
    return res.rows[0];
  },

  async remove(userId) {
    await query('DELETE FROM sheet_connections WHERE user_id = $1', [userId]);
  },

  async markSynced(id) {
    await query('UPDATE sheet_connections SET last_synced_at = NOW(), last_error = NULL WHERE id = $1', [id]);
  },

  async markError(id, message, status) {
    await query(
      'UPDATE sheet_connections SET last_error = $2, status = COALESCE($3, status) WHERE id = $1',
      [id, String(message).slice(0, 300), status || null]
    );
  },

  async getSeenHashes(id) {
    const res = await query('SELECT row_hash FROM sheet_seen_sales WHERE connection_id = $1', [id]);
    return new Set(res.rows.map(r => r.row_hash));
  },

  async addSeenHashes(id, hashes) {
    if (!hashes.length) return;
    await query(
      `INSERT INTO sheet_seen_sales (connection_id, row_hash)
       SELECT $1, UNNEST($2::text[]) ON CONFLICT DO NOTHING`,
      [id, hashes]
    );
  },

  async setBaselined(id) {
    await query('UPDATE sheet_connections SET baselined = TRUE WHERE id = $1', [id]);
  },
};

/** user ids with a sheet connection (even one that lost access — they're still Sheets-mode) — other jobs use this to skip Sheets-mode users. */
async function getSheetUserIds() {
  const res = await query('SELECT user_id FROM sheet_connections');
  return new Set(res.rows.map(r => r.user_id));
}

module.exports = SheetConnectionModel;
module.exports.getSheetUserIds = getSheetUserIds;
