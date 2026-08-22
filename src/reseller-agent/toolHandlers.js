'use strict';

const { withTransaction } = require('../../models/db');
const SellerModel = require('../../models/seller');
const ResellerCatalogModel = require('../../models/resellerCatalog');
const ResellerOrderModel = require('../../models/resellerOrder');
const { identifySeller } = require('./sellerMatcher');

async function browseCatalogHandler({ sellerId }) {
  const items = await ResellerCatalogModel.getActiveBySeller(sellerId);
  return {
    items: items.map(i => ({
      item_number: i.item_number,
      name: i.name,
      price_naira: parseFloat(i.price_naira) || 0,
      variant_info: i.variant_info,
      source_type: i.source_type,
      // in_stock is only meaningful for seller-owned items — null for
      // supplier-dependent items since there's no first-party stock figure.
      in_stock: i.source_type === 'seller_owned' ? (parseFloat(i.current_stock) || 0) > 0 : null,
    })),
  };
}

/**
 * The core order-structuring pipeline (Section 3, Core User Flow steps 3-5).
 * Order + line items are written atomically, and a seller-owned line's stock
 * decrement happens in the SAME transaction as the write that confirms it —
 * mirrors BizPulse's own atomic stock+transaction pattern (src/agent/toolHandlers.js
 * logSaleHandler) so a crash mid-write can never desync stock from history.
 *
 * Tier 1 (seller_owned): checked live against reseller_catalog_items.current_stock,
 * auto-confirmed or declined.
 * Tier 2 (supplier_dependent): always staged pending_verification — no adapter call,
 * per the source prompt's Section 4 ("do not build the supplier adapter now").
 *
 * Any pending line holds the WHOLE order at pending_verification (safer human-in-
 * the-loop default than partially confirming) — this is a deliberate V1 choice,
 * not an oversight.
 */
async function placeOrderHandler({ items, customer_name, sellerId, customerPhone }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: true, message: 'No items given.' };
  }

  const seller = await SellerModel.findById(sellerId);
  if (!seller) return { error: true, message: 'Seller not found.' };

  const lineResults = [];
  let anyConfirmed = false;
  let anyPending = false;

  const order = await withTransaction(async (txQuery) => {
    const orderRes = await txQuery(
      `INSERT INTO reseller_orders (seller_id, customer_phone, customer_name, status)
       VALUES ($1, $2, $3, 'pending_verification')
       RETURNING *`,
      [sellerId, customerPhone, customer_name || null]
    );
    const orderRow = orderRes.rows[0];

    for (const line of items) {
      const catalogRes = await txQuery(
        `SELECT * FROM reseller_catalog_items
         WHERE seller_id = $1 AND item_number = $2 AND is_active = TRUE`,
        [sellerId, line.item_number]
      );
      const catalogItem = catalogRes.rows[0];
      if (!catalogItem) {
        lineResults.push({ item_number: line.item_number, status: 'not_found' });
        continue;
      }

      const quantity = parseFloat(line.quantity) || 1;
      let lineStatus;

      if (catalogItem.source_type === 'seller_owned') {
        const stock = parseFloat(catalogItem.current_stock) || 0;
        if (stock >= quantity) {
          await txQuery(
            `UPDATE reseller_catalog_items
             SET current_stock = current_stock - $2, updated_at = NOW()
             WHERE id = $1`,
            [catalogItem.id, quantity]
          );
          lineStatus = 'confirmed';
          anyConfirmed = true;
        } else {
          lineStatus = 'declined';
        }
      } else {
        lineStatus = 'pending_verification';
        anyPending = true;
      }

      const unitPrice = parseFloat(catalogItem.price_naira) || 0;
      await txQuery(
        `INSERT INTO reseller_order_items
           (order_id, catalog_item_id, item_number_snapshot, item_name_snapshot,
            unit_price_snapshot, quantity, variant, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderRow.id, catalogItem.id, catalogItem.item_number, catalogItem.name,
         unitPrice, quantity, line.variant || null, unitPrice * quantity]
      );

      lineResults.push({
        item_number: catalogItem.item_number,
        name: catalogItem.name,
        quantity,
        unit_price: unitPrice,
        status: lineStatus,
      });
    }

    const overallStatus = anyPending
      ? 'pending_verification'
      : anyConfirmed
        ? 'awaiting_payment'
        : 'declined';

    await txQuery(
      `UPDATE reseller_orders
       SET status = $2${overallStatus === 'awaiting_payment' ? ', confirmed_at = NOW()' : ''}
       WHERE id = $1`,
      [orderRow.id, overallStatus]
    );

    return { ...orderRow, status: overallStatus };
  });

  const total = lineResults
    .filter(l => l.status === 'confirmed' || l.status === 'pending_verification')
    .reduce((s, l) => s + (l.unit_price || 0) * (l.quantity || 0), 0);

  return {
    placed: true,
    order_id: order.id,
    order_status: order.status,
    lines: lineResults,
    total_naira: total,
    // Sent regardless of confirmed/pending, per Core User Flow step 5 — omitted
    // only when every line was declined (nothing to pay for).
    bank_details: order.status !== 'declined' ? {
      account_name: seller.bank_account_name,
      account_number: seller.bank_account_number,
      bank_name: seller.bank_name,
    } : null,
  };
}

async function checkOrderStatusHandler({ sellerId, customerPhone }) {
  const orders = await ResellerOrderModel.getOrdersForCustomer(sellerId, customerPhone, 5);
  const withItems = [];
  for (const o of orders) {
    const orderLines = await ResellerOrderModel.getItemsForOrder(o.id);
    withItems.push({
      order_id: o.id,
      status: o.status,
      created_at: o.created_at,
      items: orderLines.map(i => ({ name: i.item_name_snapshot, quantity: parseFloat(i.quantity) })),
    });
  }
  return { orders: withItems };
}

async function switchSellerHandler({ query: rawQuery, customerPhone }) {
  const { match, candidates } = await identifySeller(rawQuery);
  if (match) {
    await SellerModel.linkCustomer(customerPhone, match.id);
    return { switched: true, seller: { id: match.id, business_name: match.business_name } };
  }
  if (candidates.length > 0) {
    return {
      switched: false,
      candidates: candidates.map(c => ({ id: c.id, business_name: c.business_name })),
    };
  }
  return { switched: false, message: 'No matching seller found.' };
}

/**
 * Deterministic (non-LLM) handler for a payment-receipt photo from a linked
 * customer. Not a Claude tool — the webhook routes straight here on an image
 * from a known reseller customer, since verifying "is this really a receipt"
 * is exactly the human-in-the-loop step Section 2 reserves for the seller
 * (V1 explicitly does not attempt automated payment reconciliation).
 */
async function recordPaymentReceiptHandler({ sellerId, customerPhone, mediaId }) {
  const orders = await ResellerOrderModel.getOrdersForCustomer(sellerId, customerPhone, 10);
  const awaitingPayment = orders.find(o => o.status === 'awaiting_payment');
  if (!awaitingPayment) return { recorded: false };

  const updated = await ResellerOrderModel.updateStatus(awaitingPayment.id, 'payment_received', {
    paymentReceiptMediaId: mediaId,
  });
  return { recorded: true, order: updated };
}

module.exports = {
  browseCatalogHandler,
  placeOrderHandler,
  checkOrderStatusHandler,
  switchSellerHandler,
  recordPaymentReceiptHandler,
};
