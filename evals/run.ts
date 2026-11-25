import { runSuites } from './suites.js';

const results = await runSuites(process.argv.slice(2));
let failed = 0;
for (const result of results) {
  failed += result.failed;
  console.log(`${result.failed === 0 ? 'PASS' : 'FAIL'} ${result.name}: ${result.passed} passed, ${result.failed} failed`);
  for (const failure of result.failures) console.log(`  - ${failure}`);
}
process.exit(failed === 0 ? 0 : 1);
