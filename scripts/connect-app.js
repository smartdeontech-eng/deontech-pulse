#!/usr/bin/env node
/**
 * Connect an app (built on the Smart DeonTech core) to Pulse's Sign-ins page.
 * Run on the Mac, against the app's SOURCE folder — the one you deploy from:
 *
 *   node ~/deontech-pulse/scripts/connect-app.js "/path/to/aotc-track"
 *
 * It:
 *   1. copies connectors/pulse-reporter.js to <app>/utils/pulse-reporter.js
 *   2. adds one line to <app>/routes/auth.js, right after createSession({...})
 *   3. adds one line to <app>/server.js, right after app.use(cookieParser())
 * Each changed file is backed up first as <file>.before-pulse. Running it
 * twice changes nothing. Add --check to see what it would do, without writing.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const check = args.includes('--check');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('Usage: node scripts/connect-app.js <app-source-folder> [--check]'); process.exit(1); }
const root = path.resolve(dir.replace(/^~(?=\/)/, process.env.HOME || '~'));

const auth = path.join(root, 'routes', 'auth.js');
const server = path.join(root, 'server.js');
const dest = path.join(root, 'utils', 'pulse-reporter.js');
const src = path.join(__dirname, '..', 'connectors', 'pulse-reporter.js');

const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
for (const f of [auth, server]) if (!fs.existsSync(f)) fail(`${path.relative(root, f)} not found in ${root} — is this the app's source folder?`);
if (!fs.existsSync(path.join(root, 'utils'))) fail('no utils/ folder');

const MARK = 'pulse-reporter';
const plan = [];

// ---- routes/auth.js: after the createSession({...}); statement ----
let a = fs.readFileSync(auth, 'utf8');
if (a.includes(MARK)) plan.push(['routes/auth.js', 'already connected', null]);
else {
  const usesDb = /require\(['"]\.\.\/utils\/db['"]\)/.test(a) && /\bconst\s+db\b/.test(a);
  const lookup = usesDb ? ", { lookupUser: (id) => db.findById('users', id) }" : '';
  const start = a.search(/const\s+session\s*=\s*createSession\s*\(/);
  const own = a.match(/^function\s+logLogin\s*\(\s*(\w+)\s*\)\s*\{[^\n]*$/m);
  if (start < 0 && own) {
    // The app keeps its own login log (AOTC Track): report from inside it.
    const at = own.index + own[0].length;
    a = a.slice(0, at) + `\n  require('../utils/pulse-reporter').report(${own[1]}${lookup}); // to DeonTech Pulse (off unless PULSE_APP is set)` + a.slice(at);
    plan.push(['routes/auth.js', 'add report() at the top of logLogin()', a]);
  } else if (start < 0) fail('routes/auth.js: found neither `const session = createSession(` nor `function logLogin(entry) {` — add the line by hand (RUNBOOK §9).');
  else {
  // Find the matching close paren of createSession( ... ), then the semicolon.
  let i = a.indexOf('(', start), depth = 0;
  for (; i < a.length; i++) { if (a[i] === '(') depth++; else if (a[i] === ')') { depth--; if (depth === 0) break; } }
  const semi = a.indexOf(';', i);
  if (i >= a.length || semi < 0) fail('routes/auth.js: could not find the end of createSession(...)');
  const destructure = a.search(/\}\s*=\s*session\s*;/);
  if (destructure >= 0 && destructure < semi) fail('routes/auth.js: session is destructured before createSession ends?');
  const line = `\n// Sign-ins and activity to DeonTech Pulse (off unless PULSE_APP and PULSE_APP_TOKEN are set).\nrequire('../utils/pulse-reporter').wrapSession(session${lookup});`;
  a = a.slice(0, semi + 1) + line + a.slice(semi + 1);
  plan.push(['routes/auth.js', 'add wrapSession after createSession(...)', a]);
  }
}

// ---- server.js: after app.use(cookieParser()); ----
let s = fs.readFileSync(server, 'utf8');
if (s.includes(MARK)) plan.push(['server.js', 'already connected', null]);
else {
  const m = s.match(/^[ \t]*app\.use\(\s*cookieParser\(\s*\)\s*\);?[^\n]*$/m);
  if (!m) fail('server.js: could not find `app.use(cookieParser());` — add the line by hand (RUNBOOK §9).');
  const at = m.index + m[0].length;
  // Use the secret exactly as the app's own middleware reads it, if it exports it.
  const mw = path.join(root, 'middleware', 'auth.js');
  const secret = fs.existsSync(mw) && /JWT_SECRET/.test((fs.readFileSync(mw, 'utf8').match(/module\.exports[\s\S]*$/) || [''])[0])
    ? "require('./middleware/auth').JWT_SECRET" : 'process.env.JWT_SECRET';
  const line = `\napp.use('/api', require('./utils/pulse-reporter').activity({ jwt: require('jsonwebtoken'), secret: ${secret} }));`;
  s = s.slice(0, at) + line + s.slice(at);
  plan.push(['server.js', 'add activity middleware after cookieParser()', s]);
}

// ---- jsonwebtoken must be a dependency (it is in every core app) ----
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!((pkg.dependencies || {}).jsonwebtoken)) fail('package.json has no jsonwebtoken dependency — this does not look like a core app.');
} catch (e) { if (e.code !== 'ENOENT') throw e; }

const same = fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === fs.readFileSync(src, 'utf8');
plan.unshift(['utils/pulse-reporter.js', same ? 'already up to date' : fs.existsSync(dest) ? 'update' : 'add', same ? null : 'copy']);

console.log(`App: ${root}`);
for (const [f, what] of plan) console.log(`  ${what === 'already connected' || what === 'already up to date' ? '·' : '+'} ${f}: ${what}`);
if (check) { console.log('\n--check: nothing written.'); process.exit(0); }

for (const [f, , content] of plan) {
  if (content == null) continue;
  const p = path.join(root, f);
  if (content === 'copy') { fs.copyFileSync(src, p); continue; }
  if (!fs.existsSync(`${p}.before-pulse`)) fs.copyFileSync(p, `${p}.before-pulse`);
  fs.writeFileSync(p, content);
}
// Prove the edited files still parse.
for (const f of [auth, server, dest]) {
  try { new (require('vm').Script)(fs.readFileSync(f, 'utf8').replace(/^#!.*/, ''), { filename: f }); }
  catch (e) { fail(`${path.relative(root, f)} no longer parses (${e.message}). Restore it from ${path.relative(root, f)}.before-pulse.`); }
}
console.log('\n✓ Done. Release this app the usual way, then set its token on the server (RUNBOOK §9).');
