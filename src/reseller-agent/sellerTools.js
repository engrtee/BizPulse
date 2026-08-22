'use strict';

/**
 * Tool definitions for the reseller ordering agent's SELLER-facing loop.
 * Scope matches the source prompt's explicit division of labor: WhatsApp is
 * for day-to-day stock updates and a quick look at what's pending; order
 * lifecycle actions (confirm/decline/mark paid/mark delivered) live on the
 * dashboard instead (routes/resellerAdmin.js).
 */

const SELLER_TOOLS = [

  {
    name: 'update_stock',
    description:
      'Set an item\'s current stock to an exact number the seller just told you (e.g. "Item 3 now has 12 ' +
      'left"). Use for a direct stock count, not a delta — for "restock 20 units" use restock instead, and ' +
      'for "sold out" use mark_sold_out instead.',
    input_schema: {
      type: 'object',
      properties: {
        item_number:   { type: 'integer', description: 'The catalog item number.' },
        current_stock: { type: 'number',  description: 'The new exact stock count.' },
      },
      required: ['item_number', 'current_stock'],
    },
  },

  {
    name: 'restock',
    description:
      'Add newly received units to an item\'s stock (e.g. "Item 3, restock 20 units", "just got 10 more of ' +
      'item 5"). Adds to the existing count — does not replace it. Only works for seller-owned items; if ' +
      'the item is supplier-dependent, say plainly that it has no stock count to restock.',
    input_schema: {
      type: 'object',
      properties: {
        item_number: { type: 'integer', description: 'The catalog item number.' },
        quantity:    { type: 'number',  description: 'How many units were just received.' },
      },
      required: ['item_number', 'quantity'],
    },
  },

  {
    name: 'mark_sold_out',
    description:
      'Set an item\'s stock to zero (e.g. "Item 5 sold out", "no more of item 2").',
    input_schema: {
      type: 'object',
      properties: {
        item_number: { type: 'integer', description: 'The catalog item number.' },
      },
      required: ['item_number'],
    },
  },

  {
    name: 'add_catalog_item',
    description:
      'Add a brand new item to the seller\'s numbered catalog, auto-assigning the next item number. Use ' +
      'when the seller describes a new product she wants to start selling (e.g. "new item: blue tote bag, ' +
      '8000 naira, sizes S/M/L"). Ask for whatever is missing (name, price) rather than guessing. If she ' +
      'does not say whether it\'s her own stock or a supplier order, ask — default to seller_owned only if ' +
      'she clearly implies she already has it in hand.',
    input_schema: {
      type: 'object',
      properties: {
        name:          { type: 'string',  description: 'Product name.' },
        price_naira:   { type: 'number',  description: 'Selling price in Naira.' },
        source_type:   { type: 'string',  enum: ['seller_owned', 'supplier_dependent'], description: 'seller_owned if she already holds the stock; supplier_dependent if it depends on checking a supplier.' },
        variant_info:  { type: 'string',  description: 'Sizes/colours/variants if mentioned, e.g. "sizes S/M/L". Optional.' },
        opening_stock: { type: 'number',  description: 'Starting stock count — only meaningful for seller_owned items. Optional, defaults to 0.' },
      },
      required: ['name', 'price_naira', 'source_type'],
    },
  },

  {
    name: 'get_pending_orders',
    description:
      'Show the seller a quick list of orders still needing her attention (awaiting verification, awaiting ' +
      'payment, or with a payment receipt she has not acknowledged). Use when she asks "any new orders?", ' +
      '"what\'s pending", etc. For confirming/declining/marking paid, tell her to use the dashboard.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

module.exports = { SELLER_TOOLS };
