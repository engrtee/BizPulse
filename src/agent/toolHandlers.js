'use strict';

const { query }           = require('../../models/db');
const { normaliseProduct } = require('./normaliser');
const { getStockIntelligence, todayWAT } = require('./stockIntelligence');

// ── Shared helpers ────────────────────────────────────────────────────────────

function fmt(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG');
}

/** Fetch the user row from whatsapp_number. Uses the same format-normalising
 *  CASE logic as UserModel.findByWhatsapp so +234 / 0 / 234 variants all match. */
async function getUser(whatsappNumber) {
  const UserModel = require('../../models/user');
  const user = await UserModel.findByWhatsapp(whatsappNumber);
  if (!user) throw new Error(`User not found for ${whatsappNumber}`);
  return user;
}

/**
 * Find or create a product record for this user.
 * Uses the normalised name as the unique key.
 */
async function findOrCreateProduct(userId, canonicalName, unit) {
  const normalised = canonicalName.toLowerCase().replace(/\s+/g, ' ').trim();
  const res = await query(
    `INSERT INTO products
       (user_id, product_name, product_name_normalized, unit)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, product_name_normalized)
     DO UPDATE SET
       product_name = EXCLUDED.product_name,
       unit = CASE
         WHEN EXCLUDED.unit IS NOT NULL AND EXCLUDED.unit != 'units'
         THEN EXCLUDED.unit
         ELSE products.unit
       END,
       updated_at = NOW()
     RETURNING id, product_name, unit, current_stock`,
    [userId, canonicalName, normalised, unit || 'units']
  );
  return res.rows[0];
}

/** Return daily revenue total from product_transactions for today. */
async function getDailyRevenueSoFar(userId) {
  const today = todayWAT();
  const res = await query(
    `SELECT COALESCE(SUM(total_amount), 0)::NUMERIC AS daily_revenue
     FROM product_transactions
     WHERE user_id = $1
       AND transaction_date = $2
       AND transaction_type = 'sale'`,
    [userId, today]
  );
  return parseFloat(res.rows[0]?.daily_revenue) || 0;
}

// ── Period helper for get_sales_summary / compare_periods ────────────────────

function getPeriodDates(period) {
  const now       = new Date();
  const watNow    = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const today     = todayWAT();
  const yesterday = new Date(Date.now() - 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  const dayOfWeek = watNow.getDay(); // 0 = Sun
  const daysSinceMonday = (dayOfWeek + 6) % 7;

  const thisWeekStart = new Date(watNow);
  thisWeekStart.setDate(watNow.getDate() - daysSinceMonday);
  const thisWeekStartStr = thisWeekStart.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(thisWeekStart.getDate() - 7);
  const lastWeekStartStr = lastWeekStart.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const lastWeekEnd  = new Date(thisWeekStart);
  lastWeekEnd.setDate(thisWeekStart.getDate() - 1);
  const lastWeekEndStr = lastWeekEnd.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  const thisMonthStart = `${watNow.getFullYear()}-${String(watNow.getMonth() + 1).padStart(2, '0')}-01`;

  switch (period) {
    case 'today':      return { start: today,          end: today };
    case 'yesterday':  return { start: yesterday,      end: yesterday };
    case 'this_week':  return { start: thisWeekStartStr, end: today };
    case 'last_week':  return { start: lastWeekStartStr, end: lastWeekEndStr };
    case 'this_month': return { start: thisMonthStart,  end: today };
    default:           return { start: today,          end: today };
  }
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function logSaleHandler({ product, quantity, unit, unit_price, customer_name, is_credit, note, whatsappNumber }) {
  const user          = await getUser(whatsappNumber);
  const canonicalName = await normaliseProduct(product, whatsappNumber);
  const productRow    = await findOrCreateProduct(user.id, canonicalName, unit);

  const qty       = parseFloat(quantity) || 1;
  const unitPrice = parseFloat(unit_price) || 0;
  const total     = unitPrice > 0 ? qty * unitPrice : 0;
  const today     = todayWAT();

  // Decrement stock (floor at 0)
  await query(
    `UPDATE products
     SET current_stock = GREATEST(0, current_stock - $1),
         last_sale_price = CASE WHEN $2 > 0 THEN $2 ELSE last_sale_price END,
         updated_at = NOW()
     WHERE id = $3`,
    [qty, unitPrice, productRow.id]
  );

  // Insert product transaction
  await query(
    `INSERT INTO product_transactions
       (user_id, product_id, transaction_type, quantity, unit_price,
        total_amount, transaction_date, sale_type, notes)
     VALUES ($1, $2, 'sale', $3, $4::NUMERIC, $5::NUMERIC, $6, $7, $8)`,
    [user.id, productRow.id, qty, unitPrice || null, total || null,
     today, is_credit ? 'credit' : 'cash', note || customer_name || null]
  );

  // Write to transactions table so the existing 7pm summary job sees the revenue.
  // Use last_purchase_price as COGS when available — otherwise margin stays NULL
  // rather than the misleading 100% that was here before.
  if (total > 0 && !is_credit) {
    const costRes = await query(
      `SELECT last_purchase_price FROM products WHERE id = $1`,
      [productRow.id]
    );
    const costPerUnit = parseFloat(costRes.rows[0]?.last_purchase_price) || null;
    const cogs        = costPerUnit !== null ? costPerUnit * qty : null;
    const txProfit    = cogs !== null ? total - cogs : null;
    const txMargin    = txProfit !== null && total > 0
      ? parseFloat(((txProfit / total) * 100).toFixed(2))
      : null;

    await query(
      `INSERT INTO transactions
         (user_id, date, revenue, total_expenses, expense_breakdown,
          profit, margin, customers, notes, entry_method)
       VALUES ($1, $2::DATE, $3, COALESCE($4,0), '{}', $5, $6, 0, $7, 'kemi')`,
      [user.id, today, total, cogs, txProfit, txMargin,
       `Kemi: sold ${qty} ${unit || 'units'} ${canonicalName}`]
    );
  }

  // If credit, also create a debt record
  if (is_credit) {
    await logDebtHandler({
      debtor_name: customer_name || 'Customer',
      amount:      total || 0,
      product:     canonicalName,
      note:        note || null,
      whatsappNumber,
    });
  }

  // Fetch updated stock
  const updated = await query(
    `SELECT current_stock FROM products WHERE id = $1`, [productRow.id]
  );
  const newStock       = parseFloat(updated.rows[0]?.current_stock) || 0;
  const dailyRevenue   = await getDailyRevenueSoFar(user.id);

  return {
    success:           true,
    canonical_product: canonicalName,
    quantity_sold:     qty,
    unit:              unit || 'units',
    unit_price:        unitPrice,
    total:             total,
    new_stock_level:   newStock,
    daily_revenue_so_far: dailyRevenue,
    is_credit:         !!is_credit,
  };
}

async function logRestockHandler({ product, quantity, unit, unit_cost, total_cost, supplier_name, note, whatsappNumber }) {
  const user          = await getUser(whatsappNumber);
  const canonicalName = await normaliseProduct(product, whatsappNumber);
  const productRow    = await findOrCreateProduct(user.id, canonicalName, unit);

  const qty      = parseFloat(quantity) || 1;
  const cost     = unit_cost ? parseFloat(unit_cost)
                 : total_cost ? parseFloat(total_cost) / qty
                 : null;
  const totalVal = total_cost ? parseFloat(total_cost)
                 : (cost ? cost * qty : null);
  const today    = todayWAT();

  // Increment stock
  await query(
    `UPDATE products
     SET current_stock       = current_stock + $1,
         total_ever_received = total_ever_received + $1,
         last_purchase_price = COALESCE($2::NUMERIC, last_purchase_price),
         updated_at = NOW()
     WHERE id = $3`,
    [qty, cost ?? null, productRow.id]
  );

  // Insert product transaction
  await query(
    `INSERT INTO product_transactions
       (user_id, product_id, transaction_type, quantity, unit_price,
        total_amount, transaction_date, notes)
     VALUES ($1, $2, 'stock_in', $3, $4::NUMERIC, $5::NUMERIC, $6, $7)`,
    [user.id, productRow.id, qty, cost ?? null, totalVal ?? null,
     today, [supplier_name, note].filter(Boolean).join(' — ') || null]
  );

  // Fetch updated stock and days-of-cover from materialized view
  const updatedRes = await query(
    `SELECT current_stock FROM products WHERE id = $1`, [productRow.id]
  );
  const newStock = parseFloat(updatedRes.rows[0]?.current_stock) || 0;

  // Best-effort cover read from MV (may be stale until next refresh)
  let daysOfCover = null;
  let velocity7d  = null;
  try {
    const mvRes = await query(
      `SELECT days_of_cover, velocity_7d
       FROM stock_intelligence_mv
       WHERE whatsapp_number = $1 AND product_id = $2`,
      [whatsappNumber, productRow.id]
    );
    if (mvRes.rows.length) {
      daysOfCover = mvRes.rows[0].days_of_cover !== null
        ? Math.round(parseFloat(mvRes.rows[0].days_of_cover))
        : null;
      velocity7d = parseFloat(mvRes.rows[0].velocity_7d) || null;
    }
  } catch (_) { /* MV may not exist yet on first run */ }

  return {
    success:                    true,
    canonical_product:          canonicalName,
    quantity_received:          qty,
    unit:                       unit || 'units',
    unit_cost:                  cost,
    new_stock_level:            newStock,
    days_of_cover_after_restock: daysOfCover,
    velocity_7d:                velocity7d,
  };
}

async function getStockLevelHandler({ product, whatsappNumber }) {
  const user = await getUser(whatsappNumber);

  if (product && product.trim()) {
    const canonicalName = await normaliseProduct(product, whatsappNumber);
    const normalised    = canonicalName.toLowerCase().replace(/\s+/g, ' ').trim();
    const res = await query(
      `SELECT product_name, current_stock, unit
       FROM products
       WHERE user_id = $1
         AND product_name_normalized ILIKE $2
         AND is_active = TRUE
       LIMIT 1`,
      [user.id, `%${normalised}%`]
    );
    if (!res.rows.length) return { found: false, product: canonicalName };
    const r = res.rows[0];
    return {
      found:        true,
      product:      r.product_name,
      current_stock: parseFloat(r.current_stock),
      unit:         r.unit,
    };
  }

  // Return all active products
  const res = await query(
    `SELECT product_name, current_stock, unit
     FROM products
     WHERE user_id = $1 AND is_active = TRUE
     ORDER BY product_name`,
    [user.id]
  );
  return {
    products: res.rows.map(r => ({
      product:       r.product_name,
      current_stock: parseFloat(r.current_stock),
      unit:          r.unit,
    })),
  };
}

async function getStockIntelligenceHandler(whatsappNumber) {
  return getStockIntelligence(whatsappNumber);
}

async function getSalesSummaryHandler({ period, start_date, end_date, whatsappNumber }) {
  const user = await getUser(whatsappNumber);

  let dates;
  if (period === 'custom' && start_date && end_date) {
    dates = { start: start_date, end: end_date };
  } else {
    dates = getPeriodDates(period || 'today');
  }

  const res = await query(
    `SELECT
       COALESCE(SUM(pt.total_amount), 0)::NUMERIC  AS total_revenue,
       COALESCE(SUM(pt.quantity),     0)::NUMERIC  AS total_units,
       COUNT(*)                                     AS transaction_count,
       json_agg(
         json_build_object(
           'product',    p.product_name,
           'units_sold', pt.quantity,
           'revenue',    pt.total_amount,
           'unit',       p.unit
         )
         ORDER BY pt.total_amount DESC NULLS LAST
       ) FILTER (WHERE pt.id IS NOT NULL)           AS all_products
     FROM product_transactions pt
     JOIN products p ON p.id = pt.product_id
     WHERE pt.user_id = $1
       AND pt.transaction_date BETWEEN $2 AND $3
       AND pt.transaction_type = 'sale'`,
    [user.id, dates.start, dates.end]
  );

  // Revenue comes from product_transactions (Kemi's source of truth for what was sold).
  // Expenses and profit come from transactions (where logExpenseHandler writes).
  // Both queries use the same WAT-based date range — intentional dual-source design.
  const txRes = await query(
    `SELECT
       COALESCE(SUM(total_expenses), 0)::NUMERIC AS total_expenses,
       COALESCE(SUM(profit),         0)::NUMERIC AS total_profit
     FROM transactions
     WHERE user_id = $1
       AND date BETWEEN $2 AND $3`,
    [user.id, dates.start, dates.end]
  );

  const r          = res.rows[0]   || {};
  const tx         = txRes.rows[0] || {};
  const revenue    = parseFloat(r.total_revenue)    || 0;
  const units      = parseFloat(r.total_units)      || 0;
  const expenses   = parseFloat(tx.total_expenses)  || 0;
  const profit     = parseFloat(tx.total_profit)    || (revenue - expenses);
  const marginPct  = revenue > 0 ? Math.round((profit / revenue) * 100) : 0;
  const txCount    = parseInt(r.transaction_count, 10) || 0;

  const allProducts = Array.isArray(r.all_products) ? r.all_products : [];
  const topProducts = [...allProducts]
    .sort((a, b) => parseFloat(b.revenue) - parseFloat(a.revenue))
    .slice(0, 3);

  return {
    period,
    start_date:        dates.start,
    end_date:          dates.end,
    total_revenue:     revenue,
    total_units_sold:  units,
    total_expenses:    expenses,
    net_profit:        profit,
    profit_margin_pct: marginPct,
    transaction_count: txCount,
    top_products:      topProducts,
  };
}

async function searchProductsHandler({ query: searchQuery, whatsappNumber }) {
  const user = await getUser(whatsappNumber);
  const res = await query(
    `SELECT id, product_name, current_stock, unit,
            LEVENSHTEIN(LOWER(product_name_normalized), LOWER($2)) AS dist
     FROM products
     WHERE user_id = $1
       AND is_active = TRUE
       AND (product_name ILIKE $3 OR product_name_normalized ILIKE $3)
     ORDER BY dist ASC
     LIMIT 3`,
    [user.id, searchQuery.toLowerCase().trim(), `%${searchQuery}%`]
  );
  return {
    matches: res.rows.map(r => ({
      product_id:    r.id,
      name:          r.product_name,
      current_stock: parseFloat(r.current_stock),
      unit:          r.unit,
    })),
  };
}

async function correctLastEntryHandler({ action, new_amount, new_item, new_quantity, whatsappNumber }) {
  const user = await getUser(whatsappNumber);

  // Find the most recent product transaction
  const recent = await query(
    `SELECT pt.id, pt.product_id, pt.quantity, pt.unit_price, pt.total_amount,
            p.product_name, p.current_stock
     FROM product_transactions pt
     JOIN products p ON p.id = pt.product_id
     WHERE pt.user_id = $1
     ORDER BY pt.created_at DESC
     LIMIT 1`,
    [user.id]
  );
  if (!recent.rows.length) return { corrected: false, reason: 'No recent entry found.' };

  const entry = recent.rows[0];

  if (action === 'delete') {
    // Soft-delete: mark the product_transaction as voided and restore stock
    await query(
      `UPDATE product_transactions SET notes = CONCAT(notes, ' [VOIDED]'), total_amount = 0
       WHERE id = $1`,
      [entry.id]
    );
    await query(
      `UPDATE products SET current_stock = current_stock + $1, updated_at = NOW()
       WHERE id = $2`,
      [parseFloat(entry.quantity) || 0, entry.product_id]
    );
    // Insert a correction row in transactions so the 7pm summary reflects the void.
    // INSERT-only rule preserved — we never UPDATE the original row.
    const voidedAmount = parseFloat(entry.total_amount) || 0;
    if (voidedAmount > 0) {
      const today = todayWAT();
      await query(
        `INSERT INTO transactions
           (user_id, date, revenue, total_expenses, expense_breakdown,
            profit, margin, customers, notes, entry_method)
         VALUES ($1, $2::DATE, $3, 0, '{}', $3, NULL, 0, $4, 'kemi')`,
        [user.id, today, -voidedAmount,
         `Kemi: voided sale of ${entry.product_name} [correction]`]
      );
    }
    return { corrected: true, what_changed: `Deleted sale of ${entry.product_name}. Stock restored.` };
  }

  if (action === 'update_quantity') {
    const oldQty   = parseFloat(entry.quantity) || 0;
    const newQty   = parseFloat(new_quantity)   || 0;
    const diff     = newQty - oldQty;
    const newTotal = entry.unit_price ? newQty * parseFloat(entry.unit_price) : entry.total_amount;
    await query(
      `UPDATE product_transactions SET quantity = $1, total_amount = $2 WHERE id = $3`,
      [newQty, newTotal, entry.id]
    );
    // Adjust stock (negative diff = sold more → reduce more)
    await query(
      `UPDATE products SET current_stock = GREATEST(0, current_stock - $1), updated_at = NOW()
       WHERE id = $2`,
      [diff, entry.product_id]
    );
    return { corrected: true, what_changed: `Quantity updated from ${oldQty} to ${newQty}.` };
  }

  if (action === 'update_amount') {
    await query(
      `UPDATE product_transactions SET total_amount = $1 WHERE id = $2`,
      [parseFloat(new_amount), entry.id]
    );
    return { corrected: true, what_changed: `Amount updated to ${fmt(new_amount)}.` };
  }

  if (action === 'update_item') {
    const canonicalName = await normaliseProduct(new_item, whatsappNumber);
    const newProduct    = await findOrCreateProduct(user.id, canonicalName, 'units');
    await query(
      `UPDATE product_transactions SET product_id = $1 WHERE id = $2`,
      [newProduct.id, entry.id]
    );
    return { corrected: true, what_changed: `Product corrected to ${canonicalName}.` };
  }

  return { corrected: false, reason: 'Unknown action.' };
}

async function logDebtHandler({ debtor_name, amount, product, note, whatsappNumber }) {
  await query(
    `INSERT INTO debts (whatsapp_number, debtor_name, amount, item, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [whatsappNumber, debtor_name, Math.round(parseFloat(amount) || 0),
     product || null, note || null]
  );
  return { logged: true, debtor_name, amount: parseFloat(amount) || 0 };
}

async function settleDebtHandler({ debtor_name, amount, whatsappNumber }) {
  // Find the oldest outstanding debt for this name
  const res = await query(
    `SELECT id, amount FROM debts
     WHERE whatsapp_number = $1
       AND LOWER(debtor_name) = LOWER($2)
       AND status = 'outstanding'
     ORDER BY created_at ASC
     LIMIT 1`,
    [whatsappNumber, debtor_name]
  );

  if (!res.rows.length) {
    return { settled: false, reason: `No outstanding debt found for ${debtor_name}.` };
  }

  const debt       = res.rows[0];
  const debtAmount = parseInt(debt.amount, 10);
  const paidAmount = amount ? Math.round(parseFloat(amount)) : debtAmount;
  const isFullPay  = paidAmount >= debtAmount;

  await query(
    `UPDATE debts
     SET status = $1, settled_at = CASE WHEN $2 THEN NOW() ELSE NULL END
     WHERE id = $3`,
    [isFullPay ? 'settled' : 'outstanding', isFullPay, debt.id]
  );

  // Record as revenue in transactions table.
  // Debt repayments are pure cash — no COGS applies, so margin is NULL.
  const today = todayWAT();
  const user  = await getUser(whatsappNumber);
  await query(
    `INSERT INTO transactions
       (user_id, date, revenue, total_expenses, expense_breakdown,
        profit, margin, customers, notes, entry_method)
     VALUES ($1, $2::DATE, $3, 0, '{}', $3, NULL, 0, $4, 'kemi')`,
    [user.id, today, paidAmount, `Debt payment from ${debtor_name}`]
  );

  return {
    settled:     true,
    debtor_name,
    amount_paid: paidAmount,
    fully_paid:  isFullPay,
    remaining:   isFullPay ? 0 : debtAmount - paidAmount,
  };
}

async function getDebtsHandler({ status, whatsappNumber }) {
  const effectiveStatus = status || 'outstanding';
  let whereClause = 'whatsapp_number = $1';
  const params    = [whatsappNumber];

  if (effectiveStatus !== 'all') {
    whereClause += ' AND status = $2';
    params.push(effectiveStatus);
  }

  const res = await query(
    `SELECT debtor_name, amount, item, note, status, created_at
     FROM debts
     WHERE ${whereClause}
     ORDER BY created_at DESC`,
    params
  );

  const totalOutstanding = res.rows
    .filter(r => r.status === 'outstanding')
    .reduce((s, r) => s + parseInt(r.amount, 10), 0);

  return {
    debts: res.rows.map(r => ({
      debtor_name: r.debtor_name,
      amount:      parseInt(r.amount, 10),
      item:        r.item,
      status:      r.status,
      days_ago:    Math.round((Date.now() - new Date(r.created_at).getTime()) / 86400000),
    })),
    total_outstanding: totalOutstanding,
  };
}

async function setGoalHandler({ type, amount, period, whatsappNumber }) {
  const rounded = Math.round(parseFloat(amount) || 0);
  await query(
    `INSERT INTO goals (whatsapp_number, type, amount, period)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (whatsapp_number, type, period)
     DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()`,
    [whatsappNumber, type, rounded, period]
  );

  // Return current progress for today/this week/this month
  const user        = await getUser(whatsappNumber);
  const dates       = getPeriodDates(period === 'daily' ? 'today' : period === 'weekly' ? 'this_week' : 'this_month');
  const progressRes = await query(
    `SELECT COALESCE(SUM(${type === 'revenue' ? 'revenue' : 'profit'}), 0)::NUMERIC AS current
     FROM transactions
     WHERE user_id = $1 AND date BETWEEN $2 AND $3`,
    [user.id, dates.start, dates.end]
  );

  return {
    goal_set: true,
    type,
    amount:           Math.round(parseFloat(amount) || 0),
    period,
    current_progress: parseFloat(progressRes.rows[0]?.current) || 0,
  };
}

async function logExpenseHandler({ category, amount, note, whatsappNumber }) {
  const user    = await getUser(whatsappNumber);
  const amt     = Math.round(parseFloat(amount) || 0);
  const today   = todayWAT();
  const breakdown = { [category]: amt };

  await query(
    `INSERT INTO transactions
       (user_id, date, revenue, total_expenses, expense_breakdown,
        profit, margin, customers, notes, entry_method)
     VALUES ($1, $2::DATE, 0, $3, $4, -$3, 0, 0, $5, 'kemi')`,
    [user.id, today, amt, JSON.stringify(breakdown),
     note || `${category} expense`]
  );

  // Running totals for today
  const totals = await query(
    `SELECT COALESCE(SUM(revenue), 0)::NUMERIC       AS revenue,
            COALESCE(SUM(total_expenses), 0)::NUMERIC AS expenses
     FROM transactions
     WHERE user_id = $1 AND date = $2`,
    [user.id, today]
  );

  return {
    logged:                  true,
    category,
    amount:                  amt,
    today_expenses_so_far:   parseFloat(totals.rows[0]?.expenses) || 0,
    today_revenue_so_far:    parseFloat(totals.rows[0]?.revenue)  || 0,
  };
}

async function comparePeriodsHandler({ period1, period2, whatsappNumber }) {
  const [summary1, summary2] = await Promise.all([
    getSalesSummaryHandler({ period: period1, whatsappNumber }),
    getSalesSummaryHandler({ period: period2, whatsappNumber }),
  ]);

  const revDelta     = summary1.total_revenue   - summary2.total_revenue;
  const profitDelta  = summary1.net_profit      - summary2.net_profit;
  const unitsDelta   = summary1.total_units_sold - summary2.total_units_sold;

  const revPct    = summary2.total_revenue   > 0 ? Math.round((revDelta    / summary2.total_revenue)   * 100) : null;
  const profitPct = summary2.net_profit      > 0 ? Math.round((profitDelta / summary2.net_profit)      * 100) : null;
  const unitsPct  = summary2.total_units_sold > 0 ? Math.round((unitsDelta  / summary2.total_units_sold) * 100) : null;

  return {
    period1:  summary1,
    period2:  summary2,
    deltas: {
      revenue:      { value: revDelta,    pct: revPct },
      profit:       { value: profitDelta, pct: profitPct },
      units_sold:   { value: unitsDelta,  pct: unitsPct },
    },
  };
}

module.exports = {
  logSaleHandler,
  logRestockHandler,
  logExpenseHandler,
  getStockLevelHandler,
  getStockIntelligenceHandler,
  getSalesSummaryHandler,
  searchProductsHandler,
  correctLastEntryHandler,
  logDebtHandler,
  settleDebtHandler,
  getDebtsHandler,
  setGoalHandler,
  comparePeriodsHandler,
};
