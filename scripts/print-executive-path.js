/**
 * Prints the absolute path of the newest executive summary.
 *
 * A file rather than a `node -e` one-liner in package.json: npm on Windows strips the nested
 * double quotes, so the inline form exits 0 having executed nothing — which looks like success
 * and produces no output. Every helper script here is a real file for that reason.
 */
const path = require('path');
const fs = require('fs');

const target = path.resolve('reports/latest/kpost-executive-summary.html');
if (!fs.existsSync(target)) {
  console.error('No executive summary found. Run `npm test` first.');
  process.exit(1);
}
console.log(target);
