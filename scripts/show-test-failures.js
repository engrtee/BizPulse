'use strict';
const data = require('../kemi-test-output.json');
console.log(`\n  Total: ${data.summary.total}  Pass: ${data.summary.passed}  Fail: ${data.summary.failed}  Pass rate: ${data.summary.passRate}%\n`);
const failed = data.results.filter(r => !r.passed);
failed.forEach((r, i) => {
  console.log(`\n${i+1}. [${r.category}] ${r.label}`);
  console.log(`   Day ${r.day || '-'}  Message: "${r.message.substring(0, 70)}"`);
  console.log(`   Response: "${r.response.substring(0, 150)}"`);
  r.failures.forEach(f => console.log(`   ❌ ${f}`));
});
