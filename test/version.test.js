// The version must agree everywhere, so the About page and the update notice
// tell the truth: package.json, the page's APP_VERSION and the top of its
// "What's new", and the service worker's cache name (changing it each release
// is what makes phones fetch the new Pulse).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('one version: package.json, the app, its What’s new, and the service worker', () => {
  const js = read('app.js');
  assert.strictEqual((js.match(/const APP_VERSION = '([^']+)'/) || [])[1], pkg.version);
  assert.strictEqual((js.match(/const CHANGES = \[\s*\['([^']+)'/) || [])[1], pkg.version, 'What’s new starts with this version');
  assert.strictEqual((read('sw.js').match(/const VERSION = 'pulse-([^']+)'/) || [])[1], pkg.version);
  assert.match(pkg.released || '', /^\d{4}-\d{2}-\d{2}$/);
});

test('the service worker saves every file of the app it names', () => {
  const sw = read('sw.js');
  const shell = JSON.parse((sw.match(/const SHELL = (\[[^\]]+\])/) || [])[1].replace(/'/g, '"'));
  for (const f of shell) {
    const p = f === '/' ? 'index.html' : f.slice(1);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', p)), `${f} exists`);
  }
});
