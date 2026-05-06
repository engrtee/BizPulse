/**
 * services/inventory.js
 * Orchestrates stock movements in PostgreSQL.
 *
 * Called by the webhook handler when a message is classified as inventory_in or inventory_out.
 *
 * PHASE 2: debtor tracking extends here
 *   (track goods given on credit — item, qty, debtor name, expected payment date)
 */

'use strict';

const InventoryModel  = require('../models/inventory');
const ProductModel    = require('../models/product');
const WhatsAppService = require('./whatsapp');

/**
 * Record stock received from a supplier.
 * Updates the inventory balance in PostgreSQL.
 *
 * @param {object} user     Full user record
 * @param {object} data     { item, quantity, unitPrice } (parsed by Gemini)
 * @returns {object}        Updated inventory row
 */
async function receiveStock(user, { item, quantity, unitPrice }) {
  const qty   = parseFloat(quantity) || 0;
  const price = parseFloat(unitPrice) || 0;

  // Update fast-lookup balance in PostgreSQL
  const row = await InventoryModel.applyMovement(user.id, item, 'received', qty, price);

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
  const qty = parseFloat(quantity) || 0;

  // Check for oversell BEFORE applying movement — use fuzzy match (same as applyMovement)
  const existing = await InventoryModel.getItemFuzzy(user.id, item);
  if (existing && qty > parseFloat(existing.current_balance) && parseFloat(existing.current_balance) > 0) {
    const available = parseFloat(existing.current_balance);
    if (user.whatsapp_number) {
      WhatsAppService.sendMessage(
        user.whatsapp_number,
        `⚠️ You only have ${available} units of ${item} in stock — you tried to sell ${qty}.\n\n` +
        `I've logged ${available} units sold (your full available stock).\n` +
        `Was that correct? Reply with the right quantity if not.`
      ).catch((err) => console.error('[Inventory] Oversell warning error:', err.message));
    }
  }

  const row = await InventoryModel.applyMovement(user.id, item, 'sold', qty, null);

  // Out-of-stock alert — different from low-stock, more urgent
  if (parseFloat(row.current_balance) === 0 && user.whatsapp_number) {
    WhatsAppService.sendMessage(
      user.whatsapp_number,
      `⚠️ Your ${item} stock shows 0 units. Please update your inventory.`
    ).catch((err) => console.error('[Inventory] OOS WhatsApp alert error:', err.message));
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
