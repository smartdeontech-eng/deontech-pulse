// Prints a VAPID key pair for web push, as lines for /etc/pulse.env.
// provision.sh runs this once; keep the keys — changing them unsubscribes every device.
const wp = require('web-push');
const k = wp.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
