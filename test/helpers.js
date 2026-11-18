// Shared test setup: a throwaway data directory and a configured core.
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
  const { createSqliteDatastore } = require('@deontech/db');
  const db = createSqliteDatastore({ dbPath: path.join(dir, 'pulse.db') });
  require('../core/store').init(db);
  return { db, dir };
}

function settingsStub(over = {}) {
  const base = {
    shortName: 'DeonTech Pulse', timezones: ['Africa/Accra', 'America/Toronto'], usualCountries: ['GH', 'CA'],
    thresholds: { diskWarnPct: 85, diskCritPct: 95, memCritPct: 90, cpuCritPct: 90, sustainMinutes: 5, swapWarnPct: 90, sslDays: [30, 14, 3], backupMaxAgeHours: 26, failedBurstCount: 20, failedBurstMinutes: 5, healthFailuresBeforeAlert: 2 },
    channels: { push: true, sms: true, email: true, whatsapp: false },
    quietHours: { enabled: false, start: '23:00', end: '06:00' },
    maintenanceUntil: null, appOverrides: {}, ownerPhone: '+233244000000', ownerEmail: 'owner@example.com',
  };
  let s = { ...base, ...over };
  const fn = () => s;
  fn.set = (o) => { s = { ...s, ...o }; };
  return fn;
}

function fakeChannels() {
  const sent = [];
  return { sent, deliver: async (alert, opts = {}) => { sent.push({ alert, opts }); return []; } };
}

module.exports = { tmpDb, settingsStub, fakeChannels };
