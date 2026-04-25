/**
 * services/confirmationService.js
 *
 * Task 1 — Parse confirmation before any DB write.
 *
 * Flow:
 *   1. Message parsed → savePending() stores result in pending_entries
 *   2. buildConfirmationMessage() formats what was understood
 *   3. User replies YES → confirmEntry() + caller commits to real tables
 *   4. User replies EDIT → editEntry() + prompt to resend
 *   5. New message while pending → discardEntry() + treat as new parse
 *   6. No reply in 2h → sendReminder(); no reply in 4h → expireOldEntries()
 */

'use strict';

const { query } = require('../models/db');

// ── Currency formatter ────────────────────────────────────────────────────
function fmt(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG');
}

// ── Save parsed result to pending_entries (does NOT write to real tables) ─
async function savePending(userId, entryType, parsedData, originalMessage) {
  // Discard any existing pending entry for this user before saving new one
  await query(
    `UPDATE pending_entries SET status = 'discarded'
     WHERE user_id = $1 AND status = 'pending'`,
    [userId]
  );
  const res = await query(
    `INSERT INTO pending_entries (user_id, entry_type, parsed_data, original_message)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, entryType, JSON.stringify(parsedData), originalMessage]
  );
  return res.rows[0]?.id;
}

// ── Get the most recent pending entry that hasn't expired ─────────────────
async function getPendingEntry(userId) {
  const res = await query(
    `SELECT * FROM pending_entries
     WHERE user_id = $1
       AND status = 'pending'
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

// ── Status transitions ────────────────────────────────────────────────────
async function confirmEntry(pendingId) {
  await query(
    `UPDATE pending_entries
     SET status = 'confirmed', confirmed_at = NOW()
     WHERE id = $1`,
    [pendingId]
  );
}

async function discardEntry(pendingId) {
  await query(
    `UPDATE pending_entries SET status = 'discarded' WHERE id = $1`,
    [pendingId]
  );
}

async function editEntry(pendingId) {
  await query(
    `UPDATE pending_entries SET status = 'edited' WHERE id = $1`,
    [pendingId]
  );
}

// ── Expire entries older than 4h and return list for logging ──────────────
async function expireOldEntries() {
  const res = await query(
    `UPDATE pending_entries
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < NOW()
     RETURNING id, user_id`
  );
  return res.rows;
}

// ── Send 2-hour reminder for entries that haven't had one yet ─────────────
async function getPendingNeedingReminder() {
  const res = await query(
    `SELECT pe.*, u.whatsapp_number, u.name
     FROM pending_entries pe
     JOIN users u ON u.id = pe.user_id
     WHERE pe.status = 'pending'
       AND pe.reminder_sent = false
       AND pe.created_at < NOW() - INTERVAL '2 hours'
       AND pe.expires_at > NOW()
       AND u.whatsapp_number IS NOT NULL`
  );
  return res.rows;
}

async function markReminderSent(pendingId) {
  await query(
    `UPDATE pending_entries SET reminder_sent = true WHERE id = $1`,
    [pendingId]
  );
}

// ── Confirmation message builders ─────────────────────────────────────────

function buildConfirmationMessage(entryType, parsedData) {
  if (entryType === 'inventory_in')  return buildStockInConfirmation(parsedData);
  if (entryType === 'inventory_out') return buildStockOutConfirmation(parsedData);
  if (entryType === 'opening_stock') return buildOpeningStockConfirmation(parsedData);
  if (entryType === 'stock_zero')    return buildStockZeroConfirmation(parsedData);
  return buildDailyEntryConfirmation(parsedData);
}

function buildDailyEntryConfirmation(data) {
  const { revenue, totalExpenses, profit, expenseBreakdown, expenseItems, products } = data;
  const lines = ['Got it — confirm this is correct:\n'];

  const sales   = (products || []).filter(p => p.transaction_type === 'sale');
  const stockIns = (products || []).filter(p => p.transaction_type === 'stock_in');

  // Product sales
  if (sales.length > 0) {
    lines.push('📦 *SOLD*');
    for (const p of sales) {
      if (p.quantity && p.unit_price) {
        lines.push(`- ${p.product_name}: ${p.quantity} ${p.unit || 'units'} at ${fmt(p.unit_price)} each`);
        lines.push(`  Revenue: ${fmt(p.total_amount)}`);
      } else {
        lines.push(`- ${p.product_name}: ${fmt(p.total_amount)}`);
      }
    }
    lines.push('');
  } else if (!products || products.length === 0) {
    // No product detail — show revenue total
    lines.push(`💰 *Revenue: ${fmt(revenue)}*`);
    lines.push('');
  }

  // Stock received within a daily_entry (e.g. sold X and received Y)
  if (stockIns.length > 0) {
    lines.push('📦 *STOCK RECEIVED*');
    for (const p of stockIns) {
      if (p.quantity && p.unit_price) {
        lines.push(`- ${p.product_name}: ${p.quantity} ${p.unit || 'units'} at ${fmt(p.unit_price)} each`);
        lines.push(`  Total cost: ${fmt(p.total_amount)}`);
      } else {
        lines.push(`- ${p.product_name}: ${fmt(p.total_amount)}`);
      }
    }
    lines.push('');
  }

  // Expenses — prefer individual items (expenseItems), fall back to category totals
  const hasItems = Array.isArray(expenseItems) && expenseItems.length > 0;
  const expEntries = hasItems
    ? expenseItems.filter(e => parseFloat(e.amount) > 0).map(e => [e.name, e.amount])
    : Object.entries(expenseBreakdown || {}).filter(([, v]) => parseFloat(v) > 0);
  if (expEntries.length > 0) {
    lines.push('💸 *EXPENSES*');
    for (const [label, amt] of expEntries) {
      lines.push(`- ${label}: ${fmt(amt)}`);
    }
    lines.push('');
  }

  // Profit line
  const p = parseFloat(profit) || 0;
  const profitStr = p >= 0 ? fmt(p) : `-${fmt(Math.abs(p))}`;
  lines.push(`💰 *Profit today so far: ${profitStr}*\n`);
  lines.push('Reply *YES* to log ✅');
  lines.push('Reply *EDIT* if something is wrong ❌');

  return lines.join('\n');
}

function buildStockInConfirmation(data) {
  const { item, quantity, unitPrice, totalValue, products } = data;
  const lines = ['Got it — confirm this is correct:\n', '📦 *STOCK RECEIVED*'];

  // Use product array if present (from updated Gemini parser)
  const stockIns = (products || []).filter(p => p.transaction_type === 'stock_in');
  if (stockIns.length > 0) {
    for (const p of stockIns) {
      if (p.quantity && p.unit_price) {
        lines.push(`- ${p.product_name}: ${p.quantity} ${p.unit || 'units'} at ${fmt(p.unit_price)} each`);
        lines.push(`  Total cost: ${fmt(p.total_amount)}`);
      } else {
        lines.push(`- ${p.product_name}: ${fmt(p.total_amount || 0)}`);
      }
    }
  } else {
    // Fallback to flat inventory_in fields
    if (quantity && unitPrice) {
      lines.push(`- ${item}: ${quantity} units at ${fmt(unitPrice)} each`);
      lines.push(`  Total cost: ${fmt(totalValue || quantity * unitPrice)}`);
    } else {
      lines.push(`- ${item}: ${quantity || '?'} units`);
      if (totalValue) lines.push(`  Total value: ${fmt(totalValue)}`);
    }
  }

  lines.push('');
  lines.push('Reply *YES* to log ✅');
  lines.push('Reply *EDIT* if something is wrong ❌');
  return lines.join('\n');
}

function buildStockOutConfirmation(data) {
  const { item, quantity } = data;
  return [
    'Got it — confirm this is correct:\n',
    '📦 *SOLD*',
    `- ${item}: ${quantity} units`,
    '',
    'Reply *YES* to log ✅',
    'Reply *EDIT* if something is wrong ❌',
  ].join('\n');
}

function buildOpeningStockConfirmation(data) {
  const products = data.products || [];
  const lines = ['Here\'s what I captured as your opening stock:\n', '📦 *OPENING STOCK*'];
  for (const p of products) {
    const name  = p.product_name || 'Unknown';
    const qty   = p.quantity || 0;
    const unit  = p.unit || 'units';
    const price = p.unit_price ? ` at ${fmt(p.unit_price)} each` : '';
    lines.push(`- ${name}: ${qty} ${unit}${price}`);
  }
  lines.push('');
  lines.push('Reply *YES* to set these as your starting stock levels ✅');
  lines.push('Reply *EDIT* if something is wrong ❌');
  return lines.join('\n');
}

function buildStockZeroConfirmation(data) {
  const name  = data.product_name || 'this product';
  const stock = parseFloat(data.current_stock) || 0;
  return [
    `Got it — confirm this is correct:\n`,
    `🔴 *MARK AS OUT OF STOCK*`,
    `- ${name}: ${stock.toLocaleString('en-NG')} units remaining → 0`,
    ``,
    `Reply *YES* to mark it as out of stock ✅`,
    `Reply *EDIT* if you meant something else ❌`,
  ].join('\n');
}

// ── Admin metrics ─────────────────────────────────────────────────────────
async function getConfirmationMetrics(days = 7) {
  const res = await query(
    `SELECT
       COUNT(*)                                                AS total_parsed,
       COUNT(*) FILTER (WHERE status = 'confirmed')           AS confirmed,
       COUNT(*) FILTER (WHERE status = 'edited')              AS edited,
       COUNT(*) FILTER (WHERE status = 'expired')             AS expired,
       COUNT(*) FILTER (WHERE status = 'discarded')           AS discarded,
       ROUND(
         COUNT(*) FILTER (WHERE status = 'edited')::NUMERIC
         / NULLIF(COUNT(*) FILTER (WHERE status IN ('confirmed','edited','expired')), 0) * 100, 1
       ) AS correction_rate
     FROM pending_entries
     WHERE created_at > NOW() - ($1 * INTERVAL '1 day')`,
    [days]
  );
  return res.rows[0];
}

module.exports = {
  savePending,
  getPendingEntry,
  confirmEntry,
  discardEntry,
  editEntry,
  expireOldEntries,
  getPendingNeedingReminder,
  markReminderSent,
  buildConfirmationMessage,
  getConfirmationMetrics,
};
