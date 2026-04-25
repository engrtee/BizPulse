/**
 * routes/admin.js
 * Password-protected admin dashboard — full rebuild.
 *
 * GET  /admin           → Full HTML dashboard (tabs: Overview | Users | Messages | At-Risk | Health)
 * GET  /admin/stats     → JSON stats
 * POST /admin/nudge     → Send a WhatsApp nudge to a specific user
 * POST /admin/message   → Send a custom WhatsApp message to any user
 */

'use strict';

const express        = require('express');
const router         = express.Router();
const UserModel      = require('../models/user');
const TransactionModel = require('../models/transaction');
const { MessageModel, query } = require('../models/db');
const LearningService  = require('../services/learningService');

function adminAuth(req, res, next) {
  const provided = req.query.password || req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).send('Admin dashboard not configured. Set ADMIN_PASSWORD env var.');
  }
  if (provided !== process.env.ADMIN_PASSWORD) {
    return res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BizPulse Admin</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:sans-serif;background:#F0F4FA;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .box{background:#fff;border-radius:12px;padding:2rem;box-shadow:0 4px 16px rgba(0,0,0,.1);width:100%;max-width:360px;text-align:center}
    h2{color:#0F2744;margin-bottom:1.5rem;font-size:1.25rem}
    input{width:100%;padding:10px 14px;border:1px solid #E2E8F0;border-radius:8px;font-size:1rem;margin-bottom:1rem}
    button{width:100%;padding:10px;background:#1A56A4;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
    .logo{font-size:2rem;margin-bottom:.5rem}
  </style>
</head>
<body>
  <div class="box">
    <div class="logo">📊</div>
    <h2>BizPulse Admin</h2>
    <form method="GET" action="/admin">
      <input type="password" name="password" placeholder="Admin password" autofocus>
      <button type="submit">Access Dashboard</button>
    </form>
  </div>
</body>
</html>`);
  }
  next();
}

// ─────────────────────────────────────────────
// GET /admin — Full HTML dashboard
// ─────────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  try {
    const pw = req.query.password || '';

    const [stats, recentRegs, allUsers, recentMessages, atRisk, variantStats, retentionByBiz, confirmMetrics, productStats, openingStockStats, mediaStats, calcStats] = await Promise.all([
      UserModel.getAdminStats(),
      UserModel.getRecentRegistrations(7),
      UserModel.findAllWithStats(),
      MessageModel.getRecent(50),
      UserModel.findAtRisk(),
      // Nudge format conversion rates
      query(`
        SELECT
          message_type,
          variant_name,
          COUNT(*)                                          AS times_sent,
          COUNT(CASE WHEN user_logged_next_day THEN 1 END) AS times_converted,
          ROUND(
            COUNT(CASE WHEN user_logged_next_day THEN 1 END)::NUMERIC
            / NULLIF(COUNT(*), 0) * 100, 1
          )                                                 AS conversion_rate,
          ROUND(AVG(days_to_next_log) FILTER (WHERE days_to_next_log IS NOT NULL), 1) AS avg_days_to_log
        FROM message_log
        GROUP BY message_type, variant_name
        ORDER BY message_type, conversion_rate DESC NULLS LAST
      `),
      // Retention by business type
      query(`
        SELECT
          COALESCE(u.biz_type, 'Unknown') AS biz_type,
          COUNT(DISTINCT u.id)             AS total_users,
          COUNT(DISTINCT CASE WHEN u.last_message_date >= CURRENT_DATE - INTERVAL '7 days' THEN u.id END) AS active_7d,
          ROUND(
            COUNT(DISTINCT CASE WHEN u.last_message_date >= CURRENT_DATE - INTERVAL '7 days' THEN u.id END)::NUMERIC
            / NULLIF(COUNT(DISTINCT u.id), 0) * 100, 0
          )                                AS retention_rate
        FROM users u
        WHERE u.first_message_date IS NOT NULL
        GROUP BY u.biz_type
        ORDER BY total_users DESC, retention_rate DESC
        LIMIT 20
      `),
      // Confirmation metrics (Task 1)
      query(`
        SELECT
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
        WHERE created_at > NOW() - INTERVAL '7 days'
      `).catch(() => ({ rows: [{}] })),
      // Product tracking summary (Task 2)
      query(`
        SELECT
          COUNT(DISTINCT p.id)                                                                   AS total_products,
          COUNT(DISTINCT p.user_id)                                                              AS users_with_products,
          COUNT(DISTINCT pt.id) FILTER (WHERE pt.transaction_date >= CURRENT_DATE - INTERVAL '7 days') AS transactions_7d,
          COUNT(DISTINCT p.id) FILTER (WHERE p.current_stock = 0)                               AS out_of_stock,
          COUNT(DISTINCT p.id) FILTER (WHERE p.current_stock > 0 AND p.total_ever_received > 0
            AND p.current_stock::numeric / NULLIF(p.total_ever_received,0) < 0.20)              AS low_stock
        FROM products p
        LEFT JOIN product_transactions pt ON pt.product_id = p.id
        WHERE p.is_active = true
      `).catch(() => ({ rows: [{}] })),
      // Stock intelligence adoption (opening stock setup)
      UserModel.getOpeningStockStats().catch(() => ({})),
      // Media/photo intelligence (image + voice submissions)
      query(`
        SELECT
          COUNT(*) FILTER (WHERE media_type = 'image')                                          AS photo_total,
          COUNT(*) FILTER (WHERE media_type = 'image' AND parse_success = true)                 AS photo_parsed,
          COUNT(*) FILTER (WHERE media_type = 'audio')                                          AS voice_total,
          COUNT(*) FILTER (WHERE media_type = 'audio' AND parse_success = true)                 AS voice_parsed,
          COUNT(DISTINCT user_id)                                                                AS unique_users,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')                AS last_7d
        FROM media_log
      `).catch(() => ({ rows: [{}] })),
      // Buying calculator usage (calc_context pending entries)
      query(`
        SELECT
          COUNT(*)                                                                               AS total_calcs,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')                AS calcs_7d,
          COUNT(DISTINCT user_id)                                                                AS unique_users,
          COUNT(*) FILTER (WHERE status = 'confirmed')                                          AS confirmed
        FROM pending_entries
        WHERE entry_type = 'calc_context'
      `).catch(() => ({ rows: [{}] })),
    ]);

    const totalUsers     = parseInt(stats.total_users,      10) || 0;
    const activated      = parseInt(stats.activated,         10) || 0;
    const activeThisWeek = parseInt(stats.active_this_week,  10) || 0;
    const atRiskCount    = parseInt(stats.at_risk,           10) || 0;
    const churned        = parseInt(stats.churned,           10) || 0;
    const avgMessages    = parseFloat(stats.avg_messages_per_user) || 0;
    const activationRate = totalUsers > 0 ? Math.round((activated / totalUsers) * 100) : 0;

    // ── Active today ──
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    const activeToday = allUsers.filter(u => {
      if (!u.last_message_date) return false;
      const d = new Date(u.last_message_date).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      return d === todayStr;
    }).length;

    // ── User table rows ──
    const userRows = allUsers.map(u => {
      const lastSeen = u.last_message_date
        ? new Date(u.last_message_date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
        : '—';
      const daysSince = u.last_message_date
        ? Math.floor((Date.now() - new Date(u.last_message_date)) / 86400000)
        : null;
      let statusBadge = '<span style="background:#E2E8F0;color:#718096;padding:2px 8px;border-radius:12px;font-size:0.7rem">Not started</span>';
      if (u.first_message_date && daysSince !== null) {
        if (daysSince === 0)       statusBadge = '<span style="background:#C6F6D5;color:#1A7A4A;padding:2px 8px;border-radius:12px;font-size:0.7rem">Active today</span>';
        else if (daysSince <= 7)   statusBadge = '<span style="background:#BEE3F8;color:#1A56A4;padding:2px 8px;border-radius:12px;font-size:0.7rem">Active</span>';
        else if (daysSince <= 14)  statusBadge = '<span style="background:#FEFCBF;color:#B7791F;padding:2px 8px;border-radius:12px;font-size:0.7rem">At risk</span>';
        else                       statusBadge = '<span style="background:#FED7D7;color:#C53030;padding:2px 8px;border-radius:12px;font-size:0.7rem">Churned</span>';
      }
      const streak    = parseInt(u.streak, 10) || 0;
      const entries   = parseInt(u.total_entries, 10) || 0;
      const regDate   = new Date(u.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
      const phone     = u.whatsapp_number || '—';
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0">
            <div style="font-weight:600;color:#1A56A4;cursor:pointer;text-decoration:underline" onclick="openUserDetail(${u.id})">${escHtml(u.name)}</div>
            <div style="font-size:0.75rem;color:#718096">${escHtml(u.email)}</div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">${escHtml(u.biz_type || '—')}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">${escHtml(phone)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0">${statusBadge}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;text-align:center;font-size:0.8rem">${streak > 0 ? '🔥 ' + streak : '—'}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;text-align:center;font-size:0.8rem">${entries}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">${regDate}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">${lastSeen}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0">
            <button onclick="sendNudge(${u.id},'${escHtml(u.name.split(' ')[0])}')"
              style="font-size:0.72rem;padding:4px 10px;background:#1A56A4;color:#fff;border:none;border-radius:6px;cursor:pointer;margin-right:4px">
              Nudge
            </button>
          </td>
        </tr>`;
    }).join('');

    // ── Message log rows (inbound + outbound) ──
    const intentColor = { daily_entry: '#BEE3F8', inventory_in: '#C6F6D5', inventory_out: '#FED7D7',
      help: '#E2E8F0', summary: '#BEE3F8', stock_check: '#FEFCBF', onboarding: '#C6F6D5',
      unregistered: '#FED7D7', unknown: '#FED7D7', greeting: '#E2E8F0', question: '#E2E8F0' };
    const msgRows = recentMessages.map(m => {
      const ts = new Date(m.created_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const isOutbound = m.direction === 'outbound';
      const rowBg = isOutbound ? '#EBF8FF' : '#FFFFFF';
      const dirIcon = isOutbound ? '📤' : '📥';
      const sender = isOutbound ? '<span style="color:#1A56A4;font-weight:600">BizPulse</span>' : escHtml(m.user_name || m.phone_number);
      const intent = isOutbound ? 'reply' : (m.intent || 'unknown');
      const intentBg = isOutbound ? '#BEE3F8' : (intentColor[m.intent] || '#E2E8F0');
      const statusDot = isOutbound ? '📤' : (m.status === 'processed' ? '✅' : m.status === 'parse_error' ? '⚠️' : m.status === 'unhandled' ? '❓' : '•');
      return `
        <tr style="background:${rowBg}">
          <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:0.75rem;color:#718096;white-space:nowrap">${ts}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;text-align:center;font-size:1rem">${dirIcon}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">${sender}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:0.8rem;word-break:break-word;max-width:280px">${escHtml(m.message_text || '—')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0">
            <span style="background:${intentBg};padding:2px 8px;border-radius:12px;font-size:0.7rem">${intent}</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;text-align:center;font-size:0.8rem">${statusDot}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" style="padding:16px;text-align:center;color:#718096">No messages yet</td></tr>';

    // ── At-risk user rows ──
    const atRiskRows = atRisk.map(u => {
      const daysSince = u.last_message_date
        ? Math.floor((Date.now() - new Date(u.last_message_date)) / 86400000)
        : '?';
      const phone = u.whatsapp_number || '—';
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-weight:600">${escHtml(u.name)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">${escHtml(u.biz_type || '—')}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">${escHtml(phone)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;text-align:center">
            <span style="background:#FEFCBF;color:#B7791F;padding:2px 8px;border-radius:12px;font-size:0.8rem">${daysSince} days ago</span>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0">
            <button onclick="sendNudge(${u.id},'${escHtml(u.name.split(' ')[0])}')"
              style="font-size:0.75rem;padding:5px 12px;background:#B7791F;color:#fff;border:none;border-radius:6px;cursor:pointer">
              Send Nudge
            </button>
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#718096">No at-risk users — great retention! 🎉</td></tr>';

    // ── Confirmation metrics ──
    const cm = confirmMetrics.rows[0] || {};
    const corrRate = parseFloat(cm.correction_rate) || 0;
    const corrColor = corrRate > 20 ? '#C53030' : corrRate > 10 ? '#B7791F' : '#1A7A4A';
    const corrBg    = corrRate > 20 ? '#FED7D7' : corrRate > 10 ? '#FEFCBF' : '#C6F6D5';
    const corrBanner = corrRate > 20
      ? `<div style="background:#FED7D7;border:1px solid #FC8181;border-radius:8px;padding:10px 14px;margin-bottom:1rem;color:#C53030;font-weight:600">⚠️ Correction rate above 20% — Gemini is misreading entries. Review recent EDIT responses.</div>`
      : '';
    const confirmStatsHtml = `
      ${corrBanner}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin-bottom:1rem">
        <div style="background:#F0F4FA;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#0F2744">${cm.total_parsed || 0}</div>
          <div style="font-size:0.72rem;color:#718096">Parsed</div>
        </div>
        <div style="background:#C6F6D5;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#1A7A4A">${cm.confirmed || 0}</div>
          <div style="font-size:0.72rem;color:#1A7A4A">Confirmed</div>
        </div>
        <div style="background:#FEFCBF;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#B7791F">${cm.edited || 0}</div>
          <div style="font-size:0.72rem;color:#B7791F">Edited</div>
        </div>
        <div style="background:#FED7D7;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#C53030">${cm.expired || 0}</div>
          <div style="font-size:0.72rem;color:#C53030">Expired</div>
        </div>
        <div style="background:#E2E8F0;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#718096">${cm.discarded || 0}</div>
          <div style="font-size:0.72rem;color:#718096">Discarded</div>
        </div>
        <div style="background:${corrBg};border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:${corrColor}">${cm.correction_rate || 0}%</div>
          <div style="font-size:0.72rem;color:${corrColor}">Correction Rate</div>
        </div>
      </div>`;

    // ── Product tracking stats ──
    const ps = productStats.rows[0] || {};
    const productStatsHtml = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:1rem">
        <div style="background:#F0F4FA;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#0F2744">${ps.total_products || 0}</div>
          <div style="font-size:0.72rem;color:#718096">Total Products</div>
        </div>
        <div style="background:#BEE3F8;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#1A56A4">${ps.users_with_products || 0}</div>
          <div style="font-size:0.72rem;color:#1A56A4">Users Tracking</div>
        </div>
        <div style="background:#C6F6D5;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#1A7A4A">${ps.transactions_7d || 0}</div>
          <div style="font-size:0.72rem;color:#1A7A4A">Transactions (7d)</div>
        </div>
        <div style="background:#FED7D7;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#C53030">${ps.out_of_stock || 0}</div>
          <div style="font-size:0.72rem;color:#C53030">Out of Stock</div>
        </div>
        <div style="background:#FEFCBF;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#B7791F">${ps.low_stock || 0}</div>
          <div style="font-size:0.72rem;color:#B7791F">Low Stock</div>
        </div>
      </div>`;

    // ── Opening stock adoption ──
    const os = openingStockStats || {};
    const osActivated  = parseInt(os.activated,      10) || 0;
    const osLogged     = parseInt(os.stock_logged,   10) || 0;
    const osRate       = osActivated > 0 ? Math.round((osLogged / osActivated) * 100) : 0;
    const osAvgMin     = parseFloat(os.avg_minutes_to_log) || 0;
    const osRateClr    = osRate >= 60 ? '#1A7A4A' : osRate >= 30 ? '#B7791F' : '#C53030';
    const openingStockHtml = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:1rem">
        <div style="background:#F0F4FA;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#0F2744">${osActivated}</div>
          <div style="font-size:0.72rem;color:#718096">Activated Users</div>
        </div>
        <div style="background:#C6F6D5;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#1A7A4A">${osLogged}</div>
          <div style="font-size:0.72rem;color:#1A7A4A">Stock Setup Done</div>
        </div>
        <div style="background:#BEE3F8;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:${osRateClr}">${osRate}%</div>
          <div style="font-size:0.72rem;color:#718096">Adoption Rate</div>
        </div>
        <div style="background:#FEFCBF;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#B7791F">${osAvgMin > 0 ? osAvgMin + 'm' : '—'}</div>
          <div style="font-size:0.72rem;color:#B7791F">Avg Time to Setup</div>
        </div>
      </div>`;

    // ── Media/photo + voice stats ──
    const ms = (mediaStats.rows || [{}])[0] || {};
    const photoTotal  = parseInt(ms.photo_total,  10) || 0;
    const photoParsed = parseInt(ms.photo_parsed, 10) || 0;
    const voiceTotal  = parseInt(ms.voice_total,  10) || 0;
    const voiceParsed = parseInt(ms.voice_parsed, 10) || 0;
    const mediaUsers  = parseInt(ms.unique_users, 10) || 0;
    const mediaLast7d = parseInt(ms.last_7d,      10) || 0;
    const photoRate   = photoTotal > 0 ? Math.round((photoParsed / photoTotal) * 100) : 0;
    const voiceRate   = voiceTotal > 0 ? Math.round((voiceParsed / voiceTotal) * 100) : 0;
    const mediaStatsHtml = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:1rem">
        <div style="background:#F0F4FA;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#0F2744">${photoTotal}</div>
          <div style="font-size:0.72rem;color:#718096">Photos Submitted</div>
        </div>
        <div style="background:#C6F6D5;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#1A7A4A">${photoRate}%</div>
          <div style="font-size:0.72rem;color:#1A7A4A">Photo Parse Rate</div>
        </div>
        <div style="background:#F0F4FA;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#0F2744">${voiceTotal}</div>
          <div style="font-size:0.72rem;color:#718096">Voice Submitted</div>
        </div>
        <div style="background:#C6F6D5;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#1A7A4A">${voiceRate}%</div>
          <div style="font-size:0.72rem;color:#1A7A4A">Voice Parse Rate</div>
        </div>
        <div style="background:#BEE3F8;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#1A56A4">${mediaUsers}</div>
          <div style="font-size:0.72rem;color:#1A56A4">Unique Users</div>
        </div>
        <div style="background:#FEFCBF;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#B7791F">${mediaLast7d}</div>
          <div style="font-size:0.72rem;color:#B7791F">Last 7 Days</div>
        </div>
      </div>`;

    // ── Buying calculator stats ──
    const cs = (calcStats.rows || [{}])[0] || {};
    const calcTotal   = parseInt(cs.total_calcs,  10) || 0;
    const calcLast7d  = parseInt(cs.calcs_7d,     10) || 0;
    const calcUsers   = parseInt(cs.unique_users, 10) || 0;
    const calcConfirm = parseInt(cs.confirmed,    10) || 0;
    const calcConfirmRate = calcTotal > 0 ? Math.round((calcConfirm / calcTotal) * 100) : 0;
    const calcStatsHtml = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:1rem">
        <div style="background:#F0F4FA;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#0F2744">${calcTotal}</div>
          <div style="font-size:0.72rem;color:#718096">Total Calculations</div>
        </div>
        <div style="background:#BEE3F8;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#1A56A4">${calcUsers}</div>
          <div style="font-size:0.72rem;color:#1A56A4">Unique Users</div>
        </div>
        <div style="background:#FEFCBF;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#B7791F">${calcLast7d}</div>
          <div style="font-size:0.72rem;color:#B7791F">Last 7 Days</div>
        </div>
        <div style="background:#C6F6D5;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#1A7A4A">${calcConfirmRate}%</div>
          <div style="font-size:0.72rem;color:#1A7A4A">Confirmed Rate</div>
        </div>
      </div>`;

    // ── Variant conversion rows ──
    const variantRows = (variantStats.rows || []).map(v => {
      const rate    = v.conversion_rate !== null ? `${v.conversion_rate}%` : '—';
      const rateBg  = v.conversion_rate >= 40 ? '#C6F6D5' : v.conversion_rate >= 20 ? '#FEFCBF' : '#FED7D7';
      const rateClr = v.conversion_rate >= 40 ? '#1A7A4A' : v.conversion_rate >= 20 ? '#B7791F' : '#C53030';
      const formatLabel = { A: '🔴 Loss Aversion', B: '🟢 Identity', C: '🔵 Milestone', D: '🟡 Peer', fallback: '⚪ Fallback' };
      return `
        <tr>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0;font-size:0.82rem;white-space:nowrap">${escHtml(v.message_type)}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0;font-size:0.82rem">${formatLabel[v.variant_name] || escHtml(v.variant_name)}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0;text-align:center;font-size:0.82rem">${v.times_sent}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0;text-align:center;font-size:0.82rem">${v.times_converted}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0;text-align:center">
            <span style="background:${rateBg};color:${rateClr};padding:3px 10px;border-radius:12px;font-size:0.8rem;font-weight:600">${rate}</span>
          </td>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0;text-align:center;font-size:0.82rem;color:#718096">${v.avg_days_to_log !== null ? v.avg_days_to_log + 'd' : '—'}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" style="padding:16px;text-align:center;color:#718096">No nudges sent yet — data will appear after the first retention job runs.</td></tr>';

    // ── Retention by biz type rows ──
    const bizRetentionRows = (retentionByBiz.rows || []).map(r => {
      const rate    = r.retention_rate !== null ? parseInt(r.retention_rate) : 0;
      const barW    = Math.min(rate, 100);
      const barClr  = rate >= 60 ? '#1A7A4A' : rate >= 30 ? '#B7791F' : '#C53030';
      return `
        <tr>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0;font-size:0.82rem">${escHtml(r.biz_type)}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0;text-align:center;font-size:0.82rem">${r.total_users}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0;text-align:center;font-size:0.82rem">${r.active_7d}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #E2E8F0">
            <div style="display:flex;align-items:center;gap:8px">
              <div style="flex:1;background:#E2E8F0;border-radius:4px;height:8px">
                <div style="width:${barW}%;background:${barClr};border-radius:4px;height:8px"></div>
              </div>
              <span style="font-size:0.8rem;font-weight:600;color:${barClr};min-width:36px;text-align:right">${rate}%</span>
            </div>
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="4" style="padding:16px;text-align:center;color:#718096">No activated users yet.</td></tr>';

    // ── Recent registrations ──
    const regRows = recentRegs.length > 0
      ? recentRegs.map(r => `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0">${r.day}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-weight:600;color:#1A56A4">${r.count}</td>
          </tr>`).join('')
      : '<tr><td colspan="2" style="padding:12px;color:#718096;text-align:center">No registrations in last 7 days</td></tr>';

    // ── System health ──
    const healthItems = [
      { label: 'WhatsApp Token',  ok: !!process.env.WHATSAPP_TOKEN,            detail: process.env.WHATSAPP_TOKEN ? `length: ${process.env.WHATSAPP_TOKEN.length}` : 'NOT SET' },
      { label: 'Gemini API Key',  ok: !!process.env.GEMINI_API_KEY,            detail: process.env.GEMINI_API_KEY ? 'set' : 'NOT SET' },
      { label: 'Brevo API Key',   ok: !!process.env.BREVO_API_KEY,             detail: process.env.BREVO_API_KEY ? 'set' : 'NOT SET' },
      { label: 'Database URL',    ok: !!process.env.DATABASE_URL,              detail: process.env.DATABASE_URL ? 'set' : 'NOT SET' },
      { label: 'Cron Secret',     ok: !!process.env.CRON_SECRET,              detail: process.env.CRON_SECRET ? 'set' : 'NOT SET' },
      { label: 'WA Phone ID',     ok: !!process.env.WHATSAPP_PHONE_NUMBER_ID, detail: process.env.WHATSAPP_PHONE_NUMBER_ID || 'NOT SET' },
    ];
    const healthRows = healthItems.map(h => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #E2E8F0">
        <span style="font-weight:500">${h.label}</span>
        <span style="background:${h.ok ? '#C6F6D5' : '#FED7D7'};color:${h.ok ? '#1A7A4A' : '#C53030'};padding:3px 10px;border-radius:12px;font-size:0.8rem">
          ${h.ok ? '✅ ' : '❌ '}${h.detail}
        </span>
      </div>`).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BizPulse Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'DM Sans',sans-serif;background:#F0F4FA;color:#1a202c}
    .header{background:#0F2744;color:#fff;padding:1rem 2rem;display:flex;justify-content:space-between;align-items:center}
    .header h1{font-size:1.125rem;font-weight:600}
    .header-right{display:flex;gap:.75rem;align-items:center}
    .badge{background:rgba(255,255,255,.15);padding:4px 10px;border-radius:20px;font-size:.75rem}
    .btn{background:#1A56A4;color:#fff;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:.875rem;text-decoration:none}

    .metrics-bar{display:grid;grid-template-columns:repeat(6,1fr);gap:0;background:#fff;border-bottom:2px solid #E2E8F0;margin-bottom:0}
    .metric-cell{padding:1rem 1.25rem;text-align:center;border-right:1px solid #E2E8F0}
    .metric-cell:last-child{border-right:none}
    .metric-cell .val{font-size:1.75rem;font-weight:700;line-height:1}
    .metric-cell .lbl{font-size:.72rem;color:#718096;text-transform:uppercase;letter-spacing:.04em;margin-top:.25rem}

    .tabs{display:flex;gap:0;background:#fff;border-bottom:2px solid #E2E8F0}
    .tab{padding:.75rem 1.5rem;cursor:pointer;font-size:.9rem;font-weight:500;color:#718096;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .2s}
    .tab.active{color:#1A56A4;border-bottom-color:#1A56A4}
    .tab:hover:not(.active){color:#1a202c}

    .pane{display:none;padding:1.5rem 2rem}
    .pane.active{display:block}

    .section-title{font-size:.8rem;font-weight:600;color:#718096;text-transform:uppercase;letter-spacing:.05em;margin-bottom:1rem;margin-top:1.5rem}
    .section-title:first-child{margin-top:0}

    .card{background:#fff;border-radius:12px;padding:1.25rem;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:1.5rem}

    table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:.875rem}
    thead th{background:#0F2744;color:#fff;padding:10px 12px;text-align:left;font-size:.78rem;font-weight:500}

    .custom-msg-form{display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end}
    .custom-msg-form select,.custom-msg-form textarea,.custom-msg-form input{padding:8px 12px;border:1px solid #E2E8F0;border-radius:8px;font-family:inherit;font-size:.875rem}
    .custom-msg-form textarea{flex:1;min-width:200px;resize:vertical}

    .toast{position:fixed;bottom:2rem;right:2rem;background:#1A7A4A;color:#fff;padding:12px 20px;border-radius:8px;font-size:.875rem;display:none;z-index:999;box-shadow:0 4px 12px rgba(0,0,0,.2)}

    @media(max-width:700px){
      .metrics-bar{grid-template-columns:repeat(3,1fr)}
      .tabs{overflow-x:auto}
      .pane{padding:1rem}
    }
  </style>
</head>
<body>

<div class="header">
  <h1>📊 BizPulse Admin</h1>
  <div class="header-right">
    <span class="badge">Phase 1</span>
    <a href="/admin?password=${encodeURIComponent(pw)}" class="btn" style="font-size:.8rem;padding:6px 14px">↻ Refresh</a>
  </div>
</div>

<!-- Top metrics bar — always visible -->
<div class="metrics-bar">
  <div class="metric-cell">
    <div class="val">${totalUsers}</div>
    <div class="lbl">Total Users</div>
  </div>
  <div class="metric-cell">
    <div class="val" style="color:#1A56A4">${activated}</div>
    <div class="lbl">Activated (${activationRate}%)</div>
  </div>
  <div class="metric-cell">
    <div class="val" style="color:#1A7A4A">${activeToday}</div>
    <div class="lbl">Active Today</div>
  </div>
  <div class="metric-cell">
    <div class="val" style="color:#1A7A4A">${activeThisWeek}</div>
    <div class="lbl">Active This Week</div>
  </div>
  <div class="metric-cell">
    <div class="val" style="color:#B7791F">${atRiskCount}</div>
    <div class="lbl">At Risk</div>
  </div>
  <div class="metric-cell">
    <div class="val" style="color:#C53030">${churned}</div>
    <div class="lbl">Churned</div>
  </div>
</div>

<!-- Tab bar -->
<div class="tabs">
  <div class="tab active" onclick="showTab('overview')">Overview</div>
  <div class="tab" onclick="showTab('users')">Users (${totalUsers})</div>
  <div class="tab" onclick="showTab('messages')">Messages</div>
  <div class="tab" onclick="showTab('atrisk')">At-Risk (${atRiskCount})</div>
  <div class="tab" onclick="showTab('variants')">Nudge Analytics</div>
  <div class="tab" onclick="showTab('health')">System Health</div>
  <div class="tab" onclick="showTab('learning');loadLearning()">🧠 Learning</div>
</div>

<!-- ── OVERVIEW TAB ── -->
<div id="tab-overview" class="pane active">
  <p class="section-title">New Registrations — Last 7 Days</p>
  <table>
    <thead><tr><th>Date</th><th>New Users</th></tr></thead>
    <tbody>${regRows}</tbody>
  </table>

  <p class="section-title" style="margin-top:1.5rem">Send Custom WhatsApp Message</p>
  <div class="card">
    <div class="custom-msg-form">
      <select id="msgUserId" style="width:220px">
        <option value="">— Select user —</option>
        ${allUsers.filter(u => u.whatsapp_number).map(u =>
          `<option value="${u.id}">${escHtml(u.name)} (${u.whatsapp_number})</option>`
        ).join('')}
      </select>
      <textarea id="msgBody" rows="3" placeholder="Type your message…" style="min-height:80px"></textarea>
      <button onclick="sendCustomMsg()"
        style="padding:8px 20px;background:#1A7A4A;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">
        Send
      </button>
    </div>
  </div>

  <p class="updated" style="font-size:.75rem;color:#718096;margin-top:1rem">
    Last updated: ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} WAT
  </p>
</div>

<!-- ── USERS TAB ── -->
<div id="tab-users" class="pane">
  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>Name / Email</th>
          <th>Business Type</th>
          <th>Phone</th>
          <th>Status</th>
          <th>Streak</th>
          <th>Entries</th>
          <th>Registered</th>
          <th>Last Active</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${userRows || '<tr><td colspan="9" style="padding:16px;text-align:center;color:#718096">No users yet</td></tr>'}</tbody>
    </table>
  </div>
</div>

<!-- ── MESSAGES TAB ── -->
<div id="tab-messages" class="pane">
  <p style="font-size:.85rem;color:#718096;margin-bottom:1rem">
    Last 50 messages — 📥 user messages &nbsp;|&nbsp; 📤 BizPulse replies (highlighted blue)
  </p>
  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th style="text-align:center">Dir</th>
          <th>From</th>
          <th>Message</th>
          <th>Intent</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${msgRows}</tbody>
    </table>
  </div>
</div>

<!-- ── AT-RISK TAB ── -->
<div id="tab-atrisk" class="pane">
  <p style="font-size:.85rem;color:#718096;margin-bottom:1rem">
    Users who haven't sent a message in 5–14 days. Send a nudge to bring them back.
  </p>
  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Business Type</th>
          <th>Phone</th>
          <th>Last Active</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${atRiskRows}</tbody>
    </table>
  </div>
</div>

<!-- ── NUDGE ANALYTICS TAB ── -->
<div id="tab-variants" class="pane">
  <p class="section-title">Nudge Format Conversion Rates</p>
  <p style="font-size:.82rem;color:#718096;margin-bottom:1rem">
    Conversion = user logged an entry within 48 hours of receiving the nudge.
    Format A = Loss Aversion &nbsp;|&nbsp; B = Identity &nbsp;|&nbsp; C = Future Milestone &nbsp;|&nbsp; D = Peer Comparison.
  </p>
  <div style="overflow-x:auto;margin-bottom:2rem">
    <table>
      <thead>
        <tr>
          <th>Message Type</th>
          <th>Format</th>
          <th style="text-align:center">Sent</th>
          <th style="text-align:center">Converted</th>
          <th style="text-align:center">Conversion Rate</th>
          <th style="text-align:center">Avg Days to Log</th>
        </tr>
      </thead>
      <tbody>${variantRows}</tbody>
    </table>
  </div>

  <p class="section-title" style="margin-top:1.5rem">Parse Confirmation (last 7 days)</p>
  <p style="font-size:.82rem;color:#718096;margin-bottom:1rem">
    Tracks how often Gemini gets entries right vs needing correction.
    Correction rate &gt;20% means the AI prompt needs tuning.
  </p>
  ${confirmStatsHtml}

  <p class="section-title" style="margin-top:1.5rem">Product Tracking</p>
  <p style="font-size:.82rem;color:#718096;margin-bottom:1rem">
    Products tracked across all active users.
  </p>
  ${productStatsHtml}

  <p class="section-title" style="margin-top:1.5rem">Stock Intelligence Adoption</p>
  <p style="font-size:.82rem;color:#718096;margin-bottom:1rem">
    How many activated users have completed their opening stock setup. Low adoption means the morning briefing isn't firing for most users.
  </p>
  ${openingStockHtml}

  <p class="section-title" style="margin-top:1.5rem">Photo &amp; Voice Intelligence</p>
  <p style="font-size:.82rem;color:#718096;margin-bottom:1rem">
    Usage of image (price-tag photo) and voice message submission. Parse rate = Gemini successfully extracted data.
  </p>
  ${mediaStatsHtml}

  <p class="section-title" style="margin-top:1.5rem">Buying Calculator Usage</p>
  <p style="font-size:.82rem;color:#718096;margin-bottom:1rem">
    Users who sent a margin % command (e.g. "35% margin") to calculate target buying prices. Confirmed = user accepted the result.
  </p>
  ${calcStatsHtml}

  <p class="section-title" style="margin-top:1.5rem">🧠 Training Dataset</p>
  <p style="font-size:.82rem;color:#718096;margin-bottom:1rem">
    Every confirmed entry is a labeled fine-tuning example: input = WhatsApp message, output = Gemini JSON, label = user confirmed correct.
  </p>
  <div id="dataset-stats-area">
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:1rem;margin-bottom:1rem" id="dataset-stats-grid">
      <div class="stat-card"><div class="stat-value" id="ds-confirmed">–</div><div class="stat-label">Confirmed examples</div></div>
      <div class="stat-card"><div class="stat-value" id="ds-edited">–</div><div class="stat-label">Edited (negative)</div></div>
      <div class="stat-card"><div class="stat-value" id="ds-total">–</div><div class="stat-label">Total parses logged</div></div>
      <div class="stat-card"><div class="stat-value" id="ds-latency">–</div><div class="stat-label">Avg parse latency</div></div>
    </div>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap">
      <a id="ds-export-btn" href="/admin/api/dataset/export.jsonl?outcome=confirmed&password=${pw}" download
        style="padding:8px 18px;background:#0F2744;color:#fff;border-radius:8px;text-decoration:none;font-size:.88rem;font-weight:600">
        ⬇ Download confirmed.jsonl
      </a>
      <a id="ds-export-all-btn" href="/admin/api/dataset/export.jsonl?outcome=all&password=${pw}" download
        style="padding:8px 18px;background:#1A56A4;color:#fff;border-radius:8px;text-decoration:none;font-size:.88rem;font-weight:600">
        ⬇ Download all labeled.jsonl
      </a>
    </div>
    <div id="ds-type-dist" style="margin-top:.75rem;font-size:.82rem;color:#718096"></div>
  </div>

  <p class="section-title">7-Day Retention by Business Type</p>
  <p style="font-size:.82rem;color:#718096;margin-bottom:1rem">
    % of activated users (at least 1 message sent) who sent a message in the last 7 days.
  </p>
  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>Business Type</th>
          <th style="text-align:center">Total Users</th>
          <th style="text-align:center">Active (7d)</th>
          <th>Retention Rate</th>
        </tr>
      </thead>
      <tbody>${bizRetentionRows}</tbody>
    </table>
  </div>
</div>

<!-- ── HEALTH TAB ── -->
<div id="tab-health" class="pane">
  <p class="section-title">Environment Variables</p>
  <div class="card">${healthRows}</div>

  <p class="section-title">Cron Jobs (external trigger URLs)</p>
  <div class="card" style="font-size:.85rem;line-height:2">
    <div>POST <code style="background:#F0F4FA;padding:2px 6px;border-radius:4px">${process.env.BASE_URL || ''}/api/cron/morning-broadcast</code> — 7am WAT daily</div>
    <div>POST <code style="background:#F0F4FA;padding:2px 6px;border-radius:4px">${process.env.BASE_URL || ''}/api/cron/evening-reminder</code> — 6pm WAT daily</div>
    <div>POST <code style="background:#F0F4FA;padding:2px 6px;border-radius:4px">${process.env.BASE_URL || ''}/api/cron/daily-summary</code> — 7pm WAT daily</div>
    <div>POST <code style="background:#F0F4FA;padding:2px 6px;border-radius:4px">${process.env.BASE_URL || ''}/api/cron/retention-nudge</code> — 10am WAT daily</div>
  </div>
</div>

<!-- ── LEARNING TAB ── -->
<div id="tab-learning" class="pane">
  <p class="section-title">Crowdsourced Vocabulary Learning</p>
  <div id="learning-stats" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:1rem;margin-bottom:1.5rem">
    <div class="stat-card"><div class="stat-value" id="ls-active">–</div><div class="stat-label">Active phrases</div></div>
    <div class="stat-card"><div class="stat-value" id="ls-pending">–</div><div class="stat-label">Pending review</div></div>
    <div class="stat-card"><div class="stat-value" id="ls-corrections">–</div><div class="stat-label">Total corrections</div></div>
    <div class="stat-card"><div class="stat-value" id="ls-rejected">–</div><div class="stat-label">Rejected</div></div>
  </div>

  <p class="section-title">Pending Review
    <span style="font-size:.8rem;font-weight:400;color:#718096;margin-left:.5rem">
      — intent_change always requires manual approval; others surface here at 2+ user confirmations
    </span>
  </p>
  <div id="learning-pending">
    <p style="color:#718096;font-size:.9rem">Loading…</p>
  </div>

  <p class="section-title" style="margin-top:1.5rem">Active Learned Phrases (injected into every Gemini parse)</p>
  <div id="learning-active">
    <p style="color:#718096;font-size:.9rem">Loading…</p>
  </div>
</div>

<!-- Toast notification -->
<div class="toast" id="toast"></div>

<!-- User detail modal -->
<div id="userModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;overflow-y:auto;padding:1.5rem 1rem">
  <div style="background:#fff;margin:0 auto;border-radius:12px;max-width:860px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.2)">
    <div style="background:#0F2744;color:#fff;padding:1rem 1.5rem;display:flex;justify-content:space-between;align-items:center">
      <h3 id="modalTitle" style="font-size:1rem;font-weight:600;margin:0">User Details</h3>
      <button onclick="document.getElementById('userModal').style.display='none'"
        style="background:none;border:none;color:#fff;cursor:pointer;font-size:1.4rem;line-height:1">×</button>
    </div>
    <div id="modalContent" style="padding:1.5rem;font-family:'DM Sans',sans-serif">
      <p style="color:#718096">Loading…</p>
    </div>
  </div>
</div>

<script>
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  document.querySelector('[onclick="showTab(\\''+name+'\\')"]').classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
}

function toast(msg, ok=true) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = ok ? '#1A7A4A' : '#C53030';
  el.style.display = 'block';
  setTimeout(() => { el.style.display='none'; }, 3500);
}

async function sendNudge(userId, firstName) {
  if (!confirm('Send a WhatsApp nudge to ' + firstName + '?')) return;
  const res = await fetch('/admin/nudge?password=${encodeURIComponent(pw)}', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ userId }),
  });
  const data = await res.json();
  if (data.success) toast('✅ Nudge sent to ' + firstName);
  else toast('❌ Failed: ' + (data.error || 'unknown error'), false);
}

async function sendCustomMsg() {
  const userId  = document.getElementById('msgUserId').value;
  const msgBody = document.getElementById('msgBody').value.trim();
  if (!userId || !msgBody) { toast('Select a user and enter a message', false); return; }
  const res = await fetch('/admin/message?password=${encodeURIComponent(pw)}', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ userId, message: msgBody }),
  });
  const data = await res.json();
  if (data.success) { toast('✅ Message sent!'); document.getElementById('msgBody').value = ''; }
  else toast('❌ Failed: ' + (data.error || 'unknown error'), false);
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let _currentUserId = null;

async function openUserDetail(userId) {
  _currentUserId = userId;
  const modal   = document.getElementById('userModal');
  const content = document.getElementById('modalContent');
  modal.style.display = 'block';
  content.innerHTML   = '<p style="color:#718096">Loading…</p>';

  const res  = await fetch('/admin/user/' + userId + '?password=${encodeURIComponent(pw)}');
  const data = await res.json();
  if (!data.user) { content.innerHTML = '<p style="color:#C53030">Error loading user.</p>'; return; }

  const u = data.user;
  document.getElementById('modalTitle').textContent = u.name + (u.biz_name ? ' — ' + u.biz_name : '');

  const fmt = n => Number(n||0).toLocaleString('en-NG');

  const msgRows = (data.messages || []).map(m => {
    const ts  = new Date(m.created_at).toLocaleString('en-NG', { timeZone:'Africa/Lagos', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
    const isOut = m.direction === 'outbound';
    const rowBg = isOut ? '#EBF8FF' : '#FFFFFF';
    const dirIcon = isOut ? '📤' : '📥';
    const intentColors = { daily_entry:'#BEE3F8', nps_response:'#C6F6D5', onboarding:'#C6F6D5', unregistered:'#FED7D7', unknown:'#FED7D7' };
    const intentBg = isOut ? '#BEE3F8' : (intentColors[m.intent] || '#E2E8F0');
    const intentLabel = isOut ? 'reply' : (m.intent || '—');
    return '<tr style="background:' + rowBg + '">' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0;font-size:0.72rem;color:#718096;white-space:nowrap">' + esc(ts) + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0;text-align:center">' + dirIcon + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0;font-size:0.82rem;word-break:break-word">' + esc(m.message_text || '—') + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0"><span style="background:' + intentBg + ';padding:2px 7px;border-radius:10px;font-size:0.7rem">' + esc(intentLabel) + '</span></td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="4" style="padding:12px;text-align:center;color:#718096">No messages logged yet</td></tr>';

  const entryRows = (data.entries || []).map(e => {
    const d   = new Date(e.date).toLocaleDateString('en-NG', { day:'numeric', month:'short' });
    const pc  = parseFloat(e.profit) >= 0 ? '#1A7A4A' : '#C53030';
    return '<tr id="erow-' + e.id + '">' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">' + d + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">₦' + fmt(e.revenue) + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0;font-size:0.8rem">₦' + fmt(e.total_expenses) + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0;font-size:0.8rem;color:' + pc + '">₦' + fmt(e.profit) + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0;font-size:0.75rem;color:#718096">' + esc(e.entry_method || 'text') + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #E2E8F0">' +
        '<button onclick="showCorrectForm(' + e.id + ',' + e.revenue + ',' + e.total_expenses + ')"' +
        ' style="font-size:0.72rem;padding:3px 9px;background:#B7791F;color:#fff;border:none;border-radius:5px;cursor:pointer">Edit</button>' +
      '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="6" style="padding:12px;text-align:center;color:#718096">No entries yet</td></tr>';

  content.innerHTML =
    '<div style="background:#F0F4FA;border-radius:8px;padding:12px 16px;font-size:0.85rem;margin-bottom:1rem;display:flex;flex-wrap:wrap;gap:1rem;align-items:center">' +
      '<span>📱 <strong id="phoneDisplay">' + esc(u.whatsapp_number||'—') + '</strong></span>' +
      '<span>📧 ' + esc(u.email) + '</span>' +
      '<span>🏢 ' + esc(u.biz_type||'—') + '</span>' +
      '<span>🔥 ' + (u.streak||0) + ' day streak</span>' +
      '<span>💬 ' + (u.total_messages_sent||0) + ' messages</span>' +
    '</div>' +
    '<div style="background:#FFF8E1;border:1px solid #F6E05E;border-radius:8px;padding:10px 14px;margin-bottom:1.25rem;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<span style="font-size:0.82rem;font-weight:600;color:#B7791F">Update WhatsApp number:</span>' +
      '<input id="newPhoneInput" placeholder="e.g. 08035273030" style="padding:5px 10px;border:1px solid #E2E8F0;border-radius:6px;font-size:0.85rem;flex:1;min-width:160px">' +
      '<button onclick="savePhone(' + u.id + ')" style="padding:5px 14px;background:#1A56A4;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.82rem;font-weight:600">Save</button>' +
    '</div>' +

    '<h4 style="font-size:0.85rem;font-weight:600;margin:0 0 0.6rem">WhatsApp Messages — 📥 user &nbsp;|&nbsp; 📤 BizPulse reply (last 40)</h4>' +
    '<div style="overflow-x:auto;margin-bottom:1.5rem;border-radius:8px;border:1px solid #E2E8F0">' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="background:#0F2744;color:#fff">' +
          '<th style="padding:8px 10px;text-align:left;font-size:0.72rem;white-space:nowrap">Time (WAT)</th>' +
          '<th style="padding:8px 10px;text-align:center;font-size:0.72rem">Dir</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:0.72rem">Message</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:0.72rem">Intent</th>' +
        '</tr></thead>' +
        '<tbody>' + msgRows + '</tbody>' +
      '</table>' +
    '</div>' +

    '<h4 style="font-size:0.85rem;font-weight:600;margin:0 0 0.6rem">Entries — click Edit to correct any wrong parse</h4>' +
    '<div style="overflow-x:auto;border-radius:8px;border:1px solid #E2E8F0">' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="background:#0F2744;color:#fff">' +
          '<th style="padding:8px 10px;text-align:left;font-size:0.72rem">Date</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:0.72rem">Revenue</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:0.72rem">Expenses</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:0.72rem">Profit</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:0.72rem">Method</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:0.72rem">Action</th>' +
        '</tr></thead>' +
        '<tbody>' + entryRows + '</tbody>' +
      '</table>' +
    '</div>';
}

function showCorrectForm(id, curRev, curExp) {
  // Replace the row's Edit button with an inline form
  const row = document.getElementById('erow-' + id);
  if (!row) return;
  const cells = row.querySelectorAll('td');
  // Show inline inputs in Revenue and Expenses cells, Save button in Action cell
  cells[1].innerHTML = '<input id="cr-rev-'+id+'" value="'+curRev+'" style="width:90px;padding:3px 6px;border:1px solid #1A56A4;border-radius:4px;font-size:0.8rem">';
  cells[2].innerHTML = '<input id="cr-exp-'+id+'" value="'+curExp+'" style="width:90px;padding:3px 6px;border:1px solid #1A56A4;border-radius:4px;font-size:0.8rem">';
  cells[5].innerHTML =
    '<button onclick="submitCorrection('+id+')" style="font-size:0.72rem;padding:3px 9px;background:#1A7A4A;color:#fff;border:none;border-radius:5px;cursor:pointer;margin-right:3px">Save</button>' +
    '<button onclick="openUserDetail('+_currentUserId+')" style="font-size:0.72rem;padding:3px 9px;background:#718096;color:#fff;border:none;border-radius:5px;cursor:pointer">Cancel</button>';
}

async function submitCorrection(id) {
  const rev = parseFloat(document.getElementById('cr-rev-'+id)?.value || 0);
  const exp = parseFloat(document.getElementById('cr-exp-'+id)?.value || 0);
  const res  = await fetch('/admin/entry/' + id + '/correct?password=${encodeURIComponent(pw)}', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ revenue: rev, totalExpenses: exp }),
  });
  const data = await res.json();
  if (data.success) {
    toast('✅ Entry corrected — Profit: ₦' + Number(data.profit).toLocaleString('en-NG') + ' (' + parseFloat(data.margin).toFixed(1) + '%)');
    openUserDetail(_currentUserId);
  } else {
    toast('❌ ' + (data.error || 'Correction failed'), false);
  }
}

async function savePhone(userId) {
  const phone = document.getElementById('newPhoneInput')?.value?.trim();
  if (!phone) { toast('Enter a phone number first', false); return; }
  const res  = await fetch('/admin/user/' + userId + '/phone?password=${encodeURIComponent(pw)}', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ phone }),
  });
  const data = await res.json();
  if (data.success) {
    toast('✅ Phone updated → ' + data.canonical);
    const el = document.getElementById('phoneDisplay');
    if (el) el.textContent = data.canonical;
    document.getElementById('newPhoneInput').value = '';
  } else {
    toast('❌ ' + (data.error || 'Update failed'), false);
  }
}

// ── Dataset stats ─────────────────────────────────────────────────────────────
(async function loadDatasetStats() {
  try {
    const pw = new URLSearchParams(location.search).get('password') || '';
    const res = await fetch('/admin/api/dataset/stats?password=' + encodeURIComponent(pw));
    const data = await res.json();
    if (!data.success) return;

    const ps = data.parseStats;
    const ls = data.labelStats;

    document.getElementById('ds-confirmed').textContent = Number(ls.confirmed || 0).toLocaleString();
    document.getElementById('ds-edited').textContent    = Number(ls.edited    || 0).toLocaleString();
    document.getElementById('ds-total').textContent     = Number(ps.total_parses || 0).toLocaleString();
    document.getElementById('ds-latency').textContent   =
      ps.avg_latency_24h ? Math.round(ps.avg_latency_24h) + ' ms' : '–';

    if (data.typeDistribution && data.typeDistribution.length) {
      const dist = data.typeDistribution
        .map(r => \`<span style="margin-right:1rem">\${r.parsed_type}: \${r.n}</span>\`)
        .join('');
      document.getElementById('ds-type-dist').innerHTML = 'Type breakdown (confirmed): ' + dist;
    }
  } catch (e) { /* non-critical */ }
})();

// ── Learning tab ──────────────────────────────────────────────────────────────
let learningLoaded = false;
async function loadLearning() {
  if (learningLoaded) return;
  learningLoaded = true;
  const pw = new URLSearchParams(location.search).get('password') || '';
  const res = await fetch('/admin/api/learning?password=' + encodeURIComponent(pw));
  const data = await res.json();
  if (!data.success) { toast('❌ Could not load learning data', false); return; }

  const { stats, pending, active } = data;
  document.getElementById('ls-active').textContent      = stats.active_count      || 0;
  document.getElementById('ls-pending').textContent     = stats.pending_count     || 0;
  document.getElementById('ls-corrections').textContent = stats.total_corrections || 0;
  document.getElementById('ls-rejected').textContent    = stats.rejected_count    || 0;

  // Pending reviews
  const pendingEl = document.getElementById('learning-pending');
  if (!pending || !pending.length) {
    pendingEl.innerHTML = '<p style="color:#718096;font-size:.9rem">No phrases pending review.</p>';
  } else {
    pendingEl.innerHTML = pending.map(p => {
      const examples = (p.examples || []).slice(0, 3)
        .map(e => '<li style="color:#4A5568;font-size:.82rem;margin:2px 0">"' + escHtmlJs(e.message || '') + '" (' + (e.state || 'unknown state') + ')</li>')
        .join('');
      const badge = p.learn_type === 'intent_change'
        ? '<span style="background:#FEB2B2;color:#742A2A;padding:2px 8px;border-radius:10px;font-size:.75rem;font-weight:600">intent_change — manual required</span>'
        : p.learn_type === 'product_variant'
        ? '<span style="background:#BEE3F8;color:#2C5282;padding:2px 8px;border-radius:10px;font-size:.75rem;font-weight:600">product_variant</span>'
        : '<span style="background:#FEFCBF;color:#744210;padding:2px 8px;border-radius:10px;font-size:.75rem;font-weight:600">phrase_intent</span>';
      return \`<div style="border:1px solid #E2E8F0;border-radius:8px;padding:1rem;margin-bottom:.75rem">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;flex-wrap:wrap">
          <div>
            \${badge}
            <span style="font-weight:600;margin-left:.5rem">"<code>\${escHtmlJs(p.phrase_key)}</code>"</span>
            &rarr; <span style="color:#1A7A4A">\${escHtmlJs(p.maps_to)}</span>
          </div>
          <div style="font-size:.82rem;color:#718096">\${p.unique_users} users · \${p.unique_states} states · \${p.correction_count} corrections</div>
        </div>
        <ul style="margin:.5rem 0 .75rem 1rem;padding:0">\${examples}</ul>
        <div style="display:flex;gap:.5rem">
          <button onclick="learningAction(\${p.id},'approve')" style="padding:5px 16px;background:#1A7A4A;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.85rem">✅ Approve</button>
          <button onclick="learningAction(\${p.id},'reject')" style="padding:5px 16px;background:#C53030;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.85rem">❌ Reject</button>
        </div>
      </div>\`;
    }).join('');
  }

  // Active phrases
  const activeEl = document.getElementById('learning-active');
  if (!active || !active.length) {
    activeEl.innerHTML = '<p style="color:#718096;font-size:.9rem">No active phrases yet. They will appear here once confirmed at threshold.</p>';
  } else {
    activeEl.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:.88rem"><thead><tr style="background:#F0F4FA"><th style="text-align:left;padding:8px">Phrase</th><th style="text-align:left;padding:8px">Type</th><th style="text-align:left;padding:8px">Maps to</th><th style="padding:8px">Users</th><th style="padding:8px">States</th></tr></thead><tbody>' +
      active.map((p, i) => \`<tr style="background:\${i%2===0?'#fff':'#F7FAFC'}">
        <td style="padding:8px;font-family:monospace">\${escHtmlJs(p.phrase_key)}</td>
        <td style="padding:8px;font-size:.8rem;color:#718096">\${p.learn_type}</td>
        <td style="padding:8px;color:#1A7A4A">\${escHtmlJs(p.maps_to)}</td>
        <td style="padding:8px;text-align:center">\${p.unique_users}</td>
        <td style="padding:8px;text-align:center">\${p.unique_states}</td>
      </tr>\`).join('') +
      '</tbody></table>';
  }
}

async function learningAction(id, action) {
  const pw = new URLSearchParams(location.search).get('password') || '';
  const res = await fetch('/admin/api/learning/' + id + '/' + action + '?password=' + encodeURIComponent(pw), { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    toast(action === 'approve' ? '✅ Phrase approved — now active' : '✅ Phrase rejected');
    learningLoaded = false;
    loadLearning();
  } else {
    toast('❌ ' + (data.error || 'Failed'), false);
  }
}

function escHtmlJs(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    console.error('[Admin] Dashboard error:', err.message);
    res.status(500).send('Admin dashboard error: ' + err.message);
  }
});

// ─────────────────────────────────────────────
// POST /admin/nudge — send a retention nudge WhatsApp message
// ─────────────────────────────────────────────
router.post('/nudge', adminAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const user = await UserModel.findById(userId);
    if (!user || !user.whatsapp_number) return res.status(404).json({ error: 'User not found or no phone number' });

    const WhatsAppService = require('../services/whatsapp');
    const firstName = user.name.split(' ')[0];
    const streak = parseInt(user.streak, 10) || 0;
    await WhatsAppService.sendReminder(user.whatsapp_number, firstName, streak);
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin] nudge error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /admin/message — send a custom WhatsApp message
// ─────────────────────────────────────────────
router.post('/message', adminAuth, async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });

    const user = await UserModel.findById(userId);
    if (!user || !user.whatsapp_number) return res.status(404).json({ error: 'User not found or no phone number' });

    const WhatsAppService = require('../services/whatsapp');
    await WhatsAppService.sendMessage(user.whatsapp_number, message);
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin] message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /admin/user/:id — full user detail for the modal (messages + entries)
// ─────────────────────────────────────────────
router.get('/user/:id', adminAuth, async (req, res) => {
  try {
    const user = await UserModel.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [messages, entries] = await Promise.all([
      MessageModel.getByUser(user.id, user.whatsapp_number, 40),
      TransactionModel.getRawByUser(user.id, 30),
    ]);

    res.json({ user, messages, entries });
  } catch (err) {
    console.error('[Admin] /user/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /admin/user/:id/phone — update a user's WhatsApp number from admin
// ─────────────────────────────────────────────
router.post('/user/:id/phone', adminAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const { normalizePhone } = require('../utils/phone');
    const canonical = normalizePhone(phone);
    await query('UPDATE users SET whatsapp_number = $1 WHERE id = $2', [canonical, req.params.id]);
    console.log(`[Admin] Phone updated for user ${req.params.id} → ${canonical}`);
    res.json({ success: true, canonical });
  } catch (err) {
    console.error('[Admin] /user/:id/phone error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /admin/entry/:id/correct — admin manual correction of a parsed entry
// ─────────────────────────────────────────────
router.post('/entry/:id/correct', adminAuth, async (req, res) => {
  try {
    const { revenue, totalExpenses, notes } = req.body;
    const updated = await TransactionModel.correct(req.params.id, { revenue, totalExpenses, notes });
    if (!updated) return res.status(404).json({ error: 'Entry not found' });
    console.log(`[Admin] Entry ${req.params.id} corrected: revenue=${updated.revenue}, profit=${updated.profit}`);
    res.json({ success: true, profit: parseFloat(updated.profit), margin: parseFloat(updated.margin) });
  } catch (err) {
    console.error('[Admin] /entry/:id/correct error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /admin/stats — JSON API (for monitoring tools)
// ─────────────────────────────────────────────
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const [stats, recentRegs] = await Promise.all([
      UserModel.getAdminStats(),
      UserModel.getRecentRegistrations(7),
    ]);
    res.json({ stats, recentRegistrations: recentRegs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /admin/api/dataset/stats — training dataset summary
// ─────────────────────────────────────────────
router.get('/api/dataset/stats', adminAuth, async (req, res) => {
  try {
    const [parseStats, labelStats, latencyStats] = await Promise.all([
      // Total parse calls by outcome
      query(`
        SELECT
          COUNT(*)                                         AS total_parses,
          COUNT(*) FILTER (WHERE outcome = 'confirmed')    AS confirmed,
          COUNT(*) FILTER (WHERE outcome = 'edited')       AS edited,
          COUNT(*) FILTER (WHERE outcome IS NULL)          AS unlabeled,
          ROUND(AVG(latency_ms))                           AS avg_latency_ms,
          ROUND(AVG(latency_ms) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')) AS avg_latency_24h
        FROM ai_inference_log
        WHERE call_type = 'parse'
      `),
      // Pending entries by status — the ground-truth confirmation labels
      query(`
        SELECT
          COUNT(*)                                              AS total,
          COUNT(*) FILTER (WHERE status = 'confirmed')         AS confirmed,
          COUNT(*) FILTER (WHERE status = 'edited')            AS edited,
          COUNT(*) FILTER (WHERE status = 'expired')           AS expired,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS last_7d
        FROM pending_entries
      `),
      // Parse type distribution (confirmed entries = clean training data)
      query(`
        SELECT parsed_type, COUNT(*) AS n
        FROM ai_inference_log
        WHERE call_type = 'parse' AND outcome = 'confirmed'
        GROUP BY parsed_type
        ORDER BY n DESC
      `),
    ]);
    res.json({
      success: true,
      parseStats: parseStats.rows[0],
      labelStats: labelStats.rows[0],
      typeDistribution: latencyStats.rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /admin/api/dataset/export.jsonl
// Streams the full labeled training dataset as newline-delimited JSON.
// Each line is one example in Anthropic/OpenAI fine-tuning format.
// ─────────────────────────────────────────────
router.get('/api/dataset/export.jsonl', adminAuth, async (req, res) => {
  try {
    const outcomeFilter = req.query.outcome || 'confirmed'; // 'confirmed' | 'edited' | 'all'

    const whereOutcome = outcomeFilter === 'all'
      ? `pe.status IN ('confirmed','edited')`
      : `pe.status = $1`;
    const params = outcomeFilter === 'all' ? [] : [outcomeFilter];

    const result = await query(
      `SELECT
         pe.id,
         pe.original_message,
         pe.parsed_data,
         pe.entry_type,
         pe.status          AS outcome,
         pe.created_at,
         u.biz_type,
         u.state,
         pc.corrected_parsed_data
       FROM pending_entries pe
       JOIN users u ON u.id = pe.user_id
       LEFT JOIN parse_corrections pc
         ON pc.user_id = pe.user_id
        AND pc.original_message = pe.original_message
        AND pc.created_at >= pe.created_at
        AND pc.created_at <= pe.created_at + INTERVAL '3 hours'
       WHERE ${whereOutcome}
         AND pe.entry_type != 'calc_context'
       ORDER BY pe.created_at DESC
       LIMIT 50000`,
      params
    );

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="bizpulse-training-${new Date().toISOString().slice(0,10)}.jsonl"`);

    for (const row of result.rows) {
      const parsedData = typeof row.parsed_data === 'string'
        ? row.parsed_data
        : JSON.stringify(row.parsed_data);

      const systemContext =
        `You are a Nigerian SME financial data parser. Business type: ${row.biz_type || 'Retail'}. State: ${row.state || 'Nigeria'}.`;

      const example = {
        messages: [
          { role: 'system',    content: systemContext },
          { role: 'user',      content: row.original_message },
          { role: 'assistant', content: parsedData },
        ],
        metadata: {
          id:         row.id,
          entry_type: row.entry_type,
          outcome:    row.outcome,
          biz_type:   row.biz_type,
          state:      row.state,
          created_at: row.created_at,
          // Include correction if this was an edited entry
          correction: row.corrected_parsed_data
            ? (typeof row.corrected_parsed_data === 'string'
                ? row.corrected_parsed_data
                : JSON.stringify(row.corrected_parsed_data))
            : null,
        },
      };
      res.write(JSON.stringify(example) + '\n');
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ─────────────────────────────────────────────
// GET /admin/api/learning — stats + pending reviews + active phrases
// ─────────────────────────────────────────────
router.get('/api/learning', adminAuth, async (req, res) => {
  try {
    const [stats, pending, active] = await Promise.all([
      LearningService.getLearningStats(),
      LearningService.getPendingReviews(),
      LearningService.getActivePhrases(),
    ]);
    res.json({ success: true, stats, pending, active });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /admin/api/learning/:id/approve
// ─────────────────────────────────────────────
router.post('/api/learning/:id/approve', adminAuth, async (req, res) => {
  try {
    await LearningService.approvePhrase(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /admin/api/learning/:id/reject
// ─────────────────────────────────────────────
router.post('/api/learning/:id/reject', adminAuth, async (req, res) => {
  try {
    await LearningService.rejectPhrase(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Helper: escape HTML to prevent XSS in admin dashboard
// ─────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = router;
