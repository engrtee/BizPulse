/**
 * services/receipts.js
 * Stub for Batch 1 (A1-3) — real receipt generation (HTML→PNG, race-safe
 * per-trader sequence) lands in Batch 2. This just logs intent so the
 * full-payment hook exists and is exercised, without building ahead of
 * the batch it belongs to.
 */

'use strict';

async function onDebtFullyPaid(debtorRow) {
  console.log(
    `[Receipts] STUB — would generate a receipt for fully-paid debt ` +
    `#${debtorRow.id} (${debtorRow.debtor_name}, ₦${Number(debtorRow.amount).toLocaleString('en-NG')}). ` +
    `Real generation lands in Batch 2.`
  );
}

module.exports = { onDebtFullyPaid };
