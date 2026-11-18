/**
 * Freeze the production dependency tree into vendor/, so a deploy needs no
 * registry, no token and no network.
 *
 *   node scripts/vendor-deps.js            build vendor/node_modules.tgz
 *   node scripts/vendor-deps.js --list     show what would be included
 *
 * WHY
 *
 * The core already travels this way — tarballs in vendor/, committed with the
 * app, "so a deploy is reproducible and needs no registry, no token and no
 * particular folder arrangement". Third-party dependencies had no equivalent:
 * they came from `npm install`, which assumes the registry is reachable. On
 * this network it is not, and a deploy that cannot install is not a deploy.
 *
 * So the same rule, extended: what the app needs to run, it carries.
 *
 * This walks the PRODUCTION dependency graph only — devDependencies are not
 * followed — resolving each package the way Node does, by walking up
 * node_modules directories, so nested copies installed for version conflicts
 * are preserved exactly where Node will look for them.
 *
 * It is not a lockfile. It cannot verify integrity hashes against the registry,
 * because the registry is unreachable; what it guarantees is that the tree that
 * ships is byte-for-byte the tree that was tested. vendor/dependencies.txt
 * records every name and version so a reviewer can see what is in the bundle
 * without unpacking it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LIST_ONLY = process.argv.includes('--list');

// Node's own resolution: from a directory, walk up looking for
// node_modules/<name>. Using the real algorithm rather than assuming a flat
// tree is what keeps a nested duplicate working after the move.
function resolvePkg(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Reading 150 small files in a burst from a cloud-synced mount can return
// EAGAIN transiently — the file is there, the filesystem just is not ready to
// hand it over yet. Retrying briefly is correct; failing the whole freeze
// because a sync client was busy is not.
function readRetry(file, attempts = 5) {
  for (let i = 1; ; i++) {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (e) {
      const transient = ['EAGAIN', 'EBUSY'].includes(e.code) || e.errno === -35;
      if (!transient) throw e;
      if (i >= attempts) {
        throw new Error(`Could not read ${file} after ${attempts} attempts (${e.code}). ` +
          'On a cloud-synced folder this usually means the file is a placeholder that has ' +
          'not been downloaded. Open it once in Finder, or make the folder available offline.');
      }
      const until = Date.now() + i * 40;
      while (Date.now() < until) { /* short synchronous pause */ }
    }
  }
}
const manifest = (dir) => JSON.parse(readRetry(path.join(dir, 'package.json')));

const keep = new Map();   // absolute package dir -> name@version
const missing = [];

function visit(name, fromDir) {
  const dir = resolvePkg(name, fromDir);
  if (!dir) { missing.push(name); return; }
  if (keep.has(dir)) return;
  const m = manifest(dir);
  keep.set(dir, `${m.name || name}@${m.version || '?'}`);
  for (const dep of Object.keys(m.dependencies || {})) visit(dep, dir);
  // Optional dependencies only if they are actually installed — an absent one
  // is not an error, which is the whole point of optional.
  for (const dep of Object.keys(m.optionalDependencies || {})) {
    if (resolvePkg(dep, dir)) visit(dep, dir);
  }
}

const declared = Object.keys(manifest(ROOT).dependencies || {});
for (const dep of declared) visit(dep, ROOT);

// --check compares what package.json declares against what the committed
// bundle actually contains. Adding a dependency and forgetting to re-freeze
// produces a bundle that installs cleanly and then dies at require() on the
// server — which is precisely what happened the first time, with `xlsx`.
if (process.argv.includes('--check')) {
  const listed = fs.existsSync(path.join(ROOT, 'vendor', 'dependencies.txt'))
    ? fs.readFileSync(path.join(ROOT, 'vendor', 'dependencies.txt'), 'utf8')
        .split('\n').filter(l => l && !l.startsWith('#'))
        .map(l => l.slice(0, l.lastIndexOf('@')))
    : null;
  if (!listed) { console.error('No vendor/dependencies.txt — run: npm run deps:freeze'); process.exit(1); }
  const absent = declared.filter(d => !listed.includes(d));
  if (absent.length) {
    console.error(`\nvendor/node_modules.tgz is out of date — missing: ${absent.join(', ')}\n` +
                  'Run: npm run deps:freeze, and commit the result.\n');
    process.exit(1);
  }
  console.log(`bundle covers all ${declared.length} declared dependencies`);
  process.exit(0);
}

const names = [...keep.values()].sort();
if (missing.length) {
  console.error(`\nNot installed, so not vendored: ${[...new Set(missing)].join(', ')}`);
  console.error('Install them first — a bundle missing a dependency fails at runtime, not here.\n');
  process.exit(1);
}

console.log(`${keep.size} packages in the production tree`);
if (LIST_ONLY) { names.forEach(n => console.log('  ' + n)); process.exit(0); }

// Staged outside the repository: the checkout is on a synced mount that may be
// read-only to a build, and a half-built staging folder is not something to
// leave in a working tree.
const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'ifaima-vendor-'));
for (const dir of keep.keys()) {
  const rel = path.relative(ROOT, dir);
  fs.cpSync(dir, path.join(STAGE, rel), { recursive: true, dereference: true });
}

// A compiled binding makes the bundle specific to one OS and CPU. That is fine
// if you deploy to the same platform you build on and disastrous if you do not:
// it installs cleanly and then fails at require() on the server. Say so here,
// where it is cheap, rather than there.
const native = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scan(full);
    else if (e.name.endsWith('.node')) native.push(path.relative(STAGE, full));
  }
})(STAGE);

if (native.length && !process.argv.includes('--allow-native')) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  console.error(
    `\nThis tree contains compiled bindings, so the bundle would only work on ` +
    `${process.platform}-${process.arch}:\n` +
    native.slice(0, 10).map(n => '  ' + n).join('\n') +
    (native.length > 10 ? `\n  …and ${native.length - 10} more` : '') +
    `\n\nBuild the bundle on the platform you deploy to, or pass --allow-native ` +
    `if that is already where you are.\n`);
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, 'vendor'), { recursive: true });
execFileSync('tar', ['czf', path.join(ROOT, 'vendor', 'node_modules.tgz'), '-C', STAGE, 'node_modules']);
fs.writeFileSync(path.join(ROOT, 'vendor', 'dependencies.txt'),
  `# Production dependency tree frozen ${new Date().toISOString().slice(0, 10)}.\n` +
  `# Built on ${process.platform}-${process.arch}, node ${process.version}.\n` +
  `# ${native.length ? 'CONTAINS COMPILED BINDINGS — this bundle is platform-specific.' : 'Pure JavaScript — portable across platforms.'}\n` +
  `# Restore with: npm run deps:restore\n\n` + names.join('\n') + '\n');
fs.rmSync(STAGE, { recursive: true, force: true });

const mb = (fs.statSync(path.join(ROOT, 'vendor', 'node_modules.tgz')).size / 1048576).toFixed(1);
console.log(`vendor/node_modules.tgz  ${mb} MB`);
console.log('vendor/dependencies.txt  written');
