'use strict';

/**
 * services/learningService.js
 *
 * Crowdsourced vocabulary learning system.
 *
 * Flow:
 *   1. User hits EDIT on a confirmation → pending entry marked 'edited'
 *   2. User resends corrected message → new pending entry saved
 *   3. User confirms YES on corrected message → recordCorrection() fires
 *   4. extractCorrectionSignal() compares before/after parse to find what changed
 *   5. checkAndPromote() counts unique users + states for that phrase
 *   6. Threshold met → phrase promoted to 'active' in learned_phrases
 *   7. getLearnedContext() injects active phrases into every Gemini call
 *
 * Thresholds (tiered by risk):
 *   product_variant  — 5 users, 3 states → auto-promote (low risk: vocabulary only)
 *   phrase_intent    — 10 users, 4 states → auto-promote (medium risk: affects parsing)
 *   intent_change    — always pending_review (high risk: full admin approval required)
 */

const { query } = require('../models/db');

// ── Promotion thresholds ──────────────────────────────────────────────────────
const THRESHOLDS = {
  product_variant: { users: 5,  states: 3, autoPromote: true  },
  phrase_intent:   { users: 10, states: 4, autoPromote: true  },
  intent_change:   { users: 0,  states: 0, autoPromote: false }, // always manual review
};

// ── Common words to ignore when extracting key phrases ───────────────────────
const COMMON_WORDS = new Set([
  'i','me','my','we','our','you','your','the','a','an','is','was','are','were',
  'be','been','have','has','had','do','did','does','to','of','and','or','in',
  'on','at','for','with','from','by','sell','sold','buy','bought','stock','price',
  'today','yesterday','morning','naira','each','total','bag','tin','crate','packet',
  'sachet','piece','customer','pay','paid','cash','credit','update','new','last',
  'this','how','many','much','what','when','where','which','just','only','get',
  'got','give','take','come','go','send','make','made','see','can','will','would',
  'should','please','now','then','still','that','him','her','them','their','its',
]);

// ── Extract the key phrase that caused a misparse ─────────────────────────────
function extractKeyPhrase(message) {
  const words = (message || '')
    .toLowerCase()
    .replace(/[₦\d,\.]/g, ' ')
    .replace(/\bk\b/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !COMMON_WORDS.has(w) && /^[a-z]+$/.test(w));
  return words.slice(0, 2).join(' ') || message.slice(0, 40);
}

// ── Compare two parses and return a correction signal ────────────────────────
function extractCorrectionSignal(originalEntry, confirmedEntry) {
  const origData = typeof originalEntry.data === 'string'
    ? JSON.parse(originalEntry.data) : (originalEntry.data || {});
  const confData = typeof confirmedEntry.data === 'string'
    ? JSON.parse(confirmedEntry.data) : (confirmedEntry.data || {});

  // ── Case 1: Product name changed → product_variant ──
  const origProds = origData.products || [];
  const confProds = confData.products || [];

  for (let i = 0; i < Math.min(origProds.length, confProds.length); i++) {
    const origName = (origProds[i]?.product_name || '').toLowerCase().trim();
    const confName = (confProds[i]?.product_name || '').toLowerCase().trim();
    if (origName && confName && origName !== confName && origName.length >= 2) {
      return {
        phrase_key: origName,
        learn_type: 'product_variant',
        maps_to:    confProds[i].product_name,
      };
    }
  }

  // Flat item field (inventory_in / inventory_out)
  const origItem = (origData.item || '').toLowerCase().trim();
  const confItem = (confData.item || '').toLowerCase().trim();
  if (origItem && confItem && origItem !== confItem && origItem.length >= 2) {
    return {
      phrase_key: origItem,
      learn_type: 'product_variant',
      maps_to:    confData.item,
    };
  }

  // ── Case 2: Entry type changed → intent_change (manual review) ──
  if (originalEntry.type && confirmedEntry.type && originalEntry.type !== confirmedEntry.type) {
    const phraseKey = extractKeyPhrase(originalEntry.message || '');
    return {
      phrase_key: phraseKey || (originalEntry.message || '').slice(0, 50),
      learn_type: 'intent_change',
      maps_to:    `"${originalEntry.type}" → "${confirmedEntry.type}"`,
    };
  }

  // ── Case 3: Revenue significantly wrong → phrase_intent ──
  const origRev = parseFloat(origData.revenue) || 0;
  const confRev = parseFloat(confData.revenue) || 0;
  if (Math.abs(origRev - confRev) > 500) {
    const phraseKey = extractKeyPhrase(originalEntry.message || '');
    if (phraseKey) {
      return {
        phrase_key: phraseKey,
        learn_type: 'phrase_intent',
        maps_to:    `Revenue misread as ₦${origRev.toLocaleString('en-NG')} — correct: ₦${confRev.toLocaleString('en-NG')}`,
      };
    }
  }

  return null;
}

// ── Record a correction and check promotion threshold ────────────────────────
async function recordCorrection(userId, userState, originalEntry, confirmedEntry) {
  try {
    const signal = extractCorrectionSignal(originalEntry, confirmedEntry);
    if (!signal) return;

    const { phrase_key, learn_type, maps_to } = signal;
    if (!phrase_key || !learn_type) return;

    await query(
      `INSERT INTO parse_corrections
         (user_id, user_state, original_message, original_type, original_parsed_data,
          corrected_message, corrected_type, corrected_parsed_data, phrase_key, learn_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        userId,
        userState || null,
        originalEntry.message,
        originalEntry.type,
        JSON.stringify(originalEntry.data || {}),
        confirmedEntry.message,
        confirmedEntry.type,
        JSON.stringify(confirmedEntry.data || {}),
        phrase_key,
        learn_type,
      ]
    );

    console.log(`[Learning] 📝 Correction: "${phrase_key}" (${learn_type})`);
    await checkAndPromote(phrase_key, learn_type, maps_to, originalEntry.message);
  } catch (err) {
    console.error('[Learning] recordCorrection error:', err.message);
  }
}

// ── Check thresholds and upsert into learned_phrases ─────────────────────────
async function checkAndPromote(phraseKey, learnType, mapsTo, exampleMessage) {
  const threshold = THRESHOLDS[learnType];
  if (!threshold) return;

  const res = await query(
    `SELECT
       COUNT(DISTINCT user_id)::int                                           AS users,
       COUNT(DISTINCT user_state) FILTER (WHERE user_state IS NOT NULL)::int  AS states,
       COUNT(*)::int                                                           AS total
     FROM parse_corrections
     WHERE phrase_key = $1 AND learn_type = $2`,
    [phraseKey, learnType]
  );

  const { users, states, total } = res.rows[0];

  const meetsThreshold = threshold.autoPromote
    && users  >= threshold.users
    && states >= threshold.states;

  // Surface for admin awareness once 2+ users have the same correction
  const targetStatus = meetsThreshold ? 'active'
    : users >= 2          ? 'pending_review'
    : null;

  if (!targetStatus) return;

  await query(
    `INSERT INTO learned_phrases
       (phrase_key, learn_type, maps_to, correction_count, unique_users, unique_states,
        status, example_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (phrase_key, learn_type) DO UPDATE SET
       correction_count = EXCLUDED.correction_count,
       unique_users     = EXCLUDED.unique_users,
       unique_states    = EXCLUDED.unique_states,
       -- Never downgrade an already-active or rejected phrase
       status = CASE
         WHEN learned_phrases.status IN ('active','rejected') THEN learned_phrases.status
         ELSE EXCLUDED.status
       END,
       updated_at = NOW()`,
    [phraseKey, learnType, mapsTo, total, users, states, targetStatus, exampleMessage]
  );

  if (targetStatus === 'active') {
    learnedContextCache = null;
    console.log(`[Learning] ✅ Auto-promoted: "${phraseKey}" → "${mapsTo}" (${users} users, ${states} states)`);
  } else {
    console.log(`[Learning] 🔍 Flagged for admin review: "${phraseKey}" (${users} users)`);
  }
}

// ── Gemini context cache (invalidated on promotion) ───────────────────────────
let learnedContextCache    = null;
let learnedContextCacheAt  = 0;
const CACHE_TTL_MS         = 5 * 60 * 1000; // 5 minutes

async function getLearnedContext() {
  if (learnedContextCache && Date.now() - learnedContextCacheAt < CACHE_TTL_MS) {
    return learnedContextCache;
  }

  try {
    const res = await query(
      `SELECT phrase_key, learn_type, maps_to, unique_users
       FROM learned_phrases
       WHERE status = 'active'
       ORDER BY correction_count DESC
       LIMIT 100`
    );

    if (!res.rows.length) {
      learnedContextCache   = '';
      learnedContextCacheAt = Date.now();
      return '';
    }

    const variants = res.rows.filter(r => r.learn_type === 'product_variant');
    const phrases  = res.rows.filter(r => r.learn_type !== 'product_variant');

    const lines = ['\nCROWDSOURCED CORRECTIONS (verified by multiple Nigerian users — apply these with confidence):'];

    if (variants.length) {
      lines.push('Product name variants:');
      variants.forEach(r =>
        lines.push(`- "${r.phrase_key}" = "${r.maps_to}" (confirmed by ${r.unique_users}+ users)`)
      );
    }

    if (phrases.length) {
      lines.push('Phrase patterns:');
      phrases.forEach(r =>
        lines.push(`- "${r.phrase_key}": ${r.maps_to} (confirmed by ${r.unique_users}+ users)`)
      );
    }

    learnedContextCache   = lines.join('\n');
    learnedContextCacheAt = Date.now();
    return learnedContextCache;
  } catch (err) {
    console.error('[Learning] getLearnedContext error:', err.message);
    return '';
  }
}

// ── Admin: get pending reviews ────────────────────────────────────────────────
async function getPendingReviews() {
  const res = await query(
    `SELECT
       lp.*,
       (SELECT json_agg(j ORDER BY j->>'at' DESC)
        FROM (
          SELECT json_build_object(
            'message', pc.original_message,
            'state',   pc.user_state,
            'at',      pc.created_at
          ) AS j
          FROM parse_corrections pc
          WHERE pc.phrase_key = lp.phrase_key AND pc.learn_type = lp.learn_type
          LIMIT 5
        ) sub
       ) AS examples
     FROM learned_phrases lp
     WHERE lp.status = 'pending_review'
     ORDER BY lp.correction_count DESC`
  );
  return res.rows;
}

// ── Admin: overall stats ──────────────────────────────────────────────────────
async function getLearningStats() {
  const res = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active')         AS active_count,
       COUNT(*) FILTER (WHERE status = 'pending_review') AS pending_count,
       COUNT(*) FILTER (WHERE status = 'rejected')       AS rejected_count,
       (SELECT COUNT(*)::int FROM parse_corrections)      AS total_corrections
     FROM learned_phrases`
  );
  return res.rows[0];
}

// ── Admin: get active phrases (for display) ───────────────────────────────────
async function getActivePhrases() {
  const res = await query(
    `SELECT * FROM learned_phrases
     WHERE status = 'active'
     ORDER BY learn_type, correction_count DESC`
  );
  return res.rows;
}

// ── Admin: approve / reject ───────────────────────────────────────────────────
async function approvePhrase(phraseId) {
  await query(
    `UPDATE learned_phrases SET status = 'active', updated_at = NOW() WHERE id = $1`,
    [phraseId]
  );
  learnedContextCache = null;
}

async function rejectPhrase(phraseId) {
  await query(
    `UPDATE learned_phrases SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
    [phraseId]
  );
}

module.exports = {
  recordCorrection,
  getLearnedContext,
  getPendingReviews,
  getLearningStats,
  getActivePhrases,
  approvePhrase,
  rejectPhrase,
};
