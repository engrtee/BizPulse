'use strict';

/**
 * Tool definitions for the Kemi Claude agent.
 * Passed as the `tools` array in every anthropic.messages.create() call.
 *
 * Writing guidelines used here:
 * - Descriptions written as if briefing a new employee who has never seen
 *   the codebase. Include when to use, when NOT to, and edge cases.
 * - input_schema uses JSON Schema draft-07 (what the Anthropic API expects).
 */

const TOOLS = [

  // ─── 1. log_sale ────────────────────────────────────────────────────────────
  {
    name: 'log_sale',
    description:
      'Record that the trader sold something. ' +
      'Use this whenever the message mentions selling, customer buying, money coming in for a product, ' +
      '"customer pay", "I move", "sold", "sell". ' +
      'A single message may name multiple products — call this tool once per product. ' +
      'If quantity is not stated but a total amount is given, log quantity=1 and unit_price=that amount. ' +
      'If only "k" shorthand is given (e.g. "5k"), convert to 5000 before passing unit_price. ' +
      'Do NOT use for: general revenue logs without a product name (use get_sales_summary to check); ' +
      'credit sales where customer has not paid yet (set is_credit=true instead).',
    input_schema: {
      type: 'object',
      properties: {
        product:       { type: 'string',  description: 'Raw product name exactly as the trader said it.' },
        quantity:      { type: 'number',  description: 'Number of units sold.' },
        unit:          { type: 'string',  description: 'Unit of measure: pieces, cartons, bags, bottles, yards, etc. Default: pieces.' },
        unit_price:    { type: 'number',  description: 'Selling price per unit in Naira. Optional if only a total is given.' },
        customer_name: { type: 'string',  description: 'Name of the customer. Optional.' },
        is_credit:     { type: 'boolean', description: 'Set true if the customer has NOT paid yet. Default false.' },
        note:          { type: 'string',  description: 'Any extra context from the message. Optional.' },
      },
      required: ['product', 'quantity', 'unit'],
    },
  },

  // ─── 2. log_restock ─────────────────────────────────────────────────────────
  {
    name: 'log_restock',
    description:
      'Record that the trader received or bought new inventory. ' +
      'Use when the message contains: received, carry come, supply come, bought stock, ' +
      'restock, delivery arrived, "from supplier", "new stock". ' +
      'Do NOT use for general expense logging without a named product. ' +
      'Restocking does NOT add to revenue — it only updates stock levels. ' +
      'If the trader states a total cost (not per-unit), set total_cost and leave unit_cost null.',
    input_schema: {
      type: 'object',
      properties: {
        product:       { type: 'string', description: 'Raw product name as the trader said it.' },
        quantity:      { type: 'number', description: 'Number of units received.' },
        unit:          { type: 'string', description: 'Unit of measure.' },
        unit_cost:     { type: 'number', description: 'Cost price per unit in Naira. Optional.' },
        total_cost:    { type: 'number', description: 'Total amount paid for all units. Optional.' },
        supplier_name: { type: 'string', description: 'Supplier name if mentioned. Optional.' },
        note:          { type: 'string', description: 'Any extra context. Optional.' },
      },
      required: ['product', 'quantity', 'unit'],
    },
  },

  // ─── 3. get_stock_level ─────────────────────────────────────────────────────
  {
    name: 'get_stock_level',
    description:
      'Look up current stock levels. ' +
      'Use when the trader asks: "how many left?", "stock?", "what do I have?", "check my [product]". ' +
      'Pass a product name to check a specific item; leave product empty to return all items. ' +
      'Do NOT use this to surface proactive restocking alerts — use get_stock_intelligence for that.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product name to look up. Leave empty to return all products.' },
      },
      required: [],
    },
  },

  // ─── 4. get_stock_intelligence ──────────────────────────────────────────────
  {
    name: 'get_stock_intelligence',
    description:
      'Return velocity-based stock intelligence for this trader: what needs restocking urgently, ' +
      'what is selling fast, what is a slow mover, and what is out of stock. ' +
      'Use proactively after logging a sale if any item shows urgency. ' +
      'Also use when the trader asks: "what should I restock?", "what is selling?", "any stock issues?". ' +
      'All numbers come from SQL — Kemi only narrates the result.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ─── 5. get_sales_summary ───────────────────────────────────────────────────
  {
    name: 'get_sales_summary',
    description:
      'Return a financial summary for a time period. ' +
      'Use when the trader asks: "how did I do today?", "what are my numbers?", ' +
      '"this week?", "how much profit?", "what was my best day?". ' +
      'Use period="today" for anything referring to today\'s performance. ' +
      'Use period="custom" with start_date + end_date for specific date ranges. ' +
      'For "yesterday" always use period="yesterday" even if the trader says "last night".',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'custom'],
          description: 'The time window.',
        },
        start_date: { type: 'string', description: 'YYYY-MM-DD, only for period=custom.' },
        end_date:   { type: 'string', description: 'YYYY-MM-DD, only for period=custom.' },
      },
      required: ['period'],
    },
  },

  // ─── 6. search_products ─────────────────────────────────────────────────────
  {
    name: 'search_products',
    description:
      'Fuzzy-search the trader\'s product list by name. ' +
      'Use only when the normaliser returned multiple possible matches and Kemi is genuinely unsure ' +
      'which product the trader means. Do NOT call this for every message — it is a disambiguation tool. ' +
      'Example: trader says "mango" and they have both "Mango Juice" and "Dried Mango" in their catalogue.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term to match against product names.' },
      },
      required: ['query'],
    },
  },

  // ─── 7. correct_last_entry ──────────────────────────────────────────────────
  {
    name: 'correct_last_entry',
    description:
      'Update or delete the most recent product transaction for this trader. ' +
      'Use when the trader says: "that was wrong", "remove that", "change the quantity", ' +
      '"delete last entry", "I made a mistake". ' +
      'action=delete performs a soft-delete (marks as voided). ' +
      'action=update_amount, update_item, or update_quantity applies the specific change.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['update_amount', 'update_item', 'update_quantity', 'delete'],
        },
        new_amount:   { type: 'number', description: 'New total amount in Naira. For update_amount.' },
        new_item:     { type: 'string', description: 'Corrected product name. For update_item.' },
        new_quantity: { type: 'number', description: 'Corrected quantity. For update_quantity.' },
      },
      required: ['action'],
    },
  },

  // ─── 8. log_debt ────────────────────────────────────────────────────────────
  {
    name: 'log_debt',
    description:
      'Record that a customer owes the trader money. ' +
      'Use when the trader says: "[name] dey owe", "they carry go without paying", ' +
      '"buy now pay later", "on credit", "customer owe me". ' +
      'This creates a new outstanding debt record. ' +
      'Do NOT use to record payment of an existing debt — use settle_debt for that.',
    input_schema: {
      type: 'object',
      properties: {
        debtor_name: { type: 'string',  description: 'Name of the person who owes.' },
        amount:      { type: 'number',  description: 'Amount owed in Naira.' },
        product:     { type: 'string',  description: 'What was taken on credit. Optional.' },
        note:        { type: 'string',  description: 'Any extra context. Optional.' },
      },
      required: ['debtor_name', 'amount'],
    },
  },

  // ─── 9. settle_debt ─────────────────────────────────────────────────────────
  {
    name: 'settle_debt',
    description:
      'Mark a debt as settled when the customer pays back. ' +
      'Use when the trader says: "[name] don pay", "[name] settle", "they paid their balance", ' +
      '"received money from [name]". ' +
      'For partial payment: pass amount; the debt will be partially reduced. ' +
      'For full payment: omit amount and the oldest matching outstanding debt is fully settled.',
    input_schema: {
      type: 'object',
      properties: {
        debtor_name: { type: 'string', description: 'Name of the person paying back.' },
        amount:      { type: 'number', description: 'Amount paid. Omit for full settlement.' },
      },
      required: ['debtor_name'],
    },
  },

  // ─── 10. get_debts ──────────────────────────────────────────────────────────
  {
    name: 'get_debts',
    description:
      'Return the trader\'s debt records. ' +
      'Use when the trader asks: "who owes me?", "my debtors", "outstanding debts", ' +
      '"how much is owed to me?". ' +
      'Default is outstanding only — no need to ask the trader which status they want.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['outstanding', 'settled', 'all'],
          description: 'Filter by debt status. Default: outstanding.',
        },
      },
      required: [],
    },
  },

  // ─── 11. set_goal ───────────────────────────────────────────────────────────
  {
    name: 'set_goal',
    description:
      'Create or replace a revenue or profit target for the trader. ' +
      'Use when the trader says: "I want to make X this month", "my target is X", ' +
      '"set my goal to X". ' +
      'A trader can only have one active goal per period+type combination — ' +
      'setting a new one replaces the old one.',
    input_schema: {
      type: 'object',
      properties: {
        type:   { type: 'string', enum: ['revenue', 'profit'],                description: 'What they are targeting.' },
        amount: { type: 'number',                                             description: 'Target amount in Naira.' },
        period: { type: 'string', enum: ['daily', 'weekly', 'monthly'],      description: 'Period the goal applies to.' },
      },
      required: ['type', 'amount', 'period'],
    },
  },

  // ─── 12. log_expense ────────────────────────────────────────────────────────
  {
    name: 'log_expense',
    description:
      'Record a business expense that is NOT a product purchase. ' +
      'Use for: rent, transport, keke/okada, market fare, electricity, water bill, staff wages, ' +
      'generator fuel, maintenance, repairs, marketing, phone credit, packaging, cleaning. ' +
      'Do NOT use for buying inventory — use log_restock for that. ' +
      'Examples: "pay rent 15k", "spend 2500 on keke", "pay cleaner 5000".',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['rent', 'transport', 'utilities', 'wages', 'maintenance', 'marketing', 'other'],
          description: 'Closest expense category.',
        },
        amount: { type: 'number', description: 'Amount spent in Naira.' },
        note:   { type: 'string', description: 'Brief description, e.g. "shop rent May". Optional.' },
      },
      required: ['category', 'amount'],
    },
  },

  // ─── 13. compare_periods ────────────────────────────────────────────────────
  {
    name: 'compare_periods',
    description:
      'Compare performance across two time periods. ' +
      'Use when the trader asks: "am I doing better than last week?", ' +
      '"compare this month to last month", "how does today compare to yesterday?". ' +
      'Returns delta and percentage change for revenue, profit, and units sold.',
    input_schema: {
      type: 'object',
      properties: {
        period1: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'last_week', 'this_month'],
          description: 'The more recent period.',
        },
        period2: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'last_week', 'this_month'],
          description: 'The comparison (older) period.',
        },
      },
      required: ['period1', 'period2'],
    },
    cache_control: { type: 'ephemeral' },
  },

];

module.exports = { TOOLS };
