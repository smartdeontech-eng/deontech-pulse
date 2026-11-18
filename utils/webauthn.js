// getRP() is shared; the passkey library stays this app's own dependency.
module.exports = {
  getRP: require('@deontech/identity').getRP,
  ...require('@simplewebauthn/server'),
};
