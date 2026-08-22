'use strict';

/**
 * src/reseller-agent/sellerMatcher.js
 * Identify which registered seller a customer's first message refers to
 * (bizpulse-v1-build-prompt Section 4a: "identification-first, link as an
 * optional accelerator — never link-dependent").
 *
 * Deterministic, zero-dependency, runs BEFORE any Claude call — a wrong guess
 * here never wastes a model turn. Deliberately not shared with Kemi's
 * src/agent/normaliser.js: the two agents are separate products with unrelated
 * matching targets (a trader's own product catalog vs. a global seller list),
 * so this keeps a small local copy rather than coupling them.
 */

const SellerModel = require('../../models/seller');

// Small, domain-specific stopword list — words a customer's opening message
// commonly includes that carry no identifying signal (e.g. "the girl that
// sells bags" should match on "bags", not get diluted by "the"/"that"/"sells").
const STOPWORDS = new Set([
  'the', 'a', 'an', 'that', 'who', 'which', 'is', 'i', 'im', "i'm", 'want',
  'to', 'from', 'order', 'buy', 'buying', 'shopping', 'today', 'please',
  'pls', 'abeg', 'hi', 'hello', 'sell', 'sells', 'selling', 'seller', 'shop',
  'store', 'girl', 'guy', 'lady', 'person', 'she', 'he', 'they', 'with',
  'and', 'of', 'for', 'me', 'my', 'some', 'one', 'am', 'dey',
]);

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

function normalizeWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w));
}

/** Two words are considered the same reference if identical, or close enough
 * (edit distance <= 2, same first letter) to survive a typo/misspelling. */
function wordsMatch(a, b) {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false; // too short to fuzzy-match safely
  return a.charAt(0) === b.charAt(0) && levenshtein(a, b) <= 2;
}

/**
 * @param {string} rawMessage  The customer's message (may just be a code, or a
 *                              full sentence like "the girl that sells bags")
 * @returns {Promise<{ match: object|null, candidates: object[] }>}
 *   match      — a single confident seller row, or null
 *   candidates — 2+ plausible seller rows when genuinely ambiguous (caller
 *                should ask a disambiguating follow-up); empty otherwise
 */
async function identifySeller(rawMessage) {
  const sellers = await SellerModel.getAllActive();
  if (sellers.length === 0) return { match: null, candidates: [] };

  const messageWords = normalizeWords(rawMessage);
  const messageLower = (rawMessage || '').toLowerCase();

  // Strongest signal: an exact seller code appears as its own token.
  for (const seller of sellers) {
    if (messageWords.includes(seller.code.toLowerCase())) {
      return { match: seller, candidates: [] };
    }
  }

  // Strong signal: the seller's full business name appears verbatim.
  const nameHits = sellers.filter(s => messageLower.includes(s.business_name.toLowerCase()));
  if (nameHits.length === 1) return { match: nameHits[0], candidates: [] };
  if (nameHits.length > 1) return { match: null, candidates: nameHits };

  // Fuzzy: score each seller by the fraction of its significant words that
  // appear (exactly or within edit distance 2) somewhere in the message.
  const scored = sellers
    .map(seller => {
      const sellerWords = normalizeWords(`${seller.business_name} ${seller.name}`);
      if (sellerWords.length === 0) return { seller, score: 0 };
      const hits = sellerWords.filter(sw => messageWords.some(mw => wordsMatch(sw, mw)));
      return { seller, score: hits.length / sellerWords.length };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { match: null, candidates: [] };

  const [best, second] = scored;
  // Confident: clearly ahead of the runner-up (or the only candidate at all).
  if (best.score >= 0.5 && (!second || best.score - second.score >= 0.25)) {
    return { match: best.seller, candidates: [] };
  }

  // Ambiguous — surface the top plausible matches for "Did you mean X or Y?"
  const plausible = scored
    .filter(s => s.score >= best.score - 0.1 && s.score >= 0.3)
    .map(s => s.seller);
  if (plausible.length === 1) return { match: plausible[0], candidates: [] };
  return { match: null, candidates: plausible.slice(0, 3) };
}

module.exports = { identifySeller, levenshtein, normalizeWords };
