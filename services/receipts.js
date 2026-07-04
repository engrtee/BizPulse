/**
 * services/receipts.js
 * Full-payment → receipt hook (Batch 1 stub, wired to real generation in
 * Batch 2). Called by settleDebtHandler when a debt is fully settled — this
 * is the debt→receipt direction of the Edge 1↔2 interlock; generate_receipt
 * with payment_method 'credit' is the receipt→debt direction.
 */

'use strict';

async function onDebtFullyPaid(debtorRow) {
  try {
    const UserModel = require('../models/user');
    const user = await UserModel.findById(debtorRow.user_id);
    if (!user || !user.whatsapp_number) {
      console.warn(`[Receipts] Could not resolve a WhatsApp number for user_id ${debtorRow.user_id} — skipping auto-receipt for debt #${debtorRow.id}`);
      return;
    }

    // payment_method is always 'cash' here — paying off a debt is a cash
    // receipt, never itself another credit sale, so this can't recurse into
    // creating another debtor row.
    const { generateReceiptHandler } = require('../src/agent/toolHandlers');
    await generateReceiptHandler({
      customer_name:  debtorRow.debtor_name,
      items: [{
        product:    debtorRow.product_name || 'Debt payment',
        quantity:   1,
        unit_price: parseFloat(debtorRow.amount) || 0,
      }],
      payment_method: 'cash',
      whatsappNumber: user.whatsapp_number,
    });
  } catch (err) {
    console.error(`[Receipts] Auto-receipt failed for debt #${debtorRow.id}:`, err.message);
  }
}

module.exports = { onDebtFullyPaid };
