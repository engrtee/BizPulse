/**
 * services/personaEngine.js
 *
 * Looks up or generates a business persona for any user.
 *
 * Flow:
 *   1. Pattern-match the user's biz_type against 9 hardcoded types
 *   2. If matched, fetch from business_personas table
 *   3. If no match, call Claude API to generate a custom persona
 *   4. Save generated persona to DB — never generated twice for same type
 *   5. Fallback to a safe generic persona if everything fails
 */

'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../models/db');

const client = new Anthropic();

// ── Pattern matching — maps user free-text to canonical DB keys ──────────
function matchKnownType(bizType) {
  const t = (bizType || '').toLowerCase();
  if (/fashion|cloth|sewing|tailor|ankara|fabric|garment|design.*wear/i.test(t))                      return 'Fashion';
  if (/food|restaurant|bakery|catering|cook|buka|canteen|snack|pepper\s*soup|zobo|kunu|pure\s*water|sachet\s*water|pastry|cake|caterer|kitchen|eatery/i.test(t)) return 'Food';
  if (/photo/i.test(t))                                                                               return 'Photography';
  if (/retail|shop|trading|fmcg|supermarket|provisions|store|market\s*seller/i.test(t))              return 'Retail';
  if (/online|e-?commerce|whatsapp\s*business|digital\s*market/i.test(t))                            return 'Online Business';
  if (/beauty|hair|nail|makeup|salon|spa|barb|wig|lace|natural\s*hair|braid|cosmetic/i.test(t))     return 'Beauty';
  if (/farm|agri|crop|livestock|harvest|poultry|fish\s*pond|plantation/i.test(t))                   return 'Agricultural';
  if (/manufactur|production|factory|assembly/i.test(t))                                             return 'Manufacturing';
  return null; // no match — Claude generates
}

// ── Main entry point ─────────────────────────────────────────────────────
async function getPersona(user) {
  const bizType = (user.biz_type || '').trim();
  if (!bizType) return buildFallback(bizType);

  try {
    // 1. Try pattern-match to a known hardcoded type
    const knownType = matchKnownType(bizType);
    if (knownType) {
      const res = await query('SELECT * FROM business_personas WHERE business_type = $1 LIMIT 1', [knownType]);
      if (res.rows.length) return res.rows[0];
    }

    // 2. Try exact match (catches previously Claude-generated personas)
    const exactRes = await query(
      'SELECT * FROM business_personas WHERE LOWER(business_type) = LOWER($1) LIMIT 1',
      [bizType]
    );
    if (exactRes.rows.length) return exactRes.rows[0];

    // 3. Generate with Claude and save
    return await generateAndSave(user);
  } catch (err) {
    console.error('[PersonaEngine] getPersona error:', err.message);
    return buildFallback(bizType);
  }
}

// ── Claude persona generation ─────────────────────────────────────────────
async function generateAndSave(user) {
  const bizInfo = [user.biz_type, user.biz_name].filter(Boolean).join(' — ');
  console.log(`[PersonaEngine] Generating persona for: ${bizInfo}`);

  const systemPrompt = `You are a business persona generator for BizPulse, a Nigerian financial tracking app for SMEs. Given any Nigerian business type, you generate a persona object in valid JSON only. No explanation. No markdown. JSON only. Always write in the context of Nigerian markets, culture, and economic realities.`;

  const userPrompt = `Generate a BizPulse persona for this Nigerian business: ${bizInfo}

Return exactly this JSON (no other text):
{
  "business_type": "${user.biz_type}",
  "craft_identity": "aspirational identity — who they are becoming in their field, specific to their craft, written as 'one of Nigeria's...' or 'the [role] everyone recommends'",
  "craft_emoji": "single most relevant emoji",
  "dream_outcome": "specific tangible dream for this business type in Nigerian context — e.g. 'your own dispatch company with a fleet of riders'",
  "loan_use_case": "specific realistic reason this business type needs a loan — equipment, stock, expansion, staff, tools",
  "peak_season": "when this business is busiest in Nigeria — be specific e.g. 'December and Sallah period' or 'wedding season April-June'",
  "key_metric": "single most important financial metric for this business — e.g. 'cost per job', 'revenue per client', 'margin per unit'",
  "example_amount": 30000,
  "example_expense": "most common daily expense for this business type — one or two words e.g. 'spare parts', 'data bundles', 'raw materials'"
}`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = message.content[0]?.text?.trim() || '{}';
    // Strip any accidental markdown fencing
    const jsonText = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
    const persona = JSON.parse(jsonText);

    // Save to DB so next user with same type gets it instantly
    await query(
      `INSERT INTO business_personas
         (business_type, craft_identity, craft_emoji, dream_outcome, loan_use_case, peak_season, key_metric, example_amount, example_expense)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (business_type) DO NOTHING`,
      [
        persona.business_type || user.biz_type,
        persona.craft_identity,
        persona.craft_emoji,
        persona.dream_outcome,
        persona.loan_use_case,
        persona.peak_season,
        persona.key_metric,
        parseInt(persona.example_amount, 10) || 30000,
        persona.example_expense,
      ]
    );

    console.log(`[PersonaEngine] ✅ Persona generated and saved for: ${user.biz_type}`);
    return persona;
  } catch (err) {
    console.error('[PersonaEngine] Claude generation failed:', err.message);
    return buildFallback(user.biz_type);
  }
}

// ── Safe fallback — never crashes the calling code ───────────────────────
function buildFallback(bizType) {
  return {
    business_type:   bizType || 'business',
    craft_identity:  'a Nigerian business owner building something real',
    craft_emoji:     '📊',
    dream_outcome:   'a business with consistent profit and clear records',
    loan_use_case:   'invest in growth when the time is right',
    peak_season:     'festive seasons',
    key_metric:      'daily profit',
    example_amount:  30000,
    example_expense: 'operations',
  };
}

module.exports = { getPersona };
