/** Prints DEV_DIGEST.md to stdout — the fastest read on a run's shape. */
const fs = require('fs');

if (!fs.existsSync('DEV_DIGEST.md')) {
  console.error('No DEV_DIGEST.md found. Run `npm test` first.');
  process.exit(1);
}
process.stdout.write(fs.readFileSync('DEV_DIGEST.md', 'utf-8'));
