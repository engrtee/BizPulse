/**
 * test-messages.js
 * Quick test script to send sample messages to a test number.
 * Usage: node test-messages.js
 */

require('dotenv').config();
const WhatsAppService = require('./services/whatsapp');
const ClaudeService = require('./services/claude');

const TEST_NUMBER = '2348035273030'; // Your number
const TEST_USER = {
  id: 999,
  name: 'Tosin',
  biz_name: 'Fashion Store',
  biz_type: 'Fashion',
  email: 'tosin@bizpulse.ng',
  whatsapp_number: TEST_NUMBER,
  streak: 7,
};

async function sendTestMessages() {
  console.log(`\n🧪 Sending test messages to ${TEST_NUMBER}...\n`);

  try {
    // 1. Welcome/Onboarding
    console.log('[1/8] Sending onboarding message...');
    await WhatsAppService.sendOnboarding(TEST_NUMBER, 'Tosin');
    await sleep(1000);

    // 2. Entry Acknowledge
    console.log('[2/8] Sending entry acknowledgement...');
    await WhatsAppService.sendEntryAck(TEST_NUMBER, 'Tosin', {
      revenue: 45000,
      totalExpenses: 12000,
      profit: 33000,
      margin: 73.3,
      customers: 8,
      streak: 7,
      topExpense: { category: 'Stock', amount: 8000 },
      entryMethod: 'text',
    });
    await sleep(1000);

    // 3. Help message
    console.log('[3/8] Sending help message...');
    await WhatsAppService.sendHelp(TEST_NUMBER);
    await sleep(1000);

    // 4. Reminder (6pm)
    console.log('[4/8] Sending 6pm reminder...');
    await WhatsAppService.sendReminder(TEST_NUMBER, 'Tosin', 7);
    await sleep(1000);

    // 5. Stock reply
    console.log('[5/8] Sending stock check reply...');
    await WhatsAppService.sendStockReply(TEST_NUMBER, [
      { item_name: 'Ankara fabric', current_balance: 15 },
      { item_name: 'Button assortment', current_balance: 250 },
      { item_name: 'Thread spools', current_balance: 8 },
    ]);
    await sleep(1000);

    // 6. Milestone (7-day streak)
    console.log('[6/8] Sending milestone message...');
    await WhatsAppService.sendMilestone(TEST_NUMBER, 'streak7', {
      firstName: 'Tosin',
      streak: 7,
      profit: 33000,
    });
    await sleep(1000);

    // 7. Evening summary with Claude recommendation
    console.log('[7/8] Sending evening summary...');
    const sampleRec = {
      actions: ['Your profit margin of 73% is excellent for fashion retail. This means your pricing strategy is working well.'],
      risk: 'Monitor your stock levels closely — low inventory could lead to missed sales.',
    };
    await WhatsAppService.sendEveningSummaryWhatsApp(
      TEST_NUMBER,
      'Tosin',
      {
        revenue: 45000,
        totalExpenses: 12000,
        profit: 33000,
        margin: 73.3,
        customers: 8,
        topExpense: { category: 'Stock', amount: 8000 },
        date: new Date().toISOString().split('T')[0],
      },
      sampleRec,
      [{ item_name: 'Button assortment', current_balance: 3 }]
    );
    await sleep(1000);

    // 8. Business question response (simulated)
    console.log('[8/8] Sending business question coaching...');
    if (process.env.ANTHROPIC_API_KEY) {
      const coachingResponse = await ClaudeService.answerBusinessQuestion(
        TEST_USER,
        'Is my margin good?',
        {
          thirtyDayAverages: {
            revenue: 42500,
            expenses: 12800,
            margin: 70,
            customers: 7,
          },
          lastSevenDays: [
            { revenue: 45000, expenses: 12000, profit: 33000 },
            { revenue: 41000, expenses: 13000, profit: 28000 },
            { revenue: 48000, expenses: 11500, profit: 36500 },
            { revenue: 40000, expenses: 12000, profit: 28000 },
            { revenue: 43000, expenses: 13200, profit: 29800 },
            { revenue: 44000, expenses: 12500, profit: 31500 },
            { revenue: 45000, expenses: 12000, profit: 33000 },
          ],
        },
        {
          revenue: 45000,
          totalExpenses: 12000,
          margin: 73.3,
          businessType: 'Fashion',
        }
      );
      
      await WhatsAppService.sendMessage(TEST_NUMBER, `❓ Answering: Is my margin good?\n\n${coachingResponse}`);
    } else {
      console.log('   ⏭️  Skipping Claude coaching (ANTHROPIC_API_KEY not set in .env)');
    }
    await sleep(1000);

    console.log('\n✅ All test messages sent! Check your WhatsApp now.\n');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

sendTestMessages();
