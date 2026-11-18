const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, settingsStub, fakeChannels } = require('./helpers');
const { createAlerts, inQuietHours } = require('../core/alerts');

function setup(over) {
  const { db } = tmpDb();
  const ch = fakeChannels();
  let now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const getSettings = settingsStub(over);
  const a = createAlerts({ db, channels: ch, getSettings, now: () => now, log: { error() {} } });
  return { db, ch, a, getSettings, tick: (ms) => { now += ms; }, flush: () => new Promise((r) => setImmediate(r)) };
}

test('raise opens once, repeats update it, cool-down limits messages, resolve sends one', async () => {
  const { a, ch, tick, flush } = setup();
  a.raise({ key: 'health:x', rule: 'health', severity: 'critical', title: 'X is down' });
  tick(60_000); a.raise({ key: 'health:x', rule: 'health', severity: 'critical', title: 'X is down' });
  tick(60_000); a.raise({ key: 'health:x', rule: 'health', severity: 'critical', title: 'X is down' });
  await flush();
  assert.strictEqual(ch.sent.length, 1, 'no repeat inside the 30 min cool-down');
  assert.strictEqual(a.list().length, 1);
  assert.strictEqual(a.list()[0].occurrences, 3);
  tick(31 * 60_000); a.raise({ key: 'health:x', rule: 'health', severity: 'critical', title: 'X is down' });
  await flush();
  assert.strictEqual(ch.sent.length, 2, 'reminder after the cool-down');
  a.resolve('health:x');
  await flush();
  assert.strictEqual(ch.sent.length, 3);
  assert.strictEqual(ch.sent[2].opts.resolved, true);
  assert.strictEqual(a.list().length, 0);
  assert.strictEqual(a.resolve('health:x'), null, 'resolving twice is harmless');
});

test('a warning that becomes critical notifies at once', async () => {
  const { a, ch, tick, flush } = setup();
  a.raise({ key: 'disk:/', rule: 'disk', severity: 'warning', title: 'Disk 86%' });
  tick(60_000); a.raise({ key: 'disk:/', rule: 'disk', severity: 'critical', title: 'Disk 96%' });
  await flush();
  assert.strictEqual(ch.sent.length, 2);
  assert.strictEqual(a.list()[0].severity, 'critical');
});

test('acknowledged alerts stay quiet; snoozed ones come back', async () => {
  const { a, ch, tick, flush } = setup();
  const x = a.raise({ key: 'k', rule: 'cpu', severity: 'critical', title: 'CPU' });
  a.ack(x.id);
  tick(40 * 60_000); a.raise({ key: 'k', rule: 'cpu', severity: 'critical', title: 'CPU' });
  await flush();
  assert.strictEqual(ch.sent.length, 1, 'acknowledged: no reminders');
  const y = a.raise({ key: 'k2', rule: 'cpu', severity: 'critical', title: 'CPU2' });
  a.snooze(y.id, 60);
  tick(30 * 60_000); a.raise({ key: 'k2', rule: 'cpu', severity: 'critical', title: 'CPU2' });
  await flush();
  assert.strictEqual(ch.sent.length, 2, 'snoozed: silent');
  tick(31 * 60_000); a.raise({ key: 'k2', rule: 'cpu', severity: 'critical', title: 'CPU2' });
  await flush();
  assert.strictEqual(ch.sent.length, 3, 'snooze over: notifies again');
});

test('maintenance holds health alerts but never access alerts', () => {
  const { a, getSettings } = setup();
  getSettings.set({ maintenanceUntil: new Date(Date.UTC(2026, 9, 9, 13, 0, 0)).toISOString() });
  assert.strictEqual(a.raise({ key: 'health:x', rule: 'health', severity: 'critical', title: 'down' }), null);
  assert.ok(a.raise({ key: 'access:1', rule: 'access', severity: 'critical', title: 'root login' }));
});

test('answers: yes closes, no escalates and keeps it open', async () => {
  const { a, ch, flush } = setup();
  const x = a.raise({ key: 'access:1', rule: 'access', severity: 'warning', title: 'login' });
  a.answer(x.id, true);
  assert.strictEqual(a.get(x.id).status, 'resolved');
  const y = a.raise({ key: 'access:2', rule: 'access', severity: 'warning', title: 'login' });
  a.answer(y.id, false);
  await flush();
  const row = a.get(y.id);
  assert.deepStrictEqual([row.status, row.severity, row.answer], ['open', 'critical', 'no']);
  assert.match(ch.sent[ch.sent.length - 1].alert.title, /^Not you/);
});

test('quiet hours wrap past midnight, in Accra time', () => {
  const qh = { enabled: true, start: '23:00', end: '06:00' };
  assert.ok(inQuietHours(qh, Date.UTC(2026, 9, 9, 2, 0), 'Africa/Accra'));
  assert.ok(!inQuietHours(qh, Date.UTC(2026, 9, 9, 12, 0), 'Africa/Accra'));
  assert.ok(inQuietHours(qh, Date.UTC(2026, 9, 9, 23, 30), 'Africa/Accra'));
  assert.ok(!inQuietHours({ ...qh, enabled: false }, Date.UTC(2026, 9, 9, 2, 0)));
});

test('warnings in quiet hours are delivered quietly; urgent ones are not', async () => {
  const { a, ch, flush } = setup({ quietHours: { enabled: true, start: '00:00', end: '23:59' } });
  a.raise({ key: 'w', rule: 'disk', severity: 'warning', title: 'w' });
  a.raise({ key: 'c', rule: 'disk', severity: 'critical', title: 'c' });
  await flush();
  assert.strictEqual(ch.sent[0].opts.quiet, true);
  assert.strictEqual(ch.sent[1].opts.quiet, false);
});

test('an acknowledged warning that turns critical reopens and notifies', async () => {
  const { a, ch, tick, flush } = setup();
  const w = a.raise({ key: 'disk:/', rule: 'disk', severity: 'warning', title: 'Disk 86%' });
  a.ack(w.id);
  tick(60_000);
  a.raise({ key: 'disk:/', rule: 'disk', severity: 'critical', title: 'Disk 96%' });
  await flush();
  const row = a.get(w.id);
  assert.deepStrictEqual([row.status, row.severity], ['open', 'critical']);
  assert.strictEqual(ch.sent.length, 2);
});

test('close: the owner dismisses a one-off notice; it comes back only if raised again', () => {
  const { a } = setup();
  const x = a.raise({ key: 'inventory:port:added:3001', rule: 'inventory', severity: 'warning', title: 'New listening port: 3001 on *' });
  a.ack(x.id);
  const c = a.close(x.id, 'owner@example.com');
  assert.strictEqual(c.status, 'resolved');
  assert.strictEqual(a.activeByKey('inventory:port:added:3001'), null);
  const again = a.raise({ key: 'inventory:port:added:3001', rule: 'inventory', severity: 'warning', title: 'New listening port: 3001 on *' });
  assert.notStrictEqual(again.id, x.id, 'a new alert, not the closed one');
});
