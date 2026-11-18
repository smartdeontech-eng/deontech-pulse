// Delivery failures (SMS, email) recorded where the owner will see them.
// The fan-out hook is set late by core/channels.js so that a failed SMS shows
// up on the Alerts page rather than only in the journal.
let hook = null;
const log = require('@deontech/notify').createNotificationLog({
  db: require('./db'),
  onNotification: (n) => { if (hook) hook(n); },
});
log.setHook = (fn) => { hook = fn; };
module.exports = log;
