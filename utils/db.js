// SQLite datastore. Users, sign-ins and settings live in the core's document
// collections; time series, events and alerts live in real tables beside them
// (see core/store.js), in the same file and the same transaction domain.
const path = require('path');
const { createSqliteDatastore } = require('@deontech/db');

module.exports = createSqliteDatastore({
  dbPath: process.env.DB_PATH || path.join(require('./dataDir'), 'pulse.db'),
});
