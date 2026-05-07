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
  // Backfill outcome on the matching inference log row
  query(
    `UPDATE ai_inference_log SET outcome = 'confirmed'
     WHERE id = (
       SELECT ail.id FROM ai_inference_log ail
       JOIN pending_entries pe ON pe.id = $1
       WHERE ail.user_id = pe.user_id
         AND ail.call_type = 'parse'
         AND ail.outcome IS NULL
         AND ail.created_at >= pe.created_at - INTERVAL '5 minutes'
       ORDER BY ail.created_at DESC LIMIT 1
     )`,
    [pendingId]
  ).catch(() => {});
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
  query(
    `UPDATE ai_inference_log SET outcome = 'edited'
     WHERE id = (
       SELECT ail.id FROM ai_inference_log ail
       JOIN pending_entries pe ON pe.id = $1
       WHERE ail.user_id = pe.user_id
         AND ail.call_type = 'parse'
         AND ail.outcome IS NULL
         AND ail.created_at >= pe.created_at - INTERVAL '5 minutes'
       ORDER BY ail.created_at DESC LIMIT 1
     )`,
    [pendingId]
  ).catch(() => {});
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

// ── Fetch the most recent 'edited' entry for a user (within 2h) ───────────────
// Used by the learning system: if a user confirmed YES after editing, the
// edited entry is the "before" and the new confirmed entry is the "after".
async function getRecentEditedEntry(userId) {
  const res = await query(
    `SELECT * FROM pending_entries
     WHERE user_id = $1
       AND status = 'edited'
       AND created_at > NOW() - INTERVAL '2 hours'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

// ── Confirmation message builders ─────────────────────────────────────────

function buildConfirmationMessage(entryType, parsedData) {
  if (entryType === 'inventory_in')  return buildStockInConfirmation(parsedData);
  if (entryType === 'inventory_out') return buildStockOutConfirmation(parsedData);
  if (entryType === 'opening_stock') return buildOpeningStockConfirmation(parsedData);
  if (entryType === 'stock_zero')    return buildStockZeroConfirmation(parsedData);
  if (entryType === 'debt_payment')  return buildDebtPaymentConfirmation(parsedData);
  return buildDailyEntryConfirmation(parsedData);
}

function buildDailyEntryConfirmation(data) {
  const { revenue, totalExpenses, profit, expenseBreakdown, expenseItems, products, entry_date } = data;
  const lines = ['Got it — confirm this is correct:\n'];

  // Show date label when entry is backdated
  if (entry_date) {
    try {
      const d          = new Date(entry_date + 'T12:00:00Z');
      const dateStr    = d.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });
      const yesterday  = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      const label      = entry_date === yesterday ? `${dateStr} (yesterday)` : dateStr;
      lines.push(`📅 *Date: ${label}*\n`);
    } catch (_) { /* ignore malformed dates */ }
  }

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

  // Revenue / profit summary for this entry
  const rev = parseFloat(revenue) || 0;
  const exp = parseFloat(totalExpenses) || 0;
  const p   = rev - exp; // always recalculate — never trust Gemini's profit field directly
  if (rev > 0) {
    lines.push(`💰 *Revenue (this entry): ${fmt(rev)}*`);
    if (exp > 0) {
      lines.push(`📉 Expenses: ${fmt(exp)}`);
      const profitStr = p >= 0 ? fmt(p) : `-${fmt(Math.abs(p))}`;
      lines.push(`📊 Profit: *${profitStr}*\n`);
    } else {
      lines.push('');
    }
  }
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
  const { item, quantity, sale_type, debtor_name, products } = data;
  const isCredit = sale_type === 'credit';
  const lines = ['Got it — confirm this is correct:\n'];

  lines.push(isCredit ? '📝 *CREDIT SALE*' : '📦 *SOLD*');

  const sales = (products || []).filter(p => p.transaction_type === 'sale');
  if (sales.length > 0) {
    for (const p of sales) {
      const priceNote = p.unit_price ? ` at ${fmt(p.unit_price)} each` : '';
      const totalNote = p.total_amount ? ` — total: ${fmt(p.total_amount)}` : '';
      lines.push(`- ${p.product_name}: ${p.quantity || '?'} ${p.unit || 'units'}${priceNote}${totalNote}`);
    }
  } else {
    lines.push(`- ${item || 'item'}: ${quantity || '?'} units`);
  }

  if (isCredit && debtor_name) {
    lines.push('');
    lines.push(`💳 *On credit — ${debtor_name} will pay later*`);
    lines.push(`(Stock will be deducted. Revenue recorded when they pay.)`);
  }

  lines.push('');
  lines.push('Reply *YES* to log ✅');
  lines.push('Reply *EDIT* if something is wrong ❌');
  return lines.join('\n');
}

function buildOversellQuestion(oversells) {
  const lines = [];
  for (const o of oversells) {
    lines.push(
      `⚠️ You only have *${o.available_qty.toLocaleString('en-NG')} ${o.product_name}* logged, but you sold *${o.requested_qty.toLocaleString('en-NG')}*.`
    );
  }
  lines.push('');
  lines.push('Did you restock without logging it?');
  lines.push('');
  lines.push('*YES* — Add the missing stock automatically ✅');
  lines.push('*NO* — I sold from old unlogged stock (set to 0) 📦');
  lines.push('*CANCEL* — Ignore this sale ❌');
  return lines.join('\n');
}

function buildDebtPaymentConfirmation(data) {
  const { debtor_name, amount } = data;
  return [
    'Got it — confirm this is correct:\n',
    '💰 *PAYMENT RECEIVED*',
    `- From: *${debtor_name}*`,
    `- Amount: *${fmt(amount)}*`,
    '',
    'Reply *YES* to log this as revenue ✅',
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
  getRecentEditedEntry,
  buildConfirmationMessage,
  buildDebtPaymentConfirmation,
  buildOversellQuestion,
  getConfirmationMetrics,
};
