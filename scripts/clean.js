/**
 * Removes run caches and exporter output.
 *
 * Deliberately does NOT touch `reports/`: run folders are pruned by KPOST_RUN_RETENTION and the
 * trend history is append-only, so wiping it would lose evidence that no re-run can recreate.
 */
const fs = require('fs');

// `allure-results` / `allure-report` used to be listed here. Allure was removed permanently,
// so nothing generates them any more and cleaning them would only ever print "absent".
const targets = [
  'test-results',
  '.bug-cache',
  '.audit-build',
  '.scorecard-build',
  '.dispatch-build',
];

for (const dir of targets) {
  const existed = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${existed ? 'removed ' : 'absent  '} ${dir}`);
}
