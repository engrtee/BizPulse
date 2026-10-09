/**
 * services/sheets/messages.js
 * Plain WhatsApp copy for Sheets mode pushes (morning stock, night recap, sold alerts).
 * Deterministic on purpose — every number comes straight from the sheet, no AI narration to drift.
 */

'use strict';

const naira = (n) => '₦' + Math.round(n || 0).toLocaleString('en-NG');
const num = (n) => Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 });

function stockLine(s) {
  const icon = s.status === 'out' ? '🔴' : s.status === 'low' ? '🟡' : '🟢';
  const cover = s.status === 'low' && s.daysCover != null ? ` (~${Math.max(1, Math.round(s.daysCover))} day${s.daysCover > 1.5 ? 's' : ''} left)` : '';
  return `${icon} ${s.item}: ${num(s.quantity)}${cover}`;
}

/** Full stock list, problems first. Capped so it still fits one WhatsApp message. */
function stockList(stock, max = 25) {
  const order = { out: 0, low: 1, ok: 2 };
  const sorted = [...stock].sort((a, b) => order[a.status] - order[b.status] || a.item.localeCompare(b.item));
  const lines = sorted.slice(0, max).map(stockLine);
  if (sorted.length > max) lines.push(`…and ${sorted.length - max} more items`);
  return lines.join('\n');
}

function morningMessage(firstName, stock) {
  if (!stock.length) return `Good morning ${firstName} ☀️ I can't see any items in your sheet yet.`;
  const out = stock.filter(s => s.status === 'out').length;
  const low = stock.filter(s => s.status === 'low').length;
  const head = out || low
    ? `Good morning ${firstName} ☀️ ${out ? `${out} finished` : ''}${out && low ? ', ' : ''}${low ? `${low} running low` : ''}.`
    : `Good morning ${firstName} ☀️ Everything is well stocked.`;
  return `${head}\n\n${stockList(stock)}`;
}

function nightMessage(firstName, summary, stock) {
  if (!summary.sales_count) {
    return `Good evening ${firstName} 🌙 No sales were entered in your sheet today.` +
      (stock.some(s => s.status !== 'ok') ? `\n\nStock to watch:\n${stockList(stock.filter(s => s.status !== 'ok'), 10)}` : '');
  }
  const top = summary.top_items.slice(0, 3).map(t => `• ${num(t.units)} × ${t.item}`).join('\n');
  const watch = stock.filter(s => s.status !== 'ok');
  let msg = `Good evening ${firstName} 🌙 Today your sheet shows ${naira(summary.revenue)} from ${summary.sales_count} sale${summary.sales_count > 1 ? 's' : ''} (${num(summary.units_sold)} items).`;
  if (summary.sales_missing_amounts) msg += `\n(${summary.sales_missing_amounts} sale row${summary.sales_missing_amounts > 1 ? 's have' : ' has'} no price, so that total may be low.)`;
  msg += `\n\nSelling most:\n${top}`;
  if (watch.length) msg += `\n\nStock to watch:\n${stockList(watch, 10)}`;
  return msg;
}

/** newSales: [{item, quantity, total}], stockByKey lookup done by the caller. */
function soldAlert(newSales, stockAfter) {
  const grouped = new Map();
  for (const s of newSales) {
    const g = grouped.get(s.item.toLowerCase()) || { item: s.item, qty: 0, total: 0 };
    g.qty += s.quantity; g.total += s.total || 0;
    grouped.set(s.item.toLowerCase(), g);
  }
  const lines = [...grouped.values()].slice(0, 6).map(g => {
    const left = stockAfter.find(x => x.item.toLowerCase() === g.item.toLowerCase());
    const tail = !left ? '' : left.status === 'out' ? ' — now finished 🔴' : ` — ${num(left.quantity)} left${left.status === 'low' ? ' 🟡' : ''}`;
    return `• ${num(g.qty)} × ${g.item}${g.total ? ` (${naira(g.total)})` : ''}${tail}`;
  });
  const more = grouped.size > 6 ? `\n…and ${grouped.size - 6} more` : '';
  return `🛒 Just sold:\n${lines.join('\n')}${more}`;
}

module.exports = { morningMessage, nightMessage, soldAlert, stockList, naira };
