'use strict';

// Zero npm dependencies — every function is hand-rolled.

const { query } = require('../../models/db');

// ── Step 2: Filler words stripped before alias lookup ────────────────────────
const FILLER = new Set([
  'my','the','a','an','some','one','this','that',
  'small','big','large','old','new','plenty','fresh',
  'cold','hot','cooked','raw','local','foreign',
  'tokunbo','fairly','used','bend','down','select',
]);

// ── Step 3: Nigerian trade alias map (applied before stemming) ───────────────
const ALIASES = {
  lappy: 'laptop', lapie: 'laptop',
  fone: 'mobile phone', phone: 'mobile phone',
  omo: 'omo detergent',
  indomie: 'indomie noodles',
  tom: 'tomato', toma: 'tomato', tomatoe: 'tomato',
  pep: 'pepper', rodo: 'scotch bonnet', tata: 'scotch bonnet',
  cray: 'crayfish',
  ponmo: 'cow skin', pomo: 'cow skin', kpomo: 'cow skin',
  stock: 'stockfish',
  egusi: 'melon seeds',
  ogiri: 'fermented locust beans', iru: 'fermented locust beans',
  banga: 'palm fruit',
  garri: 'garri', eba: 'garri',
};

// ── Step 4: Suffix stripping exceptions ─────────────────────────────────────
const SUFFIX_EXCEPTIONS = new Set([
  'gas','bus','dress','glass','class','grass',
  'mass','pass','brass','lass',
]);

// ── Levenshtein distance (manual, no deps) ───────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  // Allocate a flat array instead of 2-D array for speed
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

// ── Step 4: Strip the longest matching suffix ────────────────────────────────
// Tried in longest-first order to avoid partial over-stripping.
const SUFFIXES = ['ing', 'ed', 'er', 'es', 's'];

function stripSuffix(word) {
  if (SUFFIX_EXCEPTIONS.has(word)) return word;
  for (const suf of SUFFIXES) {
    if (word.endsWith(suf) && word.length - suf.length >= 3) {
      return word.slice(0, word.length - suf.length);
    }
  }
  return word;
}

// ── Step 6: Title-case ───────────────────────────────────────────────────────
function toTitleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ── Core pipeline (Steps 1–4) ─────────────────────────────────────────────────
function pipelineSync(raw) {
  // Step 1 — lowercase + trim
  let s = raw.toLowerCase().trim();

  // Step 2 — strip filler words
  s = s.split(/\s+/).filter(w => !FILLER.has(w)).join(' ').trim();
  if (!s) s = raw.toLowerCase().trim(); // safety: never return empty

  // Step 3 — alias substitution (whole phrase, then word-by-word)
  if (ALIASES[s]) {
    s = ALIASES[s];
  } else {
    s = s.split(/\s+/).map(w => ALIASES[w] || w).join(' ');
  }

  // Step 4 — suffix stripping per word
  s = s.split(/\s+/).map(stripSuffix).join(' ');

  return s;
}

/**
 * Resolve a raw product name to a canonical form for this trader.
 *
 * Pipeline:
 *   1. Lowercase + trim
 *   2. Strip filler words
 *   3. Apply Nigerian alias map
 *   4. Strip common suffixes
 *   5. Fuzzy match against the trader's existing products in DB
 *      (Levenshtein ≤ 2 AND first letter matches → use existing name)
 *   6. Title-case the result
 *
 * @param {string} rawName        What the trader typed
 * @param {string} whatsappNumber The trader's number (for DB lookup)
 * @returns {Promise<string>}     Canonical product name
 */
async function normaliseProduct(rawName, whatsappNumber) {
  if (!rawName || !rawName.trim()) return 'Unknown Product';

  const normalised = pipelineSync(rawName);

  // Step 5 — fuzzy DB match
  try {
    const res = await query(
      `SELECT p.product_name, p.product_name_normalized
       FROM products p
       JOIN users u ON u.id = p.user_id
       WHERE u.whatsapp_number = $1
         AND p.is_active = TRUE`,
      [whatsappNumber]
    );

    for (const row of res.rows) {
      const existing = row.product_name_normalized || row.product_name.toLowerCase();
      // Both conditions must hold: first letter matches AND distance ≤ 2
      if (
        existing.charAt(0) === normalised.charAt(0) &&
        levenshtein(existing, normalised) <= 2
      ) {
        return row.product_name; // return the stored canonical name verbatim
      }
    }
  } catch (err) {
    console.error('[Normaliser] DB lookup failed:', err.message);
  }

  // Step 6 — title-case the normalised form as a new name
  return toTitleCase(normalised);
}

module.exports = { normaliseProduct, levenshtein, pipelineSync };
