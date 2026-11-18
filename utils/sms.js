// mNotify (Ghana). Urgent alerts only — see core/channels.js.
const { logNotification } = require('./notifications');

module.exports = require('@deontech/notify').createSms({
  logNotification,
  defaultSenderId: 'DeonPulse',   // max 11 chars, must be approved by mNotify
});
