/**
 * Verify that the committed `contracts/managed/sealed-bid` artifacts are exactly
 * what the pinned Compact toolchain produces.
 *
 * This is the reproducibility check: it recompiles the contract into a scratch
 * directory and compares every generated file byte-for-byte with what is in the
 * repository. Run it after changing the contract or bumping the toolchain.
 *
 *   npm run verify:artifacts
 *
 * Requires the Compact devtools on PATH (`compact compile --version`).
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'contracts/sealed-bid.compact';
const COMMITTED = path.join(root, 'contracts', 'managed', 'sealed-bid');

function die(message) {
  process.stderr.write(`\n❌ verify-artifacts failed: ${message}\n`);
  process.exit(1);
}

const versionCheck = spawnSync('compact', ['compile', '--version'], { encoding: 'utf8' });
if (versionCheck.status !== 0) {
  die('`compact` is not on PATH. Install the Compact devtools, then run `npm install -g`-free setup from the README.');
}
const toolchain = versionCheck.stdout.trim();

const pinned = fs.readFileSync(path.join(root, '.compact-version'), 'utf8').trim();
if (!toolchain.startsWith(pinned)) {
  die(`toolchain ${toolchain} does not match the pinned .compact-version (${pinned})`);
}

if (!fs.existsSync(COMMITTED)) {
  die(`${COMMITTED} does not exist — run \`npm run compile\` first`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sealedbid-verify-'));
const outDir = path.join(scratch, 'sealed-bid');

try {
  const compile = spawnSync(
    'compact',
    ['compile', SOURCE, outDir],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (compile.status !== 0) die(`\`compact compile\` exited with ${compile.status}`);

  /**
   * Content hash for one generated file.
   *
   * `.map` files carry a `sourceRoot` computed from the output directory's
   * depth relative to the source file. That makes the raw bytes depend on where
   * the compiler was asked to write, not on the compiler's output, so the field
   * is normalised away before hashing. Everything else — bindings, circuit IR,
   * proving/verifier keys — is compared byte-for-byte.
   */
  function hashContent(rel, bytes) {
    if (rel.endsWith('.map')) {
      try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        delete parsed.sourceRoot;
        return crypto.createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
      } catch {
        // Fall through to a raw hash if the map is not JSON we understand.
      }
    }
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }

  /** Map of relative path -> content hash for every regular file under `dir`. */
  function hashTree(dir) {
    const found = new Map();
    const walk = (current, prefix) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(current, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, rel);
        else found.set(rel, hashContent(rel, fs.readFileSync(full)));
      }
    };
    walk(dir, '');
    return found;
  }

  const expected = hashTree(outDir);
  const actual = hashTree(COMMITTED);

  const missing = [...expected.keys()].filter((rel) => !actual.has(rel));
  const extra = [...actual.keys()].filter((rel) => !expected.has(rel));
  const differing = [...expected.keys()].filter(
    (rel) => actual.has(rel) && actual.get(rel) !== expected.get(rel),
  );

  if (missing.length || extra.length || differing.length) {
    process.stderr.write('\nArtifact mismatch against a fresh compile:\n');
    for (const rel of missing) process.stderr.write(`  MISSING   ${rel}\n`);
    for (const rel of extra) process.stderr.write(`  UNEXPECTED ${rel}\n`);
    for (const rel of differing) process.stderr.write(`  DIFFERS   ${rel}\n`);
    process.stderr.write('\nRun `npm run compile` to refresh contracts/managed/.\n');
    process.exit(1);
  }

  process.stdout.write(`\n  ✅ ${actual.size} artifacts match a fresh compile\n`);
  process.stdout.write(`     toolchain: ${toolchain}\n`);
  process.stdout.write(`     location:  contracts/managed/sealed-bid\n\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
