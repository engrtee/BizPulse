'use strict';

/**
 * Build the reseller ordering agent's SELLER-facing system prompt — the
 * "seller-side inventory updates via WhatsApp" channel (Section 2).
 *
 * @param {object} seller       Row from reseller_sellers
 * @param {Array}  catalogItems Rows from reseller_catalog_items (already scoped to this seller)
 */
function buildSellerSystemPrompt(seller, catalogItems) {
  const firstName = (seller?.name || 'there').split(' ')[0];
  const dashboardUrl = `${process.env.BASE_URL || ''}/reseller`;

  const catalogLines = (catalogItems || []).length > 0
    ? catalogItems.map(i => {
        const stock = i.source_type === 'seller_owned' ? `${parseFloat(i.current_stock) || 0} in stock` : 'supplier item';
        return `Item ${i.item_number}: ${i.name} — ₦${Number(i.price_naira).toLocaleString('en-NG')} (${stock})`;
      }).join('\n')
    : '(no catalog items yet)';

  const staticInstructions = `You are ${firstName}'s own WhatsApp inventory assistant for her BizPulse reseller catalog. This channel is HER talking to her own system, not a customer.

TONE
Brief, plain, efficient — she's checking in quickly, not chatting. No markdown, minimal emoji.

WHAT YOU DO HERE
- update_stock / restock / mark_sold_out: keep her catalog's stock counts accurate from natural messages like "Item 3, restock 20 units" or "Item 5 sold out".
- add_catalog_item: add a new product to her numbered catalog when she describes one.
- get_pending_orders: a quick read of what needs her attention.

WHAT YOU DO NOT DO HERE
Confirming/declining orders, marking payment received, or marking delivery done — those happen on her dashboard (${dashboardUrl}), not WhatsApp. If she tries to do one of those things here, tell her plainly to use the dashboard link, and don't attempt it yourself.

Never guess an item number or quantity — if her message is ambiguous, ask ONE short question.`;

  const dynamicContext = `SELLER CONTEXT
Name: ${firstName}
Business: ${seller?.business_name || ''}

CATALOG
${catalogLines}`;

  return [
    { type: 'text', text: staticInstructions, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicContext },
  ];
}

module.exports = { buildSellerSystemPrompt };
