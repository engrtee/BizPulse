/**
 * jobs/debtDigest.js
 * Cron job (Batch 1, A1-3): Monday 8:00 AM WAT — sends each active trader
 * with outstanding debts a weekly_debt_digest template summarising who owes
 * them and how much. Skips traders with zero outstanding debt.
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');

const UserModel       = require('../models/user');
const DebtorModel     = require('../models/debtor');
const WhatsAppService = require('../services/whatsapp');

async function runDebtDigest() {
  console.log(`[Cron] 💳 Debt digest job started at ${new Date().toISOString()}`);
  try {
    const users = await UserModel.findAllActive();

    for (const user of users) {
      if (!user.whatsapp_number) continue;
      try {
        const outstanding = await DebtorModel.getPendingAll(user.id);
        if (!outstanding || outstanding.length === 0) continue;

        const totalOwed = await DebtorModel.getTotalOwed(user.id);
        if (totalOwed <= 0) continue;

        await WhatsAppService.sendWeeklyDebtDigestTemplate(user.whatsapp_number, {
          firstName:     user.name.split(' ')[0],
          shopName:      user.biz_name || user.name,
          customerCount: outstanding.length,
          totalOwed,
        });
        console.log(`[Cron] 💳 Debt digest sent to ${user.name} (${outstanding.length} debtors, ₦${totalOwed.toLocaleString('en-NG')})`);
      } catch (err) {
        console.error(`[Cron] Debt digest failed for ${user.name}:`, err.message);
      }
    }
    console.log('[Cron] ✅ Debt digest job complete.');
  } catch (err) {
    console.error('[Cron] Fatal debt digest job error:', err.message);
  }
}

// Monday 8:00 AM WAT
cron.schedule('0 8 * * 1', async () => {
  console.log('[Cron] 💳 Debt digest firing:', new Date().toISOString());
  try {
    await runDebtDigest();
  } catch (err) {
    console.error('[Cron] Debt digest failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });
console.log('[Cron] Debt digest scheduled for Monday 8:00 AM WAT.');

module.exports = { runDebtDigest };
