/**
 * services/productService.js
 * Task 2 — Product-level performance tracking.
 *
 * Fuzzy name matching → find or create product → apply stock changes
 * → record transaction → check low-stock and send WhatsApp alert.
 */

'use strict';

const ProductModel    = require('../models/product');
const InventoryModel  = require('../models/inventory');

// ── Nigerian product name dictionary ─────────────────────────────────────────
// Maps common variants / misspellings to a canonical display name.
const PRODUCT_DICTIONARY = {
  // Fabrics & fashion
  'ankara': 'Ankara fabric', 'ankara fabric': 'Ankara fabric',
  'lace': 'Lace fabric', 'lace fabric': 'Lace fabric',
  'aso ebi': 'Aso Ebi', 'asoebi': 'Aso Ebi',
  'george': 'George fabric', 'george fabric': 'George fabric',
  'adire': 'Adire fabric',
  'chiffon': 'Chiffon fabric',
  'cord lace': 'Cord lace', 'cordlace': 'Cord lace',

  // Fragrances
  'oud': 'Oud oil', 'oudh': 'Oud oil', 'ud oil': 'Oud oil', 'oud oil': 'Oud oil',
  'attar': 'Attar perfume',

  // Food staples
  'rice': 'Rice', 'bag of rice': 'Rice', 'bags of rice': 'Rice',
  'garri': 'Garri', 'eba': 'Garri',
  'beans': 'Beans', 'ewa': 'Beans',
  'palm oil': 'Palm oil', 'palmoil': 'Palm oil',
  'groundnut oil': 'Groundnut oil', 'vegetable oil': 'Vegetable oil',
  'flour': 'Flour', 'semovita': 'Semovita',
  'semo': 'Semovita', 'ogi': 'Ogi (pap)',
  'indomie': 'Indomie noodles', 'noodles': 'Indomie noodles',
  'maggi': 'Maggi cubes', 'knorr': 'Knorr cubes', 'seasoning cube': 'Maggi cubes',
  'tomato': 'Tomato paste', 'tomato paste': 'Tomato paste',
  'pepper': 'Pepper (dried)',
  'yam': 'Yam', 'tuber of yam': 'Yam', 'tubers of yam': 'Yam',
  'plantain': 'Plantain',
  'crayfish': 'Crayfish',

  // Beverages
  'water': 'Water (sachet)', 'sachet water': 'Water (sachet)', 'pure water': 'Water (sachet)',
  'bottled water': 'Water (bottle)',
  'malt': 'Malt drink', 'malta': 'Malt drink',
  'zobo': 'Zobo drink',

  // Cosmetics / beauty
  'hair': 'Human hair', 'human hair': 'Human hair',
  'wig': 'Wig', 'lace wig': 'Wig',
  'relaxer': 'Hair relaxer',
  'cream': 'Body cream',
  'lotion': 'Body lotion',
  'soap': 'Soap',
  'pomade': 'Hair pomade',

  // Electronics & accessories
  'charger': 'Phone charger',
  'earphone': 'Earphones', 'earphones': 'Earphones', 'headphones': 'Headphones',
  'cable': 'Data cable',
  'power bank': 'Power bank', 'powerbank': 'Power bank',

  // General retail
  'bag': 'Bag', 'bags': 'Bag',
  'shoe': 'Shoe', 'shoes': 'Shoe',
  'sandal': 'Sandal', 'sandals': 'Sandal',
  'gown': 'Gown', 'dress': 'Gown',
  'shirt': 'Shirt', 'blouse': 'Blouse',
  'trouser': 'Trouser', 'trousers': 'Trouser', 'pant': 'Trouser',
};

// ── Name normalisation ────────────────────────────────────────────────────────

function normalizeProductName(rawName) {
  if (!rawName) return 'Unknown product';
  const lower = rawName.trim().toLowerCase();

  // Direct dictionary match
  if (PRODUCT_DICTIONARY[lower]) return PRODUCT_DICTIONARY[lower];

  // Partial match — check if rawName contains a dictionary key
  for (const [key, canonical] of Object.entries(PRODUCT_DICTIONARY)) {
    if (lower.includes(key) && key.length >= 4) return canonical;
  }

  // Title-case fallback
  return rawName.trim().replace(/\b\w/g, c => c.toUpperCase());
}

function normalizeForStorage(rawName) {
  // Stored in product_name_normalized for exact DB lookups
  return rawName.trim().toLowerCase().replace(/s$/, '').replace(/\s+/g, ' ');
}

// ── Levenshtein distance (pure JS) ───────────────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── Fuzzy product lookup ──────────────────────────────────────────────────────

async function findProductFuzzy(userId, rawName) {
  const normalized = normalizeForStorage(rawName);
  const canonical  = normalizeProductName(rawName);

  // 1. Exact DB match on normalized name
  const exact = await ProductModel.findByNormalized(userId, normalized);
  if (exact) return exact;

  // 2. JS-side Levenshtein on all user products
  const all = await ProductModel.getAllForUser(userId);
  if (!all.length) return null;

  const target = normalized;
  let best = null, bestDist = Infinity;

  for (const p of all) {
    const stored = p.product_name_normalized.toLowerCase();
    // Skip very short names where distance is unreliable
    if (target.length < 4 && stored.length < 4) {
      if (stored === target) { best = p; bestDist = 0; }
      continue;
    }
    const dist = levenshtein(target, stored);
    if (dist < bestDist) { bestDist = dist; best = p; }
  }

  // Accept if distance ≤ 2 (catches plurals, one-char typos)
  if (best && bestDist <= 2) return best;

  // 3. Canonical name match (dictionary resolved to same canonical)
  for (const p of all) {
    if (normalizeProductName(p.product_name).toLowerCase() === canonical.toLowerCase()) return p;
  }

  return null;
}

// ── Find or create product ────────────────────────────────────────────────────

async function findOrCreateProduct(userId, rawName, unit = 'units') {
  const found = await findProductFuzzy(userId, rawName);
  if (found) {
    // Update unit in DB when a specific unit is now known and differs from stored
    if (unit && unit !== 'units' && found.unit !== unit) {
      const { query } = require('../models/db');
      await query('UPDATE products SET unit = $1, updated_at = NOW() WHERE id = $2', [unit, found.id]);
      found.unit = unit;
    }
    return found;
  }

  const displayName   = normalizeProductName(rawName);
  const normalizedKey = normalizeForStorage(rawName);
  const product = await ProductModel.create(userId, displayName, normalizedKey, unit);

  // Auto-migrate: if the old inventory table has stock for this item, carry it over
  try {
    const oldItem = await InventoryModel.getItemFuzzy(userId, rawName);
    const oldBalance = parseFloat(oldItem?.current_balance) || 0;
    if (oldBalance > 0) {
      const oldPrice = parseFloat(oldItem?.unit_price) || null;
      await ProductModel.setOpeningBalance(product.id, oldBalance, oldPrice);
      const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      await ProductModel.recordTransaction({
        userId,
        productId:    product.id,
        type:         'stock_in',
        quantity:     oldBalance,
        unitPrice:    oldPrice,
        totalAmount:  oldPrice ? oldBalance * oldPrice : 0,
        dailyEntryId: null,
        date,
        channel:      'retail',
      });
      console.log(`[Products] 📦 Auto-migrated ${oldBalance} ${unit} of "${displayName}" from old inventory`);
    }
  } catch (e) {
    console.warn('[Products] Old inventory migration skipped:', e.message);
  }

  return product;
}

// ── Low-stock alert ───────────────────────────────────────────────────────────

async function checkAndSendLowStockAlert(user, product, WhatsAppService) {
  if (!user.whatsapp_number) return;

  const stock    = parseFloat(product.current_stock)      || 0;
  const received = parseFloat(product.total_ever_received) || 0;
  const unit     = product.unit || 'units';
  const name     = product.product_name;
  const lastCost = product.last_purchase_price
    ? `\nLast purchase price: ₦${Number(product.last_purchase_price).toLocaleString('en-NG')}`
    : '';

  if (received === 0) return;

  const velocity = await ProductModel.getVelocity(product.id);

  let alertType = null;
  let daysRemaining = null;

  if (stock === 0) {
    alertType = 'out_of_stock';
  } else if (velocity > 0) {
    daysRemaining = stock / velocity;
    if (daysRemaining <= 2) alertType = 'low_stock';
  } else if (stock / received < 0.20) {
    alertType = 'low_stock';
  }

  if (!alertType) return;

  const alreadySent = await ProductModel.alertAlreadySentToday(user.id, product.id, alertType);
  if (alreadySent) return;

  let msg;
  if (alertType === 'out_of_stock') {
    msg =
      `⛔ *${name} is OUT OF STOCK*\n\n` +
      `You've sold everything. Reorder before customers start going elsewhere. 📦` +
      lastCost;
  } else if (daysRemaining !== null && daysRemaining <= 0.5) {
    msg =
      `🔴 *${name} is almost gone.*\n\n` +
      `Less than half a day of stock left.\n` +
      `Reorder urgently or you will lose sales.` +
      lastCost;
  } else {
    const velocityRounded = velocity > 0 ? Math.round(velocity * 10) / 10 : '?';
    const daysDisplay     = daysRemaining !== null ? (Math.round(daysRemaining * 10) / 10) : '?';
    msg =
      `⚠️ *Stock alert — ${name}*\n\n` +
      `You have ${stock} ${unit} left.\n` +
      `You sell about ${velocityRounded} per day.\n` +
      `At this rate: ${daysDisplay} day${daysDisplay === 1 ? '' : 's'} left.\n\n` +
      `Reorder before you run out. 📦` +
      lastCost;
  }

  await WhatsAppService.sendMessage(user.whatsapp_number, msg);
  await ProductModel.recordAlert(user.id, product.id, alertType);
  console.log(`[Products] 🔔 ${alertType} alert sent to ${user.name} for ${name}`);
}

// ── Process product transactions ──────────────────────────────────────────────
/**
 * Called after a daily_entry is confirmed and committed.
 * `products` is the array from parsedData.products (Gemini output).
 * Each element: { product_name, transaction_type, quantity, unit_price, total_amount, unit }
 */
async function processProductTransactions(userId, user, products, dailyEntryId, date, WhatsAppService) {
  if (!Array.isArray(products) || products.length === 0) return [];
  const stockSummary = []; // { name, stock, unit, status }

  for (const p of products) {
    try {
      const rawName = p.product_name || p.item || 'Unknown';
      const type    = p.transaction_type === 'stock_in' ? 'stock_in' : 'sale';
      const qty     = parseFloat(p.quantity)    || null;
      const price   = parseFloat(p.unit_price)  || null;
      const total   = parseFloat(p.total_amount)|| (qty && price ? qty * price : null) || 0;
      const unit    = p.unit || 'units';
      const channel = p.channel === 'wholesale' ? 'wholesale' : 'retail';

      // Resolve product (fuzzy match or create)
      const product = await findOrCreateProduct(userId, rawName, unit);

      // Check for oversell before applying delta — cap recorded qty at available stock
      let oversellWarning = null;
      let effectiveQty = qty;
      if (type === 'sale' && qty !== null) {
        const currentStock = await ProductModel.getCurrentStock(product.id);
        if (currentStock <= 0) {
          // Nothing in stock — no movement, but warn the user
          oversellWarning =
            `⚠️ *${normalizeProductName(rawName)}* shows 0 units in stock. ` +
            `Nothing deducted.\n\nSend your current stock first:\n` +
            `_"I have [number] ${normalizeProductName(rawName)}"_`;
          effectiveQty = 0;
        } else if (qty > currentStock) {
          oversellWarning =
            `⚠️ You sold ${qty} ${unit} of ${normalizeProductName(rawName)} ` +
            `but your stock showed only ${currentStock} left.\n` +
            `Did you restock without logging?\n` +
            `Stock set to 0 — send a correction if needed.`;
          effectiveQty = currentStock; // cap: only deduct what was actually available
        }
      }

      // Apply stock delta (using capped quantity for sales)
      const delta = type === 'sale'
        ? -(effectiveQty || 0)
        :  (qty || 0);

      await ProductModel.applyStockChange(product.id, {
        delta,
        purchasePrice: type === 'stock_in'  ? price : null,
        salePrice:     type === 'sale'       ? price : null,
      });

      // Record transaction row only when something actually moved
      const recordedQty   = type === 'sale' ? effectiveQty : qty;
      const recordedTotal = (recordedQty !== null && recordedQty > 0 && price)
        ? recordedQty * price
        : (recordedQty > 0 ? total : 0);

      // Skip recording a 0-unit sale — it creates phantom velocity data
      if (!(type === 'sale' && (recordedQty === null || recordedQty <= 0))) {
        await ProductModel.recordTransaction({
          userId,
          productId:    product.id,
          type,
          quantity:     recordedQty,
          unitPrice:    price,
          totalAmount:  recordedTotal,
          dailyEntryId,
          date,
          channel,
        });
      }

      // Refresh product from DB for current stock values
      const refreshed = await ProductModel.getById(product.id);

      // Send oversell warning (separate message, non-blocking)
      if (oversellWarning && WhatsAppService) {
        WhatsAppService.sendMessage(user.whatsapp_number, oversellWarning).catch(() => {});
      }

      if (refreshed && type === 'sale' && WhatsAppService) {
        await checkAndSendLowStockAlert(user, refreshed, WhatsAppService).catch(e =>
          console.error(`[Products] Alert check failed for ${rawName}:`, e.message)
        );
      }

      // Collect stock summary for the post-confirmation reply
      if (refreshed) {
        const velocity = type === 'sale' ? await ProductModel.getVelocity(refreshed.id) : 0;
        const stock    = parseFloat(refreshed.current_stock) || 0;
        let status = 'HEALTHY';
        if (stock === 0) status = 'OUT_OF_STOCK';
        else if (velocity > 0) {
          const days = stock / velocity;
          if (days < 1)  status = 'CRITICAL';
          else if (days < 3) status = 'LOW';
        }
        const emoji = { OUT_OF_STOCK: '🔴', CRITICAL: '🔴', LOW: '🟡', HEALTHY: '🟢', UNKNOWN: '⚪' }[status] || '⚪';
        stockSummary.push({ name: refreshed.product_name, stock, unit: refreshed.unit || 'units', status, emoji });
      }

      console.log(`[Products] ✅ ${type} — ${rawName} qty=${qty} total=${total}`);
    } catch (err) {
      console.error(`[Products] ❌ Failed to process product "${p.product_name}":`, err.message);
    }
  }
  return stockSummary;
}

// ── Set opening stock balances ────────────────────────────────────────────────
/**
 * Called when a user confirms their opening stock declaration.
 * SETs stock directly (not a delta) so it reflects their real-world position.
 * Also records a stock_in transaction for each product.
 */
async function setOpeningStock(userId, products) {
  if (!Array.isArray(products) || products.length === 0) return;
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  for (const p of products) {
    try {
      const rawName = p.product_name || p.item || 'Unknown';
      const qty     = parseFloat(p.quantity) || 0;
      const price   = parseFloat(p.unit_price) || null;
      const unit    = p.unit || 'units';

      const product = await findOrCreateProduct(userId, rawName, unit);
      await ProductModel.setOpeningBalance(product.id, qty, price);

      await ProductModel.recordTransaction({
        userId,
        productId:   product.id,
        type:        'stock_in',
        quantity:    qty,
        unitPrice:   price,
        totalAmount: qty && price ? qty * price : 0,
        dailyEntryId: null,
        date,
      });

      console.log(`[Products] ✅ Opening stock set — ${rawName} qty=${qty}`);
    } catch (err) {
      console.error(`[Products] ❌ Failed to set opening stock for "${p.product_name}":`, err.message);
    }
  }
}

/**
 * Zero out a product's stock — records the remaining quantity as a sale transaction
 * so the movement log reflects what happened.
 * Returns the quantity that was zeroed out (0 if already empty).
 */
async function zeroProductStock(userId, productId, date) {
  const currentStock = await ProductModel.getCurrentStock(productId);
  if (currentStock <= 0) return 0;
  await ProductModel.applyStockChange(productId, { delta: -currentStock });
  await ProductModel.recordTransaction({
    userId,
    productId,
    type:         'sale',
    quantity:     currentStock,
    unitPrice:    null,
    totalAmount:  0,
    dailyEntryId: null,
    date,
    channel:      'retail',
  });
  return currentStock;
}

module.exports = {
  normalizeProductName,
  normalizeForStorage,
  findProductFuzzy,
  findOrCreateProduct,
  processProductTransactions,
  checkAndSendLowStockAlert,
  setOpeningStock,
  zeroProductStock,
};
