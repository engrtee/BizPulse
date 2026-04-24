/**
 * Debug: Simulate the browser loading the summary page
 * Check what happens when frontend loads
 */

'use strict';

require('dotenv').config();
const fetch = require('node-fetch');

async function simulate() {
  try {
    console.log('\n🔍 SIMULATING FRONTEND SUMMARY LOAD\n');

    // Frontend would check localStorage for user ID
    // Let's test with userId=4 (Tosin)
    const userId = 4;
    console.log(`Testing with userId=${userId}\n`);

    // Call the actual endpoint like the frontend does
    const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
    const url = `${BASE_URL}/api/summary/latest?userId=${userId}&ai=1`;
    
    console.log(`Calling: ${url}\n`);

    const res = await fetch(url);
    const data = await res.json();

    console.log('Response from endpoint:');
    console.log('  hasData:', data.hasData);
    console.log('  Has summary:', !!data.summary);
    console.log('  Has history:', data.history?.length || 0, 'entries');
    
    if (data.summary) {
      console.log('\nSummary data:');
      console.log('  Date:', data.summary.date);
      console.log('  Revenue:', data.summary.revenue);
      console.log('  Expenses:', data.summary.totalExpenses);
      console.log('  Profit:', data.summary.profit);
    }

    if (!data.hasData) {
      console.log('\n❌ PROBLEM: hasData is FALSE - frontend will show "No entries yet"');
    } else {
      console.log('\n✅ Data should display on frontend');
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

simulate();
