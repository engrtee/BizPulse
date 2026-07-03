/**
 * scripts/migrate-legacy-debts.js
 *
 * One-off migration (A1-3, Batch 1): copies the legacy `debts` table
 * (whatsapp_number-keyed, BIGINT) into the canonical `debtors` table
 * (user_id-keyed, NUMERIC naira, pending/partial/paid) that Kemi's
 * log_debt/settle_debt/get_debts tools actually read and write today.
 *
 * IMPORTANT — despite CLAUDE.md historically describing `debts.amount` as
 * "BIGINT kobo", every real writer of that column (the original, since-
 * deleted logDebtHandler/settleDebtHandler in toolHandlers.js) stored the
 * raw naira figure directly with no *100 kobo conversion anywhere. This
 * migration copies `debts.amount` through AS-IS (naira, not divided by
 * 100) — confirmed by reading the original writer in git history. Dividing
 * by 100 here would silently shrink every migrated debt 100x.
 *
 * Manual run only — does NOT auto-run at server startup, matching the
 * precedent set by scripts/merge-duplicate-inventory.js for financial-data
 * migrations (see CLAUDE.md Fix 4).
 *
 *   node scripts/migrate-legacy-debts.js
 *
 * The `debts` table itself is left in place after this runs — it is not
 * dropped. Physical removal is a manual follow-up once the migrated rows
 * have been spot-checked in production.
 */

'use strict';

require('dotenv').config();
const { query, initDb } = require('../models/db');
const UserModel          = require('../models/user');

async function run() {
  console.log('[Migration] Migrating legacy debts → debtors...');

  const legacy = await query(`SELECT * FROM debts ORDER BY created_at ASC`);
  if (legacy.rows.length === 0) {
    console.log('[Migration] Legacy debts table is empty — nothing to migrate.');
    return;
  }

  let migrated = 0, skippedNoUser = 0, skippedDuplicate = 0;

  for (const row of legacy.rows) {
    try {
      const user = await UserModel.findByWhatsapp(row.whatsapp_number);
      if (!user) {
        console.warn(`[Migration] ⏭ No user found for whatsapp_number ${row.whatsapp_number} (debt ${row.id}) — skipping`);
        skippedNoUser++;
        continue;
      }

      // debts.amount is already naira despite the BIGINT type (see note above) —
      // copied through as-is, no /100 conversion.
      const amountNaira = parseInt(row.amount, 10);
      const isSettled    = row.status === 'settled';

      // Guard against double-run: skip if an equivalent row already exists
      const dup = await query(
        `SELECT id FROM debtors
         WHERE user_id = $1 AND LOWER(debtor_name) = LOWER($2)
           AND amount = $3 AND created_at = $4
         LIMIT 1`,
        [user.id, row.debtor_name, amountNaira, row.created_at]
      );
      if (dup.rows.length > 0) {
        skippedDuplicate++;
        continue;
      }

      await query(
        `INSERT INTO debtors
           (user_id, debtor_name, amount, amount_paid, product_name, notes, status, created_at, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          user.id,
          row.debtor_name,
          amountNaira,
          isSettled ? amountNaira : 0,
          row.item || null,
          row.note || null,
          isSettled ? 'paid' : 'pending',
          row.created_at,
          isSettled ? row.settled_at : null,
        ]
      );

      // Preserve the payment as a ledger row too, so settled legacy debts
      // have an audit trail consistent with debt_payments going forward.
      if (isSettled) {
        const inserted = await query(
          `SELECT id FROM debtors WHERE user_id = $1 AND debtor_name = $2 AND amount = $3 AND created_at = $4 LIMIT 1`,
          [user.id, row.debtor_name, amountNaira, row.created_at]
        );
        const newDebtorId = inserted.rows[0]?.id;
        if (newDebtorId) {
          await query(
            `INSERT INTO debt_payments (debtor_id, amount, created_at) VALUES ($1, $2, $3)`,
            [newDebtorId, amountNaira, row.settled_at || row.created_at]
          );
        }
      }

      migrated++;
    } catch (err) {
      console.error(`[Migration] Error on legacy debt ${row.id}:`, err.message);
    }
  }

  console.log(`[Migration] Done — migrated:${migrated}  skipped(no user):${skippedNoUser}  skipped(duplicate):${skippedDuplicate}`);
}

if (require.main === module) {
  initDb()
    .then(() => run())
    .then(() => process.exit(0))
    .catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
}

module.exports = { run };
