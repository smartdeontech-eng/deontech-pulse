// One in-process event bus. The collector, watchers and alert engine publish;
// the SSE stream and the alert engine subscribe. Nothing here persists.
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(100);   // one listener per open dashboard tab
module.exports = bus;
