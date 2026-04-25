'use strict';

/**
 * scripts/stress-test-parser.js
 *
 * Stress-tests the Gemini AI parser against real-world Nigerian business messages.
 * Validates that the parser:
 *   1. Classifies intents correctly (or close enough)
 *   2. NEVER writes revenue or deducts stock for queries/stock-checks (CRITICAL)
 *   3. Captures required fields (customer for credit, amount for debt payment, etc.)
 *
 * Usage:
 *   node scripts/stress-test-parser.js              — run all 85 messages
 *   node scripts/stress-test-parser.js --dry-run    — list messages without calling API
 *   node scripts/stress-test-parser.js --batch 10   — run first 10 only
 *   node scripts/stress-test-parser.js --delay 1200 — 1.2 s between calls (default 800)
 *   node scripts/stress-test-parser.js --category sale — only messages with expected=sale
 *
 * Exit code: 1 if any CRITICAL failures are found, 0 otherwise.
 */

require('dotenv').config();
const GeminiService = require('../services/gemini');

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const BATCH      = parseInt(args[args.indexOf('--batch')  + 1], 10) || Infinity;
const DELAY_MS   = parseInt(args[args.indexOf('--delay')  + 1], 10) || 800;
const FILTER_CAT = args.includes('--category') ? args[args.indexOf('--category') + 1] : null;

// ─── Mock test user (retail — broadest applicable context) ────────────────────
const TEST_USER = {
  id:               999,
  name:             'Test User',
  biz_name:         'General Store',
  biz_type:         'Retail / Trading',
  email:            'test@bizpulse.ng',
  whatsapp_number:  '2348000000000',
  streak:           5,
};

// ─── Full stressed message dataset ───────────────────────────────────────────
const STRESSED_MESSAGES = [
  // ── SALES (varied spelling, pidgin, tense) ──────────────────────────
  'sold 5 tins peak milk 4500',
  'e don finish o, milo, abeg update',
  'sol 3 peint of rice 1500 naira yday',
  '200 remaining',
  'sell 10 tin milo and 5 bag sugar, milo 800 each, sugar 3k',
  'mama nkechi take 3 indomie on credit, she go pay monday',

  // ── MULTI-ITEM SALES ─────────────────────────────────────────────────
  'i don sell 2 tin peak, 1 bag ewa, 3 bottle groundnut oil today',
  'customer buy milo 2, bournvita 1, total 3200',
  'morning sales: garri 4 mudu, beans 2 paint, rice 1 bag',
  'sell am: 5 sachet mayo, 3 tin tomato, 2 pkt noodles — 2750 total',
  'aunty grace carry 1 crate egg and 2 tin milk, pay 4800',

  // ── STOCK FINISHED / LOW STOCK ───────────────────────────────────────
  'milo don finish, no more stock',
  'we remain 2 tin peak milk o',
  'last 3 bag of rice dey, abeg restock',
  'sugar don go, only 1 wrap remain',
  'golden morn don finish since yesterday',
  'omo washing powder almost finish, maybe 5 sachet remain',
  'indomie don exhaust, customer dey ask',

  // ── RESTOCK / PURCHASE ───────────────────────────────────────────────
  'i don buy 2 carton milo from store, 14400',
  'bought 10 bag rice from alhaji, 65000 naira',
  'restock: 1 carton peak milk (24 tins), 1 carton omo (10 pkt)',
  'get 5 crate minerals today — coke and fanta, 7500',
  'add 20 mudu garri to stock, pay 6000',
  'carry come 3 jerrican groundnut oil from market, 18k',
  'new stock enter: bournvita 1 carton, milo 2 carton — total owe alhaji 28k',

  // ── CREDIT / DEBT ────────────────────────────────────────────────────
  'mr emeka carry 1 bag rice credit, promise pay weekend',
  'aunty bisi owe me 2500, she take tomato and pepper last week',
  'landlord pikin take coke on credit again, 500',
  'customer take goods 3200 naira, no pay, say tomorrow',
  'baba tunde collect 1 tin milo, 1 tin peak, total 2100 — credit',
  'mama double take 2 wrap sugar and 1 tin bournvita on topaye',
  'update credit: iya basira pay 1500 out of 3000 she owe',
  'nneka don pay her debt, 2800 complete',
  'collect 500 from mr sunday for the noodles wey him take last week',

  // ── PRICES / PRICE CHANGE ────────────────────────────────────────────
  'milo don increase, now 950 per tin',
  'rice don go up, bag now 75k from supplier',
  'update price: coke 400, fanta 400, sprite 400',
  'peak milk 650 per tin now o, before na 600',
  'sugar 1k per wrap now, up from 800',

  // ── NIGERIAN UNITS (ambiguous quantities) ────────────────────────────
  'sell 2 mudu beans 1200',
  'customer buy half bag garri 3000',
  '1 congo of beans sell 600',
  'customer take quarter paint of crayfish, 500 naira',
  'half carton milo remain',
  '3 wrap maggi sell 150',
  'sell small small: 2 cube knorr, 1 sachet salt, 3 sachet mayo — 380',

  // ── TYPOS / ABBREVIATIONS / AUTOCORRECT ──────────────────────────────
  'sol 5 tns mlik 3500',
  'mlo dn fns, pls updt',
  'sld 3 pkg noodl 750 naria',
  'bot 2 crtoon indomei, 9600',
  'custmr by 1 dzon eg 1800',
  'peak mlk 3 tins @ 650 eac = 1950',
  'sell 2 btl zobo drink 400nair total',
  'remainin stck: rise 4 bag, bens 2 bag, garr 10 mudu',

  // ── TIME REFERENCES ──────────────────────────────────────────────────
  'yday i sell milo 3 tin, peak 2 tin',
  'this morning sell 5 sachet omo 750',
  'last nite customer buy 1 crate egg 3600',
  'sell am this evening: 2 tin bournvita 2400',
  'monday wey pass we sell 12k goods total',
  'i don sell since morning: 5400 cash collected',

  // ── COMPLEX COMBINED (sale + credit + restock in one message) ────────
  'sell 2 bag rice cash 15k, mr john take 1 bag credit, and i buy 5 bag from alhaji 45k',
  'morning: sell 3200 cash, mama eze take 1500 credit. buy new stock 12k',
  'today movement: restock milo 1 carton 7200, sell 8 tin milo 7600, profit 400',

  // ── RETURNS / REFUNDS ────────────────────────────────────────────────
  'customer return 2 tin peak milk say e don expire',
  'that milo wey customer carry, dem bring am back, 950',
  'i refund 1200 to customer for bad indomie',

  // ── QUERIES ──────────────────────────────────────────────────────────
  'how many milo we remain?',
  'check how much nneka owe me',
  'wetin be the price of garri now',
  'abeg tell me today total sales',
  'how much we sell since monday?',
  'how many crate egg we get left?',

  // ── DISCOUNTS / BULK DEALS ───────────────────────────────────────────
  'sell 10 tin peak at 600 instead of 650, customer buy bulk',
  'give customer 200 discount on 5k purchase',
  'sell half bag rice 3500, normally 3800 but e be regular customer',

  // ── CODE-SWITCHING (Yoruba / Igbo / Hausa + Pidgin) ──────────────────
  'e ya 3 tin milo, o san 2850',
  'nna buy 2 bag rice today, owe me 1 bag',
  'ya ice cream 5, uwargida carry 3 on credit, rest cash',
  'omo this market slow today, only sell 2k since morning',
  'chai, customer wey owe me 5k since december, she pay today!',
  'abeg update am, sell coke 5 bottle, fanta 3, total 3200',
  'e don dey, 3 bag rice left, 2 of dem sef dey old',
];

// ─── Expected category for specific messages (subset — rest are unclassified) ─
const EXPECTED_TYPES = {
  'sold 5 tins peak milk 4500':                                          'sale',
  'e don finish o, milo, abeg update':                                   'stock_check',
  'sol 3 peint of rice 1500 naira yday':                                 'sale',
  '200 remaining':                                                        'stock_check',
  'sell 10 tin milo and 5 bag sugar, milo 800 each, sugar 3k':          'sale',
  'mama nkechi take 3 indomie on credit, she go pay monday':             'credit_sale',
  'milo don finish, no more stock':                                       'stock_check',
  'i don buy 2 carton milo from store, 14400':                          'restock',
  'bought 10 bag rice from alhaji, 65000 naira':                        'restock',
  'mr emeka carry 1 bag rice credit, promise pay weekend':               'credit_sale',
  'update credit: iya basira pay 1500 out of 3000 she owe':             'debt_payment',
  'nneka don pay her debt, 2800 complete':                               'debt_payment',
  'milo don increase, now 950 per tin':                                  'price_update',
  'update price: coke 400, fanta 400, sprite 400':                      'price_update',
  'mlo dn fns, pls updt':                                               'stock_check',
  'how many milo we remain?':                                            'query',
  'check how much nneka owe me':                                         'query',
  'wetin be the price of garri now':                                     'query',
  'abeg tell me today total sales':                                      'query',
  'customer return 2 tin peak milk say e don expire':                    'return',
  'i refund 1200 to customer for bad indomie':                          'return',
  'sell 2 bag rice cash 15k, mr john take 1 bag credit, and i buy 5 bag from alhaji 45k': 'combined',
  'morning: sell 3200 cash, mama eze take 1500 credit. buy new stock 12k': 'combined',
  'today movement: restock milo 1 carton 7200, sell 8 tin milo 7600, profit 400': 'combined',
  'sell 10 tin peak at 600 instead of 650, customer buy bulk':          'discount_sale',
  'give customer 200 discount on 5k purchase':                          'discount_sale',
  'e ya 3 tin milo, o san 2850':                                        'sale',
  'chai, customer wey owe me 5k since december, she pay today!':        'debt_payment',
};

// ─── Which Gemini output types satisfy each expected category ─────────────────
const ACCEPTABLE_GEMINI_TYPES = {
  sale:          ['inventory_out', 'daily_entry'],
  stock_check:   ['stock_zero', 'opening_stock', 'question', 'unknown'],
  restock:       ['inventory_in'],
  credit_sale:   ['daily_entry'],
  debt_payment:  ['daily_entry'],
  price_update:  ['question', 'unknown', 'daily_entry'],
  query:         ['question'],
  return:        ['daily_entry', 'unknown'],
  combined:      ['daily_entry'],
  discount_sale: ['daily_entry', 'inventory_out'],
};

// ─── Validation rules applied to every parsed result ─────────────────────────
const VALIDATION_RULES = [
  {
    id:         'query_no_db_write',
    category:   'query',
    severity:   'CRITICAL',
    description: 'Query messages must NEVER log revenue or mutate inventory',
    check(parsed) {
      if (parsed.type === 'inventory_out' || parsed.type === 'inventory_in') return false;
      if ((parsed.revenue || 0) > 0) return false;
      const hasStockMutation = (parsed.products || []).some(
        p => p.transaction_type === 'sale' && (p.quantity || 0) > 0
      );
      return !hasStockMutation;
    },
  },
  {
    id:         'stock_check_no_deduction',
    category:   'stock_check',
    severity:   'CRITICAL',
    description: 'Stock-check messages must NEVER deduct inventory or log revenue',
    check(parsed) {
      if (parsed.type === 'inventory_out') return false;
      if ((parsed.revenue || 0) > 0) {
        // Revenue from a "stock check" message is a misparse
        return false;
      }
      const hasStockOut = (parsed.products || []).some(
        p => p.transaction_type === 'sale' && (p.quantity || 0) > 0
      );
      return !hasStockOut;
    },
  },
  {
    id:         'price_update_no_quantity',
    category:   'price_update',
    severity:   'FAIL',
    description: 'Price-update messages must not deduct stock quantities',
    check(parsed) {
      if (parsed.type === 'inventory_out') return false;
      const hasStockOut = (parsed.products || []).some(
        p => p.transaction_type === 'sale' && (p.quantity || 0) > 0
      );
      return !hasStockOut;
    },
  },
  {
    id:         'credit_sale_needs_customer',
    category:   'credit_sale',
    severity:   'WARN',
    description: 'Credit sales should capture customer context in notes',
    check(parsed) {
      const notes = (parsed.notes || '').toLowerCase();
      return notes.length > 5; // some context was captured
    },
  },
  {
    id:         'combined_needs_multiple_ops',
    category:   'combined',
    severity:   'WARN',
    description: 'Combined messages should yield both revenue and expenses (or multiple products)',
    check(parsed) {
      const hasRevAndExp = (parsed.revenue || 0) > 0 && (parsed.totalExpenses || 0) > 0;
      const hasMultipleProducts = (parsed.products || []).length >= 2;
      return hasRevAndExp || hasMultipleProducts;
    },
  },
  {
    id:         'debt_payment_has_amount',
    category:   'debt_payment',
    severity:   'FAIL',
    description: 'Debt-payment messages must result in revenue > 0',
    check(parsed) {
      return (parsed.revenue || 0) > 0;
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const SEVERITY_ORDER = { CRITICAL: 0, FAIL: 1, WARN: 2, PASS: 3, SKIP: 4 };
const SEVERITY_ICONS = { CRITICAL: '🔴 CRITICAL', FAIL: '🟠 FAIL', WARN: '🟡 WARN', PASS: '🟢 PASS', SKIP: '⬜ SKIP' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function truncate(str, max = 62) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function pad(n, width) { return String(n).padStart(width); }

// Determine whether the parsed Gemini result satisfies the expected category
function categoryMatch(parsed, expectedCat) {
  const acceptable = ACCEPTABLE_GEMINI_TYPES[expectedCat] || [];
  return acceptable.includes(parsed.type);
}

// Run all relevant validation rules for a result
function runValidations(parsed, expectedCat) {
  const results = [];
  for (const rule of VALIDATION_RULES) {
    if (rule.category !== expectedCat) continue;
    const passed = rule.check(parsed);
    results.push({ rule: rule.id, passed, severity: rule.severity, description: rule.description });
  }
  return results;
}

// Overall status for a single message
function computeStatus(typeMatch, validations, expectedCat) {
  if (!expectedCat) return 'SKIP'; // no expected type defined — record only
  const worstValidation = validations
    .filter(v => !v.passed)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])[0];
  if (worstValidation?.severity === 'CRITICAL') return 'CRITICAL';
  if (worstValidation?.severity === 'FAIL')     return 'FAIL';
  if (!typeMatch)                                return 'WARN';
  if (worstValidation?.severity === 'WARN')      return 'WARN';
  return 'PASS';
}

// ─── Main runner ─────────────────────────────────────────────────────────────
async function run() {
  let messages = STRESSED_MESSAGES;

  if (FILTER_CAT) {
    messages = messages.filter(m => EXPECTED_TYPES[m] === FILTER_CAT);
    if (!messages.length) {
      console.error(`No messages found for category: ${FILTER_CAT}`);
      process.exit(1);
    }
  }
  if (BATCH < messages.length) {
    messages = messages.slice(0, BATCH);
  }

  const total  = messages.length;
  const width  = String(total).length;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🧪  BizPulse Parser Stress Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Messages : ${total}`);
  console.log(`  Mode     : ${DRY_RUN ? 'DRY RUN (no API calls)' : 'LIVE (calls Gemini API)'}`);
  if (!DRY_RUN) console.log(`  Delay    : ${DELAY_MS} ms between calls`);
  if (FILTER_CAT) console.log(`  Filter   : category = ${FILTER_CAT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const results = [];
  const counts = { PASS: 0, WARN: 0, FAIL: 0, CRITICAL: 0, SKIP: 0 };

  for (let i = 0; i < messages.length; i++) {
    const msg         = messages[i];
    const expectedCat = EXPECTED_TYPES[msg] || null;
    const idx         = `[${pad(i + 1, width)}/${total}]`;

    process.stdout.write(`${idx} ${truncate(msg)}\n`);

    if (DRY_RUN) {
      const catTag = expectedCat ? `  expected: ${expectedCat}` : '  (no expected type)';
      console.log(`        ${catTag}\n`);
      counts['SKIP']++;
      results.push({ msg, expectedCat, parsed: null, status: 'SKIP', typeMatch: null, validations: [] });
      continue;
    }

    let parsed;
    try {
      parsed = await GeminiService.parseWithAI(msg, TEST_USER);
    } catch (err) {
      console.log(`        ❌ API error: ${err.message}\n`);
      counts['FAIL']++;
      results.push({ msg, expectedCat, parsed: null, status: 'FAIL', typeMatch: false, validations: [] });
      await sleep(DELAY_MS);
      continue;
    }

    const typeMatch   = expectedCat ? categoryMatch(parsed, expectedCat) : null;
    const validations = expectedCat ? runValidations(parsed, expectedCat) : [];
    const status      = computeStatus(typeMatch, validations, expectedCat);
    counts[status]++;

    results.push({ msg, expectedCat, parsed, status, typeMatch, validations });

    // ── Print result line ──
    const icon     = SEVERITY_ICONS[status];
    const typeInfo = expectedCat
      ? `expected=${expectedCat}  got=${parsed.type}  ${typeMatch ? '✓' : '✗'}`
      : `got=${parsed.type}  (no expected)`;
    console.log(`        ${icon}  ${typeInfo}`);

    // Print any revenue/products captured (useful for manual review)
    const rev  = parsed.revenue    || 0;
    const exp  = parsed.totalExpenses || 0;
    const prds = (parsed.products  || []).length;
    if (rev || exp || prds) {
      const detail = [
        rev  ? `rev=₦${Number(rev).toLocaleString('en-NG')}` : '',
        exp  ? `exp=₦${Number(exp).toLocaleString('en-NG')}` : '',
        prds ? `products=${prds}` : '',
      ].filter(Boolean).join('  ');
      console.log(`               ${detail}`);
    }

    // Print validation failures
    for (const v of validations.filter(v => !v.passed)) {
      const sev = v.severity === 'CRITICAL' ? '🔴' : v.severity === 'FAIL' ? '🟠' : '🟡';
      console.log(`               ${sev} rule failed: ${v.rule} — ${v.description}`);
    }

    console.log('');

    if (i < messages.length - 1) await sleep(DELAY_MS);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  const criticals = results.filter(r => r.status === 'CRITICAL');
  const fails     = results.filter(r => r.status === 'FAIL');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  RESULTS SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const [status, icon] of Object.entries(SEVERITY_ICONS)) {
    const n   = counts[status];
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    console.log(`  ${icon.padEnd(16)} ${String(n).padStart(3)}  (${String(pct).padStart(3)}%)`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!DRY_RUN) {
    // Type distribution breakdown
    const typeDist = {};
    for (const r of results) {
      if (r.parsed) {
        typeDist[r.parsed.type] = (typeDist[r.parsed.type] || 0) + 1;
      }
    }
    console.log('\n  GEMINI TYPE DISTRIBUTION');
    console.log('  ─────────────────────────────────────────────');
    for (const [type, n] of Object.entries(typeDist).sort((a, b) => b[1] - a[1])) {
      const bar = '█'.repeat(Math.round(n / total * 30));
      console.log(`  ${type.padEnd(16)} ${String(n).padStart(3)}  ${bar}`);
    }
  }

  if (criticals.length > 0) {
    console.log('\n  🔴 CRITICAL FAILURES — these would corrupt data in production:');
    console.log('  ─────────────────────────────────────────────');
    for (const r of criticals) {
      const failedRules = r.validations.filter(v => !v.passed && v.severity === 'CRITICAL');
      for (const v of failedRules) {
        console.log(`  ▸ "${truncate(r.msg, 55)}"`);
        console.log(`    Rule: ${v.rule}`);
        console.log(`    Got:  type=${r.parsed?.type}  rev=₦${r.parsed?.revenue || 0}`);
        console.log('');
      }
    }
  }

  if (fails.length > 0) {
    console.log('\n  🟠 FAILURES:');
    console.log('  ─────────────────────────────────────────────');
    for (const r of fails) {
      const failedRules = r.validations.filter(v => !v.passed && v.severity === 'FAIL');
      if (failedRules.length) {
        for (const v of failedRules) {
          console.log(`  ▸ "${truncate(r.msg, 55)}"  [${v.rule}]`);
        }
      } else {
        console.log(`  ▸ "${truncate(r.msg, 55)}"  [API error]`);
      }
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.exit(criticals.length > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
