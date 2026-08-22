/**
 * services/resellerInventorySources/index.js
 * Selects the InventorySource implementation for a catalog item's source_type.
 * The seam described in bizpulse-v1-build-prompt.md Section 4 — a future
 * SupplierAPISource/SupplierScraperSource for 'supplier_dependent' items plugs
 * in here as a second branch; nothing else in the codebase needs to change.
 *
 * Note: the atomic order-placement path (place_order, in ../../src/reseller-agent/
 * toolHandlers.js) checks/decrements seller_owned stock inline within its DB
 * transaction rather than calling this adapter directly, since the check-then-
 * decrement must happen on the same transaction-scoped client. This module is
 * for read-only/non-transactional callers (e.g. a future standalone stock-check
 * tool, the dashboard). There is currently no adapter for 'supplier_dependent' —
 * callers should branch on source_type themselves and skip straight to
 * pending_verification rather than call here for that tier.
 */

'use strict';

const manualInventorySource = require('./manualInventorySource');

function getInventorySource(sourceType) {
  if (sourceType === 'seller_owned') return manualInventorySource;
  return null;
}

module.exports = { getInventorySource };
