'use strict';

const ResellerCatalogModel = require('../../models/resellerCatalog');
const ResellerOrderModel = require('../../models/resellerOrder');

async function updateStockHandler({ item_number, current_stock, sellerId }) {
  const item = await ResellerCatalogModel.getByItemNumber(sellerId, item_number);
  if (!item) return { error: true, message: 'Item number not found.' };
  const updated = await ResellerCatalogModel.setStock(item.id, parseFloat(current_stock) || 0);
  return {
    updated: true,
    item: { item_number: updated.item_number, name: updated.name, current_stock: parseFloat(updated.current_stock) },
  };
}

async function restockHandler({ item_number, quantity, sellerId }) {
  const item = await ResellerCatalogModel.getByItemNumber(sellerId, item_number);
  if (!item) return { error: true, message: 'Item number not found.' };
  if (item.source_type !== 'seller_owned') {
    return {
      error: true,
      message: 'This item is supplier-dependent — it has no first-party stock figure to restock.',
    };
  }
  const updated = await ResellerCatalogModel.restock(item.id, parseFloat(quantity) || 0);
  return {
    updated: true,
    item: { item_number: updated.item_number, name: updated.name, current_stock: parseFloat(updated.current_stock) },
  };
}

async function markSoldOutHandler({ item_number, sellerId }) {
  const item = await ResellerCatalogModel.getByItemNumber(sellerId, item_number);
  if (!item) return { error: true, message: 'Item number not found.' };
  const updated = await ResellerCatalogModel.markSoldOut(item.id);
  return {
    updated: true,
    item: { item_number: updated.item_number, name: updated.name, current_stock: 0 },
  };
}

async function addCatalogItemHandler({ name, price_naira, source_type, variant_info, opening_stock, sellerId }) {
  const created = await ResellerCatalogModel.create({
    sellerId,
    name,
    priceNaira: price_naira,
    variantInfo: variant_info,
    sourceType: source_type === 'supplier_dependent' ? 'supplier_dependent' : 'seller_owned',
    openingStock: opening_stock,
  });
  return {
    created: true,
    item: {
      item_number: created.item_number,
      name: created.name,
      price_naira: parseFloat(created.price_naira),
      source_type: created.source_type,
    },
  };
}

async function getPendingOrdersHandler({ sellerId }) {
  const orders = await ResellerOrderModel.getPendingForSeller(sellerId);
  const withItems = [];
  for (const o of orders) {
    const orderLines = await ResellerOrderModel.getItemsForOrder(o.id);
    withItems.push({
      order_id: o.id,
      status: o.status,
      customer_name: o.customer_name,
      customer_phone: o.customer_phone,
      created_at: o.created_at,
      items: orderLines.map(i => ({ name: i.item_name_snapshot, quantity: parseFloat(i.quantity) })),
    });
  }
  return { orders: withItems };
}

module.exports = {
  updateStockHandler,
  restockHandler,
  markSoldOutHandler,
  addCatalogItemHandler,
  getPendingOrdersHandler,
};
