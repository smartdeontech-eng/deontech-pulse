// Audit trail: who did what. entityType is your own noun ('invoice', 'minutes').
module.exports = require('@deontech/db').createActivityLog(require('./db'));
