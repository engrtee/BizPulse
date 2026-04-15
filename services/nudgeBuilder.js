/**
 * services/nudgeBuilder.js
 *
 * Builds personalised retention nudge messages using business persona data.
 *
 * Format rotation by total log days:
 *   Days 1–7:   rotate B → A → B → A …
 *   Days 8–21:  rotate A → C → A → C …
 *   Days 22+:   rotate C → D → C → D …
 *
 * Format B and Format D include an AI coaching prompt line
 * (per user request: "for some days, indicate they can ask any question from the AI tool")
 */

'use strict';

const { query } = require('../models/db');

// ── Nigerian currency short formatter ─────────────────────────────────────
function nairaShort(amount) {
  const n = parseFloat(amount) || 0;
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 1_000)     return `₦${Math.round(n / 1_000)}k`;
  return `₦${Math.round(n)}`;
}

// ── Format rotation logic ─────────────────────────────────────────────────
/**
 * Given total log days and the last format used, pick the next format.
 * Never repeats the same format twice in a row.
 */
function selectFormat(totalLogDays, lastFormat) {
  let pool;
  if (totalLogDays <= 7)       pool = ['B', 'A'];
  else if (totalLogDays <= 21) pool = ['A', 'C'];
  else                         pool = ['C', 'D'];

  // Use first in pool unless that's what was last sent — then use second
  if (lastFormat === pool[0]) return pool[1];
  return pool[0];
}

/**
 * Get the last format sent for this user + message type from message_log.
 * Returns null if the user has never received this type.
 */
async function getLastFormat(userId, messageType) {
  const res = await query(
    `SELECT variant_name FROM message_log
     WHERE user_id = $1 AND message_type = $2
     ORDER BY sent_at DESC LIMIT 1`,
    [userId, messageType]
  );
  return res.rows[0]?.variant_name || null;
}

// ── Business-type-aware benefit footer ───────────────────────────────────
function buildFooter(persona) {
  const identity = persona.craft_identity || 'a Nigerian business owner building something real';
  const metric   = persona.key_metric     || 'daily profit';
  return (
    `———\n` +
    `BizPulse tracks your *${metric}* automatically.\n` +
    `Every entry brings you closer to becoming ${identity}. 📊`
  );
}

// ── AI coaching prompt line (Format B and D only) ─────────────────────────
const AI_COACHING_LINE =
  `💬 *Did you know?* You can ask BizPulse any business question — ` +
  `pricing strategy, expense control, growth tips. Just send your question and ` +
  `our AI coach will answer. Try: _"how do I improve my profit margin?"_`;

// ── FORMAT A — Loss aversion ──────────────────────────────────────────────
// Best for: users who have logged 8–21 days (they understand the value, need urgency)
function buildFormatA(firstName, persona, daysInactive) {
  const emoji    = persona.craft_emoji    || '📊';
  const loanCase = persona.loan_use_case  || 'invest in growth when the time is right';
  const exAmt    = nairaShort(persona.example_amount || 30000);
  const exExp    = nairaShort((persona.example_amount || 30000) * 0.3);
  const exItem   = persona.example_expense || 'operations';
  const example  = `made ${exAmt} today spent ${exExp} on ${exItem}`;

  return (
    `${firstName} 🔔\n\n` +
    `We do not want you to lose the chance to *${loanCase}* when the time is right.\n\n` +
    `Every day without data makes that conversation harder. Every day with it makes it easier.\n\n` +
    `You have been away for ${daysInactive} day${daysInactive > 1 ? 's' : ''}. ` +
    `That is ${daysInactive} gap${daysInactive > 1 ? 's' : ''} in your financial record.\n\n` +
    `Just send today's numbers:\n` +
    `_"${example}"_\n\n` +
    `30 seconds. That is all we need. ${emoji}\n\n` +
    buildFooter(persona)
  );
}

// ── FORMAT B — Identity permission ───────────────────────────────────────
// Best for: new users (1–7 days) — they are still finding their identity with the product
function buildFormatB(firstName, persona, daysInactive) {
  const emoji    = persona.craft_emoji    || '📊';
  const identity = persona.craft_identity || 'a Nigerian business owner building something real';
  const dream    = persona.dream_outcome  || 'a business with consistent profit and clear records';
  const exAmt    = nairaShort(persona.example_amount || 30000);
  const exExp    = nairaShort((persona.example_amount || 30000) * 0.3);
  const exItem   = persona.example_expense || 'operations';
  const example  = `made ${exAmt} today spent ${exExp} on ${exItem}`;

  return (
    `${firstName} ${emoji}\n\n` +
    `You are on your way to becoming *${identity}*.\n\n` +
    `Focus on your craft. Let BizPulse handle the financial picture.\n\n` +
    `We just need one thing from you today — your numbers. Send:\n` +
    `_"${example}"_\n\n` +
    `That is it. We handle everything else.\n` +
    `Your future — *${dream}* — starts with today's entry. 💪\n\n` +
    `${AI_COACHING_LINE}\n\n` +
    buildFooter(persona)
  );
}

// ── FORMAT C — Future milestone ───────────────────────────────────────────
// Best for: engaged users (8–21+ days) who have a clear picture of their journey
function buildFormatC(firstName, persona, daysInactive) {
  const emoji   = persona.craft_emoji   || '📊';
  const dream   = persona.dream_outcome || 'a business with consistent profit and clear records';
  const season  = persona.peak_season   || 'festive seasons';
  const exAmt   = nairaShort(persona.example_amount || 30000);
  const exExp   = nairaShort((persona.example_amount || 30000) * 0.3);
  const exItem  = persona.example_expense || 'operations';
  const example = `made ${exAmt} today spent ${exExp} on ${exItem}`;

  return (
    `${firstName} ${emoji}\n\n` +
    `Imagine walking into a bank with 90 days of clean records showing exactly what your business earns.\n\n` +
    `That is the path to: *${dream}*.\n\n` +
    `${season} will come — and when it does, the businesses with the clearest records are the ones ` +
    `who get the capital to take advantage of it.\n\n` +
    `You have been away for ${daysInactive} day${daysInactive > 1 ? 's' : ''}. Come back today:\n` +
    `_"${example}"_\n\n` +
    `One entry reopens your record. 📈\n\n` +
    buildFooter(persona)
  );
}

// ── FORMAT D — Peer comparison + AI coaching ──────────────────────────────
// Best for: power users (22+ days) who respond to competitive framing
function buildFormatD(firstName, persona, daysInactive) {
  const emoji   = persona.craft_emoji   || '📊';
  const bizType = persona.business_type || 'business';
  const metric  = persona.key_metric    || 'daily profit';
  const exAmt   = nairaShort(persona.example_amount || 30000);
  const exExp   = nairaShort((persona.example_amount || 30000) * 0.3);
  const exItem  = persona.example_expense || 'operations';
  const example = `made ${exAmt} today spent ${exExp} on ${exItem}`;

  return (
    `${firstName} ${emoji}\n\n` +
    `Right now, other *${bizType}* owners on BizPulse are tracking their *${metric}* every single day.\n\n` +
    `They know exactly which weeks were profitable, which expenses are climbing, ` +
    `and what to do before their next busy season.\n\n` +
    `You had that edge too — until ${daysInactive} day${daysInactive > 1 ? 's' : ''} ago.\n\n` +
    `Get back in. Send your numbers:\n` +
    `_"${example}"_\n\n` +
    `${AI_COACHING_LINE}\n\n` +
    buildFooter(persona)
  );
}

// ── Main builder ──────────────────────────────────────────────────────────
/**
 * Build the personalised nudge message for a user.
 *
 * @param {object} user         - user row (name, biz_type, state, etc.)
 * @param {object} persona      - from personaEngine.getPersona()
 * @param {number} daysInactive - how many days since last entry
 * @param {number} totalLogDays - total distinct days user has ever logged
 * @param {string} messageType  - e.g. 'retention_day3'
 * @returns {{ text: string, format: string }}
 */
async function buildNudgeMessage(user, persona, daysInactive, totalLogDays, messageType) {
  const firstName  = (user.name || 'there').split(' ')[0];
  const lastFormat = await getLastFormat(user.id, messageType);
  const format     = selectFormat(totalLogDays, lastFormat);

  let text;
  switch (format) {
    case 'A': text = buildFormatA(firstName, persona, daysInactive); break;
    case 'B': text = buildFormatB(firstName, persona, daysInactive); break;
    case 'C': text = buildFormatC(firstName, persona, daysInactive); break;
    case 'D': text = buildFormatD(firstName, persona, daysInactive); break;
    default:  text = buildFormatA(firstName, persona, daysInactive);
  }

  return { text, format };
}

module.exports = { buildNudgeMessage, selectFormat, nairaShort };
