const test = require('node:test');
const assert = require('node:assert');
const p = require('../core/procfs');

test('CPU percent from two /proc/stat readings', () => {
  const a = p.parseStat('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\n');
  const b = p.parseStat('cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 100 0 50 450 0 0 0 0 0 0\n');
  assert.strictEqual(Math.round(p.cpuPercent(a.cpu, b.cpu)), 50);
  assert.strictEqual(Math.round(p.cpuPercent(a.cpu0, b.cpu0)), 50);
});

test('memory uses MemAvailable, swap from SwapFree', () => {
  const m = p.parseMeminfo('MemTotal:       8000000 kB\nMemFree:  100 kB\nMemAvailable:   6000000 kB\nSwapTotal:      2000000 kB\nSwapFree:        500000 kB\n');
  assert.strictEqual(m.used, 2000000 * 1024);
  assert.strictEqual(m.swapUsed, 1500000 * 1024);
});

test('network skips loopback; disk IO counts whole disks only', () => {
  const n = p.parseNetDev('Inter-|\n face |\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n');
  assert.deepStrictEqual(n, { rx: 1000, tx: 2000 });
  const d = p.parseDiskstats('   8       0 sda 100 0 10 0 50 0 20 0 0 0 0\n   8       1 sda1 100 0 10 0 50 0 20 0 0 0 0\n   7       0 loop0 1 0 99 0 1 0 99 0 0 0 0\n');
  assert.deepStrictEqual(d, { rd: 10 * 512, wr: 20 * 512 });
});

test('mounts: real filesystems once each; process stat with spaces in the name', () => {
  const m = p.parseMounts('/dev/sda2 / ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/sda2 /var/lib/docker ext4 rw 0 0\n/dev/sdb1 /mnt/my\\040disk xfs rw 0 0\n');
  assert.deepStrictEqual(m.map((x) => x.mount), ['/', '/mnt/my disk']);
  const s = p.parsePidStat('1234 (Web Content) S 1 1 1 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 10 0 100 1000000 2560 18446744073709551615');
  assert.strictEqual(s.comm, 'Web Content');
  assert.strictEqual(s.ticks, 300);
  assert.strictEqual(s.rss, 2560 * 4096);
});

test('the live reader spawns nothing and returns sane numbers', async () => {
  const r = p.createProcReader();
  r.sample(Date.now() - 1000);
  const s = r.sample();
  assert.ok(s.cpu >= 0 && s.cpu <= 100);
  assert.ok(s.mem.total > 0);
  assert.ok(Array.isArray(s.disks));
  const procs = r.processes(5);
  assert.ok(procs.length > 0 && procs[0].pid > 0);
});
