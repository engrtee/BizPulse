/**
 * services/resellerInventorySources/manualInventorySource.js
 * InventorySource adapter for Tier 1 (seller-owned) catalog items — bulk preorder
 * batches the seller physically holds. First-party data, fully within system
 * control (bizpulse-v1-build-prompt.md Section 4a's "Process 2").
 *
 * Contract: checkAvailability(catalogItemId, quantity) →
 *   { available: boolean, currentStock: number|null }
 *
 * This is the seam Section 4 asks for: a future SupplierAPISource/
 * SupplierScraperSource for Tier 2 (supplier-dependent) items plugs in
 * alongside this one — nothing here needs to change when that's built.
 */

'use strict';

const ResellerCatalogModel = require('../../models/resellerCatalog');

async function checkAvailability(catalogItemId, quantity) {
  const item = await ResellerCatalogModel.getById(catalogItemId);
  if (!item) return { available: false, currentStock: null };
  const stock = parseFloat(item.current_stock) || 0;
  return { available: stock >= (parseFloat(quantity) || 0), currentStock: stock };
}

module.exports = { checkAvailability };
