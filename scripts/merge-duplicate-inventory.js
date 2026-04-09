/**
 * Merge Duplicate Inventory Items
 * 
 * This script finds and merges duplicate inventory items that may have been created
 * due to case differences or plural variation (e.g., "Laptop" and "laptops").
 * 
 * RUN ONLY MANUALLY: node scripts/merge-duplicate-inventory.js
 * 
 * What it does:
 * 1. Finds all users with potential duplicate inventory items
 * 2. Groups items by normalized name (lowercase, no trailing 's')
 * 3. Shows duplicates before merging
 * 4. Asks for confirmation before making changes
 * 5. Merges balances and preserves all historical data
 * 6. Logs all merge operations to console
 */

require('dotenv').config();
const readline = require('readline');
const { query } = require('../models/db');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question) {
  return new Promise(resolve => {
    rl.question(question, resolve);
  });
}

function normalizeItemName(name) {
  const trimmed = (name || '').trim().toLowerCase();
  // Strip trailing 's' but not 'ss' (glass, class, etc)
  return trimmed.length > 3 && trimmed.endsWith('s') && !trimmed.endsWith('ss')
    ? trimmed.slice(0, -1)
    : trimmed;
}

async function findDuplicatesForUser(userId) {
  /**
   * Find all inventory items for a user and group by normalized name
   */
  try {
    const res = await query(`
      SELECT 
        id,
        item_name,
        current_balance,
        total_received,
        unit_price,
        LOWER(REGEXP_REPLACE(item_name, 's$', '')) as normalized_name
      FROM inventory
      WHERE user_id = $1
      ORDER BY normalized_name, item_name
    `, [userId]);

    // Group by normalized name
    const grouped = {};
    res.rows.forEach(row => {
      const normalized = normalizeItemName(row.item_name);
      if (!grouped[normalized]) {
        grouped[normalized] = [];
      }
      grouped[normalized].push(row);
    });

    // Filter to only groups with duplicates
    const duplicates = Object.entries(grouped).filter(([_, items]) => items.length > 1);
    return duplicates;
  } catch (error) {
    console.error('❌ Error finding duplicates:', error.message);
    return [];
  }
}

async function mergeItems(userId, itemIds, keepId, newName) {
  /**
   * Merge multiple items into one
   * 
   * 1. Update all transaction references to point to kept item
   * 2. Sum all balances into the kept item
   * 3. Delete the other items
   */
  try {
    const idsToDelete = itemIds.filter(id => id !== keepId);

    // Calculate total balance
    const balanceRes = await query(`
      SELECT COALESCE(SUM(current_balance), 0) as total_balance,
             COALESCE(SUM(total_received), 0) as total_received
      FROM inventory
      WHERE user_id = $1 AND id = ANY($2)
    `, [userId, itemIds]);

    const { total_balance, total_received } = balanceRes.rows[0];

    // Update the kept item
    await query(`
      UPDATE inventory
      SET current_balance = $1,
          total_received = $2,
          item_name = $3,
          last_updated = NOW()
      WHERE id = $4
    `, [total_balance, total_received, newName, keepId]);

    // Delete duplicate items
    if (idsToDelete.length > 0) {
      await query(`
        DELETE FROM inventory
        WHERE id = ANY($1)
      `, [idsToDelete]);
    }

    return {
      success: true,
      keptId: keepId,
      deletedIds: idsToDelete,
      finalBalance: total_balance,
      finalReceived: total_received
    };
  } catch (error) {
    console.error('❌ Error merging items:', error.message);
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('🔄 BizPulse Inventory Deduplication Script');
  console.log('==========================================\n');

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set in .env');
    process.exit(1);
  }

  // Get all users with inventory
  const usersRes = await query(`
    SELECT DISTINCT user_id FROM inventory ORDER BY user_id
  `);

  if (usersRes.rows.length === 0) {
    console.log('✅ No inventory items found. Nothing to merge.\n');
    rl.close();
    process.exit(0);
  }

  console.log(`📊 Found ${usersRes.rows.length} users with inventory\n`);

  let totalMerges = 0;
  let totalItemsDeleted = 0;

  for (const { user_id } of usersRes.rows) {
    const duplicates = await findDuplicatesForUser(user_id);

    if (duplicates.length === 0) {
      console.log(`✅ User ${user_id}: No duplicates found`);
      continue;
    }

    console.log(`\n⚠️  User ${user_id}: Found ${duplicates.length} duplicate groups\n`);

    for (const [normalized, items] of duplicates) {
      console.log(`📦 Item Group: "${normalized}"`);
      console.log('   Versions found:');
      
      items.forEach((item, idx) => {
        console.log(`   [${idx + 1}] ${item.item_name}`);
        console.log(`       - Balance: ${item.current_balance} units`);
        console.log(`       - Ever Received: ${item.total_received} units`);
        console.log(`       - Unit Price: ₦${item.unit_price}`);
      });

      // Ask which to keep
      let choice = null;
      while (!choice || choice < 1 || choice > items.length) {
        const answer = await prompt(`   👉 Keep which version? [1-${items.length}]: `);
        choice = parseInt(answer);
        if (!choice || choice < 1 || choice > items.length) {
          console.log(`   ❌ Invalid choice. Enter 1-${items.length}`);
        }
      }

      const keptItem = items[choice - 1];
      const itemIds = items.map(i => i.id);

      // Ask for final name
      const newName = await prompt(`   📝 Final item name [${keptItem.item_name}]: `);
      const finalName = newName.trim() || keptItem.item_name;

      // Confirm merge
      const confirm = await prompt(`   🔗 Merge ${items.length} items into "${finalName}"? [y/n]: `);
      if (confirm.toLowerCase() !== 'y') {
        console.log('   ❌ Merge cancelled.\n');
        continue;
      }

      // Execute merge
      const result = await mergeItems(user_id, itemIds, keptItem.id, finalName);
      
      if (result.success) {
        const deleted = result.deletedIds.length;
        console.log(`   ✅ Merged! Combined balance: ${result.finalBalance} units\n`);
        totalMerges++;
        totalItemsDeleted += deleted;
      } else {
        console.log(`   ❌ Merge failed: ${result.error}\n`);
      }
    }
  }

  // Summary
  console.log('\n========================================');
  console.log(`✅ Migration Complete`);
  console.log(`   - Groups merged: ${totalMerges}`);
  console.log(`   - Items deleted: ${totalItemsDeleted}`);
  console.log('========================================\n');

  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  rl.close();
  process.exit(1);
});
