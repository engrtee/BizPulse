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

    const [stats, recentRegs, allUsers, recentMessages, atRisk] = await Promise.all([
      UserModel.getAdminStats(),
      UserModel.getRecentRegistrations(7),
      UserModel.findAllWithStats(),
      MessageModel.getRecent(50),
      UserModel.findAtRisk(),
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
  <div class="tab" onclick="showTab('health')">System Health</div>
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
