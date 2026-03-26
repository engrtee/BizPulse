/**
 * routes/admin.js
 * Password-protected admin dashboard.
 *
 * GET /admin           → HTML dashboard (requires ?password= or x-admin-password header)
 * GET /admin/stats     → JSON stats (for programmatic access)
 *
 * Set ADMIN_PASSWORD in environment variables to enable.
 * If ADMIN_PASSWORD is not set, admin is inaccessible.
 */

'use strict';

const express   = require('express');
const router    = express.Router();
const UserModel = require('../models/user');

// ─────────────────────────────────────────────
// Middleware: simple password gate
// ─────────────────────────────────────────────
function adminAuth(req, res, next) {
  const provided = req.query.password || req.headers['x-admin-password'];

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).send('Admin dashboard not configured. Set ADMIN_PASSWORD env var.');
  }

  if (provided !== process.env.ADMIN_PASSWORD) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>BizPulse Admin</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: sans-serif; background: #F0F4FA; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
          .box { background: #fff; border-radius: 12px; padding: 2rem; box-shadow: 0 4px 16px rgba(0,0,0,0.1); width: 100%; max-width: 360px; text-align: center; }
          h2 { color: #0F2744; margin-bottom: 1.5rem; font-size: 1.25rem; }
          input { width: 100%; padding: 10px 14px; border: 1px solid #E2E8F0; border-radius: 8px; font-size: 1rem; margin-bottom: 1rem; }
          button { width: 100%; padding: 10px; background: #1A56A4; color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
          .logo { font-size: 2rem; margin-bottom: 0.5rem; }
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
      </html>
    `);
  }

  next();
}

// ─────────────────────────────────────────────
// GET /admin — HTML dashboard
// ─────────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  try {
    const [stats, recentRegs] = await Promise.all([
      UserModel.getAdminStats(),
      UserModel.getRecentRegistrations(7),
    ]);

    const pw             = req.query.password || '';
    const totalUsers     = parseInt(stats.total_users,      10) || 0;
    const activated      = parseInt(stats.activated,         10) || 0;
    const activeThisWeek = parseInt(stats.active_this_week,  10) || 0;
    const atRisk         = parseInt(stats.at_risk,           10) || 0;
    const churned        = parseInt(stats.churned,           10) || 0;
    const avgMessages    = parseFloat(stats.avg_messages_per_user) || 0;

    const activationRate = totalUsers > 0 ? Math.round((activated / totalUsers) * 100) : 0;

    const regRows = recentRegs.length > 0
      ? recentRegs.map(r => `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0">${r.day}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-weight:600;color:#1A56A4">${r.count}</td>
          </tr>`).join('')
      : '<tr><td colspan="2" style="padding:12px;color:#718096;text-align:center">No registrations in last 7 days</td></tr>';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BizPulse Admin Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', sans-serif; background: #F0F4FA; color: #1a202c; }

    .header {
      background: #0F2744;
      color: #fff;
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 { font-size: 1.125rem; font-weight: 600; }
    .header-right { display: flex; gap: 0.75rem; align-items: center; }
    .badge { background: rgba(255,255,255,0.15); padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; }
    .btn { background: #1A56A4; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 0.875rem; text-decoration: none; }

    .container { max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    .section-title { font-size: 0.875rem; font-weight: 600; color: #718096; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 1.25rem;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .card .label { font-size: 0.75rem; color: #718096; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; }
    .card .value { font-size: 2rem; font-weight: 700; line-height: 1.1; }
    .card .sub { font-size: 0.75rem; color: #718096; margin-top: 0.25rem; }
    .card.green .value { color: #1A7A4A; }
    .card.blue  .value { color: #1A56A4; }
    .card.gold  .value { color: #B7791F; }
    .card.red   .value { color: #C53030; }

    .funnel { display: flex; gap: 0.5rem; margin-bottom: 2rem; align-items: stretch; }
    .funnel-step {
      flex: 1;
      background: #fff;
      border-radius: 10px;
      padding: 1rem;
      text-align: center;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      font-size: 0.8rem;
    }
    .funnel-step .fval { font-size: 1.5rem; font-weight: 700; }
    .funnel-step .flabel { color: #718096; font-size: 0.75rem; margin-top: 0.25rem; }
    .funnel-arrow { display: flex; align-items: center; color: #CBD5E0; font-size: 1.25rem; }

    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    thead th { background: #0F2744; color: #fff; padding: 10px 12px; text-align: left; font-size: 0.8rem; font-weight: 500; }
    .updated { font-size: 0.75rem; color: #718096; text-align: right; margin-top: 1.5rem; }

    @media (max-width: 600px) {
      .funnel { flex-direction: column; }
      .funnel-arrow { display: none; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>📊 BizPulse Admin</h1>
    <div class="header-right">
      <span class="badge">Phase 1</span>
      <a href="/admin?password=${encodeURIComponent(pw)}" class="btn">Refresh</a>
    </div>
  </div>

  <div class="container">

    <p class="section-title" style="margin-top:0">User Funnel</p>
    <div class="funnel" style="margin-bottom:2rem">
      <div class="funnel-step">
        <div class="fval">${totalUsers}</div>
        <div class="flabel">Registered</div>
      </div>
      <div class="funnel-arrow">→</div>
      <div class="funnel-step">
        <div class="fval" style="color:#1A56A4">${activated}</div>
        <div class="flabel">Activated</div>
      </div>
      <div class="funnel-arrow">→</div>
      <div class="funnel-step">
        <div class="fval" style="color:#1A7A4A">${activeThisWeek}</div>
        <div class="flabel">Active This Week</div>
      </div>
    </div>

    <p class="section-title">Key Metrics</p>
    <div class="stats-grid">
      <div class="card">
        <div class="label">Total Users</div>
        <div class="value">${totalUsers}</div>
        <div class="sub">All registered</div>
      </div>
      <div class="card green">
        <div class="label">Activated</div>
        <div class="value">${activated}</div>
        <div class="sub">${activationRate}% activation rate</div>
      </div>
      <div class="card blue">
        <div class="label">Active This Week</div>
        <div class="value">${activeThisWeek}</div>
        <div class="sub">Messaged in 7 days</div>
      </div>
      <div class="card gold">
        <div class="label">At Risk</div>
        <div class="value">${atRisk}</div>
        <div class="sub">5–14 days inactive</div>
      </div>
      <div class="card red">
        <div class="label">Churned</div>
        <div class="value">${churned}</div>
        <div class="sub">14+ days inactive</div>
      </div>
      <div class="card">
        <div class="label">Avg Messages / User</div>
        <div class="value">${avgMessages.toFixed(1)}</div>
        <div class="sub">Engagement depth</div>
      </div>
    </div>

    <p class="section-title">New Registrations — Last 7 Days</p>
    <table>
      <thead><tr><th>Date</th><th>New Users</th></tr></thead>
      <tbody>${regRows}</tbody>
    </table>

    <p class="updated">Last updated: ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} WAT</p>
  </div>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    console.error('[Admin] Dashboard error:', err.message);
    res.status(500).send('Admin dashboard error: ' + err.message);
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

module.exports = router;
