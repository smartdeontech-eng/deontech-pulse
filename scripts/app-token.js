/**
 * Print the token an app uses to send its sign-ins to Pulse. Run on the server:
 *
 *   cd /opt/pulse && sudo -u pulse node scripts/app-token.js aotc-track
 *
 * Then put PULSE_APP=<id> and PULSE_APP_TOKEN=<token> in that app's env file
 * and restart it. The token is derived from PULSE_HOOK_TOKEN, so nothing is
 * stored; changing PULSE_HOOK_TOKEN changes every app's token.
 */
'use strict';
const fs = require('fs');
const { appToken } = require('../core/appsignins');

let hook = process.env.PULSE_HOOK_TOKEN;
if (!hook) {
  try {
    const m = fs.readFileSync('/etc/pulse.env', 'utf8').match(/^PULSE_HOOK_TOKEN='?([^'\n]+)'?$/m);
    if (m) hook = m[1];
  } catch { /* fall through */ }
}
const app = process.argv[2];
if (!app || !/^[a-z0-9][a-z0-9._-]{0,59}$/.test(app) || app === 'pulse') {
  console.error('Usage: node scripts/app-token.js <app-id>   e.g. aotc-track, ifaima, smart-deontech, ginasangel');
  process.exit(1);
}
if (!hook || hook.length < 24) { console.error('PULSE_HOOK_TOKEN not found (is /etc/pulse.env readable?).'); process.exit(1); }
console.log(`PULSE_APP=${app}`);
console.log(`PULSE_APP_TOKEN=${appToken(hook, app)}`);
