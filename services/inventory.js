/**
 * services/inventory.js
 * Orchestrates stock movements across PostgreSQL (fast balance) and Google Sheets (audit trail).
 *
 * Called by the webhook handler when a message is classified as inventory_in or inventory_out.
 *
 * PHASE 2: debtor tracking extends here
 *   (track goods given on credit — item, qty, debtor name, expected payment date)
 */

'use strict';

const InventoryModel  = require('../models/inventory');
const SheetsService   = require('./sheets');
const WhatsAppService = require('./whatsapp');
const { todayWAT }    = require('../utils/formatter');

/**
 * Record stock received from a supplier.
 * Updates the inventory balance in PostgreSQL and appends a row to Google Sheets.
 *
 * @param {object} user     Full user record
 * @param {object} data     { item, quantity, unitPrice } (parsed by Gemini)
 * @returns {object}        Updated inventory row
 */
async function receiveStock(user, { item, quantity, unitPrice }) {
  const date       = todayWAT();
  const qty        = parseFloat(quantity) || 0;
  const price      = parseFloat(unitPrice) || 0;
  const totalValue = qty * price;

  // Update fast-lookup balance in PostgreSQL
  const row = await InventoryModel.applyMovement(user.id, item, 'received', qty, price);

  // Append to Google Sheets if connected
  if (user.sheet_id) {
    await SheetsService.appendInventory(user, {
      date,
      item,
      quantity: qty,
      direction:    'Received',
      unitPrice:    price,
      totalValue,
      balanceAfter: row.current_balance,
    }).catch((err) => console.error('[Sheets] appendInventory error:', err.message));
  }

  return row;
}

/**
 * Record stock sold / dispatched.
 *
 * @param {object} user   Full user record
 * @param {object} data   { item, quantity } (parsed by Gemini)
 * @returns {object}      Updated inventory row
 */
async function sellStock(user, { item, quantity }) {
  const date  = todayWAT();
  const qty   = parseFloat(quantity) || 0;

  const row = await InventoryModel.applyMovement(user.id, item, 'sold', qty, null);

  // Out-of-stock alert — different from low-stock, more urgent
  if (parseFloat(row.current_balance) === 0 && user.whatsapp_number) {
    WhatsAppService.sendMessage(
      user.whatsapp_number,
      `⚠️ Your ${item} stock shows 0 units. Please update your inventory.`
    ).catch((err) => console.error('[Inventory] OOS WhatsApp alert error:', err.message));
  }

  if (user.sheet_id) {
    await SheetsService.appendInventory(user, {
      date,
      item,
      quantity: qty,
      direction:    'Sold',
      unitPrice:    row.unit_price,
      totalValue:   qty * (row.unit_price || 0),
      balanceAfter: row.current_balance,
    }).catch((err) => console.error('[Sheets] appendInventory error:', err.message));
  }

  return row;
}

/**
 * Get current stock levels for a user (used for "stock?" WhatsApp reply).
 */
async function getStock(userId) {
  return InventoryModel.getAll(userId);
}

/**
 * Return items below their low-stock threshold (used in email and summary screen).
 */
async function getLowStockAlerts(userId) {
  return InventoryModel.getLowStock(userId);
}

module.exports = { receiveStock, sellStock, getStock, getLowStockAlerts };
