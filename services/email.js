/**
 * services/email.js
 * Build and send the daily HTML email summary via Gmail (Nodemailer).
 *
 * The HTML template is mobile-optimised, uses inline styles (email clients
 * strip <style> blocks), and renders in ₦ with Nigerian locale formatting.
 */

'use strict';

require('dotenv').config();
const axios          = require('axios');
const { formatDate } = require('../utils/formatter');
const { formatNaira }= require('../utils/naira');

// ---------- Brevo (HTTP API — no SMTP ports, works on Render free tier) ----------

// ---------- Health score pill styles ----------

const HEALTH_STYLES = {
  excellent:       { bg: '#C6F6D5', color: '#276749', label: '🟢 Excellent' },
  good:            { bg: '#FEFCBF', color: '#744210', label: '🟡 Good' },
  fair:            { bg: '#FEEBC8', color: '#7B341E', label: '🟠 Fair' },
  'needs-attention': { bg: '#FED7D7', color: '#822727', label: '🔴 Needs Attention' },
};

/**
 * Build the full HTML email string.
 *
 * @param {object} user         { name, email, biz_name, biz_type }
 * @param {object} summary      { revenue, totalExpenses, profit, margin, healthScore, healthKey,
 *                                topExpense, customers, date }
 * @param {object} aiRec        { risk, actions: string[] }
 * @param {Array}  lowStock     Array of inventory rows with low stock
 */
function buildEmailHtml(user, summary, aiRec, lowStock = []) {
  const firstName  = user.name.split(' ')[0];
  const dateStr    = formatDate(summary.date || new Date());
  const profitColor = summary.profit >= 0 ? '#1A7A4A' : '#C53030';
  const health     = HEALTH_STYLES[summary.healthKey] || HEALTH_STYLES['fair'];

  const metricRow = (label, value, color = '#1a202c') => `
    <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;vertical-align:top;width:50%">
      <div style="font-size:11px;color:#718096;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">${label}</div>
      <div style="font-size:20px;font-weight:700;color:${color}">${value}</div>
    </td>`;

  const actionList = (aiRec.actions || []).map((a, i) =>
    `<li style="margin-bottom:10px;line-height:1.6"><strong>${i + 1}.</strong> ${a}</li>`
  ).join('');

  const lowStockSection = lowStock.length > 0 ? `
    <div style="background:#FFF5F5;border:1px solid #FC8181;border-radius:8px;padding:16px;margin:20px 0">
      <div style="font-weight:700;color:#C53030;margin-bottom:10px">⚠️ Low Stock Alert</div>
      ${lowStock.map((item) => `
        <div style="font-size:14px;color:#742A2A;margin-bottom:4px">
          • ${item.item_name}: <strong>${Number(item.current_balance).toLocaleString('en-NG')} units</strong> remaining
        </div>`).join('')}
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BizPulse Daily Summary</title>
</head>
<body style="margin:0;padding:0;background:#F0F4FA;font-family:Arial,sans-serif">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F4FA;padding:20px 0">
<tr><td align="center">
<table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

  <!-- HEADER -->
  <tr>
    <td style="background:linear-gradient(135deg,#0F2744 0%,#1A56A4 100%);padding:28px 24px;text-align:center">
      <div style="font-size:24px;font-weight:700;color:#ffffff;margin-bottom:4px">📊 Daily Business Summary</div>
      <div style="font-size:14px;color:#BEE3F8">${dateStr}</div>
    </td>
  </tr>

  <!-- GREETING -->
  <tr>
    <td style="padding:20px 24px 8px">
      <p style="font-size:16px;color:#2D3748;margin:0">
        Hi <strong>${firstName}</strong> 👋 Here's your business pulse for today.
      </p>
    </td>
  </tr>

  <!-- METRICS GRID -->
  <tr>
    <td style="padding:8px 24px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E2E8F0;border-radius:8px;overflow:hidden">
        <tr>
          ${metricRow('Revenue', formatNaira(summary.revenue), '#1A56A4')}
          ${metricRow('Total Expenses', formatNaira(summary.totalExpenses), '#C53030')}
        </tr>
        <tr>
          ${metricRow('Net Profit', formatNaira(summary.profit), profitColor)}
          ${metricRow('Margin', `${parseFloat(summary.margin).toFixed(1)}%`, '#B7791F')}
        </tr>
        <tr>
          ${metricRow('Customers Served', summary.customers || 0, '#0F2744')}
          ${metricRow('Top Expense', summary.topExpense ? `${summary.topExpense.category}<br><span style="font-size:14px">${formatNaira(summary.topExpense.amount)}</span>` : 'N/A', '#718096')}
        </tr>
      </table>
    </td>
  </tr>

  <!-- HEALTH SCORE -->
  <tr>
    <td style="padding:16px 24px 8px;text-align:center">
      <span style="display:inline-block;background:${health.bg};color:${health.color};padding:6px 18px;border-radius:20px;font-size:13px;font-weight:700">
        Business Health: ${health.label}
      </span>
    </td>
  </tr>

  <!-- LOW STOCK ALERT (conditional) -->
  ${lowStockSection ? `<tr><td style="padding:0 24px">${lowStockSection}</td></tr>` : ''}

  <!-- AI RECOMMENDATION -->
  <tr>
    <td style="padding:16px 24px">
      <div style="border-left:4px solid #1A56A4;background:#EBF8FF;border-radius:0 8px 8px 0;padding:16px">
        <div style="font-size:13px;font-weight:700;color:#1A56A4;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em">
          💡 AI Recommendation
        </div>

        <!-- Risk -->
        <div style="background:#FFF5F5;border:1px solid #FC8181;border-radius:6px;padding:10px 12px;margin-bottom:14px">
          <span style="font-size:12px;font-weight:700;color:#C53030">⚠️ Risk: </span>
          <span style="font-size:14px;color:#742A2A">${aiRec.risk || 'Monitor your margins closely.'}</span>
        </div>

        <!-- Actions -->
        <div style="font-size:13px;font-weight:700;color:#2D3748;margin-bottom:8px">Actions to take:</div>
        <ul style="margin:0;padding-left:18px;color:#4A5568;font-size:14px">
          ${actionList}
        </ul>
      </div>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#F7FAFC;padding:20px 24px;text-align:center;border-top:1px solid #E2E8F0">
      <p style="font-size:13px;color:#718096;margin:0 0 8px">
        Keep going ${firstName}! Every naira tracked brings you closer to your goals. 🚀
      </p>
      <p style="font-size:11px;color:#A0AEC0;margin:0">
        BizPulse · Your WhatsApp Financial OS · Unsubscribe
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Send the daily summary email.
 *
 * @param {object} user     Full user record
 * @param {object} summary  Aggregated summary data
 * @param {object} aiRec    { risk, actions }
 * @param {Array}  lowStock Low-stock inventory items
 */
async function sendSummaryEmail(user, summary, aiRec, lowStock = []) {
  if (!process.env.BREVO_API_KEY) {
    console.log(`[Email DEV] Would send summary to ${user.email} — set BREVO_API_KEY to enable`);
    return { status: 'dev_mode' };
  }

  const firstName = user.name.split(' ')[0];
  const dateStr   = formatDate(summary.date || new Date());
  const html      = buildEmailHtml(user, summary, aiRec, lowStock);
  const fromEmail = process.env.BREVO_FROM_EMAIL || process.env.GMAIL_USER;

  const res = await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender:      { name: 'BizPulse', email: fromEmail },
      to:          [{ email: user.email, name: user.name }],
      subject:     `📊 ${firstName}, your BizPulse summary for ${dateStr}`,
      htmlContent: html,
    },
    {
      headers: {
        'api-key':      process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );

  console.log(`[Email] Sent to ${user.email} via Brevo — ID: ${res.data.messageId}`);
  return res.data;
}

module.exports = { sendSummaryEmail, buildEmailHtml };
