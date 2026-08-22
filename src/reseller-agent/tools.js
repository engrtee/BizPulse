'use strict';

/**
 * Tool definitions for the reseller ordering agent's CUSTOMER-facing loop.
 * Passed as the `tools` array in every anthropic.messages.create() call once
 * a customer is linked to a seller. Seller identification itself happens
 * before any Claude call (src/reseller-agent/sellerMatcher.js) — it is not a
 * tool here.
 */

const TOOLS = [

  // ─── 1. browse_catalog ──────────────────────────────────────────────────────
  {
    name: 'browse_catalog',
    description:
      'List the seller\'s current catalog items so the customer can see what is available, with each ' +
      'item\'s number, name, price, and variant info (size/colour). Use this when the customer asks what ' +
      'is available, asks for prices, or references an item number/name you are not sure is real — check ' +
      'the real list rather than guessing. Also use this before place_order if you have not seen the ' +
      'catalog yet this conversation.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ─── 2. place_order ─────────────────────────────────────────────────────────
  {
    name: 'place_order',
    description:
      'Structure a confirmed customer order. Use ONLY once you know exactly which item(s), quantities, ' +
      'and (if relevant) variant/size the customer wants — call browse_catalog first if an item number ' +
      'is not clearly one you have seen. If the message is ambiguous (no item number, unclear which ' +
      'product, quantity not stated), ask ONE short clarifying question instead of guessing and do NOT ' +
      'call this tool yet — never guess an item or quantity. Seller-owned items are checked against live ' +
      'stock automatically and confirmed or declined immediately; supplier-dependent items are always ' +
      'staged as pending verification — that is expected behaviour, not an error, and you should tell the ' +
      'customer their order is being confirmed rather than implying something went wrong. Call this once ' +
      'per order even when it has multiple items — do not call it once per item.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'One entry per distinct item the customer wants.',
          items: {
            type: 'object',
            properties: {
              item_number: { type: 'integer', description: 'The catalog item number, e.g. 3 for "Item 3".' },
              quantity:    { type: 'integer', description: 'How many units of this item.' },
              variant:     { type: 'string',  description: 'Size/colour/variant if the customer specified one. Optional.' },
            },
            required: ['item_number', 'quantity'],
          },
        },
        customer_name: { type: 'string', description: 'The customer\'s name, if they have given it. Optional.' },
      },
      required: ['items'],
    },
  },

  // ─── 3. check_order_status ──────────────────────────────────────────────────
  {
    name: 'check_order_status',
    description:
      'Show this customer their own recent orders and statuses with this seller. Use when they ask ' +
      '"where is my order", "did you get my order", "has it been confirmed", "has she seen my payment", etc.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ─── 4. switch_seller ───────────────────────────────────────────────────────
  {
    name: 'switch_seller',
    description:
      'Re-run seller identification when the customer clearly references a DIFFERENT seller than the one ' +
      'currently linked (they name another seller/business, or say they messaged the wrong shop). Do not ' +
      'use this for anything else, and do not use it just because you are unsure — only when the customer ' +
      'explicitly names someone else.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the customer said that names the other seller.' },
      },
      required: ['query'],
    },
  },
];

module.exports = { TOOLS };
