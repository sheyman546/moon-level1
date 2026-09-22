/**
 * Remove local scratch state: cached wallet sync data, the deployment record and
 * the local sealed-bid openings.
 *
 * It deliberately does NOT delete `contracts/managed/` — those artifacts are
 * committed, and regenerating them requires the Compact toolchain. Pass --all to
 * remove them too (then run `npm run compile`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const removeAll = process.argv.includes('--all');

const targets = [
  { path: '.midnight-state.json', note: 'wallet credentials + deployment records' },
  { path: '.midnight-wallet-state', note: 'cached wallet sync state' },
  { path: '.sealedbid-openings.json', note: 'local sealed-bid openings' },
  { path: 'dist', note: 'TypeScript build output' },
];

if (removeAll) {
  targets.push({ path: 'contracts/managed', note: 'compiled contract artifacts (re-run npm run compile)' });
}

let removed = 0;
for (const target of targets) {
  const full = path.join(root, target.path);
  if (!fs.existsSync(full)) continue;
  fs.rmSync(full, { recursive: true, force: true });
  console.log(`removed ${target.path} (${target.note})`);
  removed++;
}

console.log(removed === 0 ? 'nothing to clean' : `\ncleaned ${removed} item(s)`);
