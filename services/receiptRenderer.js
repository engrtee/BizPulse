/**
 * services/receiptRenderer.js
 * Batch 2 — renders a receipt as a PNG image using Satori (plain-object
 * layout tree → SVG) + @resvg/resvg-js (SVG → PNG). No headless browser —
 * both ship prebuilt binaries, a light footprint for a small Render.com
 * web service.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const satori = require('satori').default;
const { Resvg } = require('@resvg/resvg-js');

const COLORS = {
  navy:   '#0F2744',
  blue:   '#1A56A4',
  green:  '#1A7A4A',
  gold:   '#B7791F',
  bg:     '#F0F4FA',
  card:   '#FFFFFF',
  muted:  '#718096',
  border: '#E2E8F0',
};

const WIDTH = 600;
const ITEM_ROW_HEIGHT = 44;
const BASE_HEIGHT = 320; // header + date + total + footer, before item rows

let fontsPromise = null;
function loadFonts() {
  if (!fontsPromise) {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p));
    fontsPromise = Promise.resolve([
      { name: 'DM Sans', data: read('node_modules/@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff'), weight: 400, style: 'normal' },
      { name: 'DM Sans', data: read('node_modules/@fontsource/dm-sans/files/dm-sans-latin-700-normal.woff'), weight: 700, style: 'normal' },
      { name: 'DM Serif Display', data: read('node_modules/@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff'), weight: 400, style: 'normal' },
      // Fallback for glyphs DM Sans/DM Serif's Fontsource subsets don't cover —
      // notably the Naira sign (U+20A6, Currency Symbols block), which is
      // missing from every narrowly-subsetted Google-Fonts family tested
      // (DM Sans, Noto Sans, Noto Sans Symbols, Roboto). Registered last:
      // Satori tries fonts in order and falls through to the next one for
      // any glyph the earlier fonts lack, so DM Sans/DM Serif still render
      // everywhere they can and this only kicks in for ₦.
      { name: 'DejaVu Sans', data: read('node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf'), weight: 400, style: 'normal' },
    ]);
  }
  return fontsPromise;
}

function fmt(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG');
}

function row(children, style = {}) {
  return { type: 'div', props: { style: { display: 'flex', flexDirection: 'row', ...style }, children } };
}

function col(children, style = {}) {
  return { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', ...style }, children } };
}

function text(value, style = {}) {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children: String(value) } };
}

/**
 * @param {object} data
 * @param {string} data.shopName
 * @param {number} data.sequenceNumber
 * @param {string} [data.customerName]
 * @param {Array<{product:string, quantity:number, unit_price:number}>} data.items
 * @param {number} data.totalAmount
 * @param {'cash'|'credit'} data.paymentMethod
 * @param {string} data.dateLabel
 * @returns {Promise<Buffer>} PNG buffer
 */
async function renderReceiptPng({ shopName, sequenceNumber, customerName, items, totalAmount, paymentMethod, dateLabel }) {
  const fonts = await loadFonts();
  const height = BASE_HEIGHT + (items.length * ITEM_ROW_HEIGHT);
  const isCredit = paymentMethod === 'credit';

  const itemRows = items.map((it) =>
    row([
      text(it.product, { flex: 1, fontSize: 18, color: COLORS.navy }),
      text(`${it.quantity} × ${fmt(it.unit_price)}`, { fontSize: 16, color: COLORS.muted, marginRight: 16 }),
      text(fmt(it.quantity * it.unit_price), { fontSize: 18, color: COLORS.navy, fontWeight: 700, width: 110, justifyContent: 'flex-end' }),
    ], {
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 0',
      borderBottom: `1px solid ${COLORS.border}`,
    })
  );

  const tree = col([
    // Header
    col([
      text(shopName || 'Receipt', { fontSize: 30, color: COLORS.card, fontFamily: 'DM Serif Display' }),
      text(`Receipt #${String(sequenceNumber).padStart(4, '0')}`, { fontSize: 16, color: COLORS.card, marginTop: 6, opacity: 0.85 }),
    ], { backgroundColor: COLORS.navy, padding: '28px 32px' }),

    // Body
    col([
      row([
        text(dateLabel, { fontSize: 15, color: COLORS.muted }),
        customerName
          ? text(`For: ${customerName}`, { fontSize: 15, color: COLORS.muted })
          : text('', {}),
      ], { justifyContent: 'space-between', marginBottom: 8 }),

      col(itemRows, { marginTop: 12 }),

      row([
        text('Total', { fontSize: 20, color: COLORS.navy, fontWeight: 700 }),
        text(fmt(totalAmount), { fontSize: 24, color: COLORS.navy, fontWeight: 700 }),
      ], { justifyContent: 'space-between', alignItems: 'center', marginTop: 20, paddingTop: 16, borderTop: `2px solid ${COLORS.navy}` }),

      row([
        text(isCredit ? 'ON CREDIT' : 'PAID — CASH', {
          fontSize: 14,
          fontWeight: 700,
          color: COLORS.card,
          backgroundColor: isCredit ? COLORS.gold : COLORS.green,
          padding: '6px 14px',
          borderRadius: 6,
        }),
      ], { marginTop: 18 }),
    ], { padding: '24px 32px', flex: 1 }),

    // Footer
    row([
      text('via BizPulse — your WhatsApp business tracker', { fontSize: 13, color: COLORS.muted }),
    ], { justifyContent: 'center', padding: '14px 0', borderTop: `1px solid ${COLORS.border}` }),
  ], { width: WIDTH, height, backgroundColor: COLORS.card, fontFamily: 'DM Sans, DejaVu Sans' });

  const svg = await satori(tree, { width: WIDTH, height, fonts });

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } });
  const pngData = resvg.render();
  return pngData.asPng();
}

module.exports = { renderReceiptPng };
