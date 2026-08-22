/**
 * routes/resellerAdmin.js
 * Seller dashboard for the Reseller Ordering Agent (separate product — see
 * src/reseller-agent/). Mounted at /reseller in server.js.
 *
 * Auth: WhatsApp OTP login (no password to remember — meets a low-tech seller
 * where she already is), session cookie mirrors middleware/auth.js's pattern
 * but scoped to a seller (reseller_seller_sessions) rather than a BizPulse user.
 *
 * Order-lifecycle actions (confirm/decline/mark paid/mark delivered) live here,
 * not on WhatsApp — see src/reseller-agent/sellerTools.js for why that split
 * matches the source prompt's Section 2 scope. V1 only supports whole-order
 * actions, not per-line edits — a pending_verification order was already held
 * because SOME line needed supplier confirmation (Section 4's design), so
 * "Confirm" here means "I checked, it's all available."
 */

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const { query } = require('../models/db');
const SellerModel = require('../models/seller');
const ResellerCatalogModel = require('../models/resellerCatalog');
const ResellerOrderModel = require('../models/resellerOrder');
const WhatsAppService = require('../services/whatsapp');

const SESSION_COOKIE = 'bizpulse_reseller_session';
const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/reseller',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  secure: process.env.NODE_ENV === 'production',
};
const OTP_TTL_MINUTES = 10;

function fmt(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG');
}

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────

async function requireSellerAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    const wantsJson = req.headers.accept?.includes('application/json');
    if (wantsJson) return res.status(401).json({ error: 'Session expired.', requireLogin: true });
    return res.redirect('/reseller/login');
  }
  try {
    const result = await query(
      `SELECT seller_id FROM reseller_seller_sessions WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );
    if (!result.rows.length) {
      res.clearCookie(SESSION_COOKIE, { path: '/reseller' });
      return res.redirect('/reseller/login');
    }
    req.sellerId = result.rows[0].seller_id;
    next();
  } catch (err) {
    console.error('[ResellerAdmin] Session validation failed:', err.message);
    res.status(500).send('Something went wrong. Please try again.');
  }
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Seller Login</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:sans-serif;background:#F0F4FA;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .box{background:#fff;border-radius:12px;padding:2rem;box-shadow:0 4px 16px rgba(0,0,0,.1);width:100%;max-width:360px}
    h2{color:#0F2744;margin-bottom:.25rem;font-size:1.25rem;text-align:center}
    p{color:#718096;text-align:center;margin-bottom:1.5rem;font-size:.9rem}
    input{width:100%;padding:10px 14px;border:1px solid #E2E8F0;border-radius:8px;font-size:1rem;margin-bottom:1rem}
    button{width:100%;padding:10px;background:#1A56A4;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
    .msg{text-align:center;font-size:.85rem;margin-top:.75rem;min-height:1.2em}
    .msg.error{color:#C53030}
    .msg.ok{color:#1A7A4A}
    .logo{font-size:2rem;text-align:center;margin-bottom:.5rem}
    [hidden]{display:none}
  </style>
</head>
<body>
  <div class="box">
    <div class="logo">🛍️</div>
    <h2>Seller Dashboard</h2>
    <p>Log in with your WhatsApp number — no password needed.</p>

    <form id="phoneForm">
      <input type="tel" id="phone" placeholder="WhatsApp number (e.g. 08012345678)" autofocus required>
      <button type="submit">Send me a code</button>
    </form>

    <form id="otpForm" hidden>
      <input type="text" id="otp" placeholder="6-digit code" inputmode="numeric" maxlength="6" required>
      <button type="submit">Log in</button>
    </form>

    <div class="msg" id="msg"></div>
  </div>
  <script>
    const msg = document.getElementById('msg');
    const phoneForm = document.getElementById('phoneForm');
    const otpForm = document.getElementById('otpForm');
    let phoneValue = '';

    phoneForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      phoneValue = document.getElementById('phone').value.trim();
      msg.textContent = 'Sending code...'; msg.className = 'msg';
      try {
        const res = await fetch('/reseller/login/request-otp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ whatsapp_number: phoneValue }),
        });
        const data = await res.json();
        if (!res.ok) { msg.textContent = data.error || 'Something went wrong.'; msg.className = 'msg error'; return; }
        phoneForm.hidden = true; otpForm.hidden = false;
        msg.textContent = 'Code sent on WhatsApp — check your messages.'; msg.className = 'msg ok';
      } catch { msg.textContent = 'Network error — try again.'; msg.className = 'msg error'; }
    });

    otpForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const otp = document.getElementById('otp').value.trim();
      msg.textContent = 'Checking...'; msg.className = 'msg';
      try {
        const res = await fetch('/reseller/login/verify-otp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ whatsapp_number: phoneValue, otp }),
        });
        const data = await res.json();
        if (!res.ok) { msg.textContent = data.error || 'Wrong code.'; msg.className = 'msg error'; return; }
        window.location.href = '/reseller';
      } catch { msg.textContent = 'Network error — try again.'; msg.className = 'msg error'; }
    });
  </script>
</body>
</html>`;

router.get('/login', (_req, res) => res.send(LOGIN_PAGE));

router.post('/login/request-otp', async (req, res) => {
  const seller = await SellerModel.findByWhatsapp(req.body?.whatsapp_number || '');
  if (!seller) return res.status(404).json({ error: 'No seller account found for that number.' });

  const otp = generateOtp();
  await query(
    `UPDATE reseller_sellers SET otp_code = $2, otp_expires_at = NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes' WHERE id = $1`,
    [seller.id, otp]
  );
  try {
    await WhatsAppService.sendMessage(seller.whatsapp_number, `Your BizPulse dashboard login code is: ${otp}\n\nExpires in ${OTP_TTL_MINUTES} minutes.`);
  } catch (err) {
    console.error('[ResellerAdmin] Failed to send OTP:', err.message);
    return res.status(502).json({ error: 'Could not send the code — please try again shortly.' });
  }
  res.json({ success: true });
});

router.post('/login/verify-otp', async (req, res) => {
  const { whatsapp_number, otp } = req.body || {};
  const seller = await SellerModel.findByWhatsapp(whatsapp_number || '');
  if (!seller) return res.status(404).json({ error: 'No seller account found for that number.' });

  const check = await query(
    `SELECT otp_code, otp_expires_at FROM reseller_sellers WHERE id = $1`,
    [seller.id]
  );
  const row = check.rows[0];
  if (!row?.otp_code || row.otp_code !== String(otp || '').trim() || new Date(row.otp_expires_at) < new Date()) {
    return res.status(401).json({ error: 'That code is wrong or has expired.' });
  }

  await query(`UPDATE reseller_sellers SET otp_code = NULL, otp_expires_at = NULL WHERE id = $1`, [seller.id]);

  const token = generateSessionToken();
  await query(
    `INSERT INTO reseller_seller_sessions (token, seller_id) VALUES ($1, $2)`,
    [token, seller.id]
  );
  res.cookie(SESSION_COOKIE, token, SESSION_COOKIE_OPTS);
  res.json({ success: true });
});

router.get('/logout', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await query(`DELETE FROM reseller_seller_sessions WHERE token = $1`, [token]).catch(() => {});
  res.clearCookie(SESSION_COOKIE, { path: '/reseller' });
  res.redirect('/reseller/login');
});

// ─────────────────────────────────────────────
// GET /reseller — dashboard
// ─────────────────────────────────────────────
router.get('/', requireSellerAuth, async (req, res) => {
  const seller = await SellerModel.findById(req.sellerId);
  const orders = await ResellerOrderModel.listForSeller(req.sellerId, 100);
  const catalog = await ResellerCatalogModel.getActiveBySeller(req.sellerId);

  const ordersWithItems = [];
  for (const o of orders) {
    const items = await ResellerOrderModel.getItemsForOrder(o.id);
    ordersWithItems.push({ ...o, items });
  }

  const needsAttention = ordersWithItems.filter(o =>
    ['pending_verification', 'awaiting_payment', 'payment_received'].includes(o.status));
  const history = ordersWithItems.filter(o =>
    !['pending_verification', 'awaiting_payment', 'payment_received'].includes(o.status));

  const statusLabel = {
    pending_verification: '⏳ Needs your verification',
    awaiting_payment: '💳 Awaiting payment',
    payment_received: '📩 Payment sent — confirm it',
    confirmed: '✅ Confirmed',
    declined: '❌ Declined',
    paid: '✅ Paid',
    delivered: '📦 Delivered',
    cancelled: '🚫 Cancelled',
  };

  const orderCard = (o, showActions) => {
    const itemsHtml = o.items.map(i =>
      `<div class="line">${i.quantity} × ${i.item_name_snapshot}${i.variant ? ' (' + i.variant + ')' : ''} — ${fmt(i.line_total)}</div>`
    ).join('');
    const total = o.items.reduce((s, i) => s + parseFloat(i.line_total || 0), 0);

    let actions = '';
    if (showActions) {
      if (o.status === 'pending_verification') {
        actions = `<button onclick="act(${o.id},'confirm')">Confirm — it's available</button>
                   <button class="danger" onclick="act(${o.id},'decline')">Decline</button>`;
      } else if (o.status === 'awaiting_payment' || o.status === 'payment_received') {
        actions = `<button onclick="act(${o.id},'mark-paid')">Mark paid</button>
                   <button class="danger" onclick="act(${o.id},'decline')">Decline</button>`;
      }
    } else if (o.status === 'paid') {
      actions = `<button onclick="act(${o.id},'mark-delivered')">Mark delivered</button>`;
    }

    return `<div class="card">
      <div class="card-head"><strong>#${o.id} — ${o.customer_name || 'Customer'}</strong><span class="status">${statusLabel[o.status] || o.status}</span></div>
      <div class="phone">${o.customer_phone}</div>
      ${itemsHtml}
      <div class="total">Total: ${fmt(total)}</div>
      <div class="actions">${actions}</div>
    </div>`;
  };

  const catalogRows = catalog.map(i => `<tr>
    <td>Item ${i.item_number}</td>
    <td>${i.name}${i.variant_info ? '<br><span class="muted">' + i.variant_info + '</span>' : ''}</td>
    <td>${fmt(i.price_naira)}</td>
    <td>${i.source_type === 'seller_owned' ? (parseFloat(i.current_stock) || 0) : '<span class="muted">supplier item</span>'}</td>
  </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${seller?.business_name || 'Seller'} — Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:sans-serif;background:#F0F4FA;color:#0F2744}
    header{background:#0F2744;color:#fff;padding:1rem 1.25rem;display:flex;justify-content:space-between;align-items:center}
    header a{color:#fff;font-size:.85rem;text-decoration:underline}
    main{max-width:720px;margin:0 auto;padding:1rem}
    h2{font-size:1.1rem;margin:1.25rem 0 .5rem}
    .card{background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:.85rem 1rem;margin-bottom:.75rem}
    .card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:.25rem}
    .status{font-size:.8rem;color:#B7791F}
    .phone{font-size:.8rem;color:#718096;margin-bottom:.5rem}
    .line{font-size:.9rem}
    .total{font-weight:bold;margin-top:.4rem}
    .actions{margin-top:.6rem;display:flex;gap:.5rem;flex-wrap:wrap}
    button{padding:8px 12px;border:none;border-radius:8px;background:#1A56A4;color:#fff;font-size:.85rem;cursor:pointer}
    button.danger{background:#C53030}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden}
    th,td{padding:.6rem .75rem;text-align:left;border-bottom:1px solid #E2E8F0;font-size:.9rem}
    .muted{color:#718096;font-size:.8rem}
    .empty{color:#718096;font-size:.9rem;padding:.5rem 0}
  </style>
</head>
<body>
  <header>
    <strong>${seller?.business_name || 'Seller'}</strong>
    <a href="/reseller/logout">Log out</a>
  </header>
  <main>
    <h2>Needs your attention (${needsAttention.length})</h2>
    ${needsAttention.length ? needsAttention.map(o => orderCard(o, true)).join('') : '<div class="empty">Nothing pending right now.</div>'}

    <h2>Inventory</h2>
    <table><tr><th>Item</th><th>Name</th><th>Price</th><th>Stock</th></tr>${catalogRows || '<tr><td colspan="4" class="empty">No catalog items yet — add one from WhatsApp.</td></tr>'}</table>

    <h2>Order history</h2>
    ${history.length ? history.map(o => orderCard(o, false)).join('') : '<div class="empty">No past orders yet.</div>'}
  </main>
  <script>
    async function act(orderId, action) {
      const res = await fetch('/reseller/api/orders/' + orderId + '/' + action, { method: 'POST' });
      if (res.ok) { location.reload(); } else { alert('Something went wrong — try again.'); }
    }
  </script>
</body>
</html>`);
});

// ─────────────────────────────────────────────
// Order lifecycle actions
// ─────────────────────────────────────────────

async function ownedOrder(sellerId, orderId) {
  const order = await ResellerOrderModel.getById(orderId);
  if (!order || order.seller_id !== sellerId) return null;
  return order;
}

router.post('/api/orders/:id/confirm', requireSellerAuth, async (req, res) => {
  const order = await ownedOrder(req.sellerId, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const updated = await ResellerOrderModel.updateStatus(order.id, 'awaiting_payment');
  await WhatsAppService.sendMessage(order.customer_phone,
    `Good news — your order #${order.id} is confirmed! Please make payment and send proof when done. 🙏`
  ).catch(() => {});
  res.json({ success: true, order: updated });
});

router.post('/api/orders/:id/decline', requireSellerAuth, async (req, res) => {
  const order = await ownedOrder(req.sellerId, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const updated = await ResellerOrderModel.updateStatus(order.id, 'declined');
  await WhatsAppService.sendMessage(order.customer_phone,
    `Sorry, order #${order.id} couldn't be fulfilled this time. 🙏`
  ).catch(() => {});
  res.json({ success: true, order: updated });
});

router.post('/api/orders/:id/mark-paid', requireSellerAuth, async (req, res) => {
  const order = await ownedOrder(req.sellerId, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const updated = await ResellerOrderModel.updateStatus(order.id, 'paid');
  await WhatsAppService.sendMessage(order.customer_phone,
    `Payment confirmed for order #${order.id} — thank you! We'll be in touch about delivery. 🎉`
  ).catch(() => {});
  res.json({ success: true, order: updated });
});

router.post('/api/orders/:id/mark-delivered', requireSellerAuth, async (req, res) => {
  const order = await ownedOrder(req.sellerId, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const updated = await ResellerOrderModel.updateStatus(order.id, 'delivered');
  res.json({ success: true, order: updated });
});

module.exports = router;
