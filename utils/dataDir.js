// Where this app's records live. One definition, used by both the datastore
// and the settings store — they must never resolve to different folders.
const fs = require('fs');
const path = require('path');

// Load the environment HERE rather than only in server.js, so every entry
// point (the server, create-owner, trust, set-password) opens the same
// database. On the server the secrets live in /etc/pulse.env (systemd reads
// it for the service; scripts read it from here). dotenv never overrides a
// variable that is already set.
require('dotenv').config({ quiet: true });
const SERVER_ENV = process.env.PULSE_ENV_FILE || '/etc/pulse.env';
try { if (fs.existsSync(SERVER_ENV)) require('dotenv').config({ path: SERVER_ENV, quiet: true }); } catch { /* not readable by this user: fine */ }

module.exports = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
