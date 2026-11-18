// Pulse's own settings: thresholds, channels, quiet hours. Editable from the
// Alerts and Settings pages; secrets never live here (they are in
// /etc/pulse.env), only choices.
const { createSettingsStore } = require('@deontech/db');

const DEFAULTS = {
  companyName: 'Smart DeonTech Limited',
  shortName: 'DeonTech Pulse',
  currencySymbol: 'GH₵',   // read by the shared mailer; unused here

  // Who gets told. Phone in international form, e.g. +233244000000.
  ownerPhone: '',
  ownerEmail: '',

  // Home time zone first. Only the first entry is used now: a second clock is
  // shown only while the owner is away, from the zone their devices report
  // (core/zones.js), not from a fixed list.
  timezones: ['Africa/Accra'],

  // A login with a trusted key from a new network in one of these countries
  // goes to the morning digest; from anywhere else it's a push.
  usualCountries: ['GH', 'CA'],

  thresholds: {
    diskWarnPct: 85,
    diskCritPct: 95,
    memCritPct: 90,
    cpuCritPct: 90,
    sustainMinutes: 5,
    swapWarnPct: 90,
    sslDays: [30, 14, 3],
    backupMaxAgeHours: 26,
    failedBurstCount: 20,
    failedBurstMinutes: 5,
    healthFailuresBeforeAlert: 2,
  },

  channels: {
    push: true,
    sms: true,        // urgent only
    email: true,      // warnings + urgent
    whatsapp: false,  // until the Business API is approved
  },

  // Local to the first time zone above (Accra). Urgent alerts ignore quiet
  // hours; warnings wait until they end.
  quietHours: { enabled: false, start: '23:00', end: '06:00' },

  // Maintenance mode: until this ISO instant, service-down and health alerts
  // are held. Access alerts never are.
  maintenanceUntil: null,
  maintenanceNote: '',

  // Per-app overrides found by discovery: { "<appId>": { name, healthPath, ignore } }
  appOverrides: {
    pman: { name: 'pman' },
  },

  // Morning digest (local time, first zone).
  digestTime: '07:00',

  // Backups made by Pulse: which apps are backed up every night, and when
  // (local time, first zone). { "<appId>": { nightly: true, offsite: true } }
  backupSchedule: {},
  backupTime: '01:40',
  backupLastNightly: null,
};

const store = createSettingsStore({ dataDir: require('./dataDir'), defaults: DEFAULTS });

// The core store merges one level deep. Pulse keeps nested groups, so a saved
// { thresholds: { diskWarnPct: 80 } } must not erase every other threshold.
const NESTED = ['thresholds', 'channels', 'quietHours', 'appOverrides'];
function getSettings() {
  const s = store.getSettings();
  for (const k of NESTED) s[k] = { ...DEFAULTS[k], ...(s[k] || {}) };
  return s;
}
function updateSettings(patch) {
  const cur = getSettings();
  const next = { ...patch };
  for (const k of NESTED) if (patch[k]) next[k] = { ...cur[k], ...patch[k] };
  store.updateSettings(next);
  return getSettings();
}

module.exports = { getSettings, updateSettings, DEFAULTS };
