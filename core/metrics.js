// The collector. Samples the machine every 2 seconds straight from /proc,
// keeps 15 minutes in memory for the live view, and hands each sample to the
// rollup for storage and to the bus for the stream and the alert rules.
//
// Nothing here needs root or spawns a process; systeminformation is used only
// once, for the static facts (distro, CPU model).
'use strict';
const os = require('os');
const bus = require('./bus');
const { createProcReader } = require('./procfs');

const SAMPLE_MS = 2000;
const PROC_EVERY = 5;          // top processes every 5th sample = 10 s
const RING_SIZE = 450;         // 15 minutes of 2 s samples

// Real filesystems only. overlay/tmpfs/squashfs would put a snap's 100%-full
// loop device on the dashboard as a red disk.
const REAL_FS = /^(ext[234]|xfs|btrfs|zfs|vfat|f2fs)$/i;

function createCollector({ si = require('systeminformation'), reader = createProcReader(), rollup, intervalMs = SAMPLE_MS } = {}) {
  const ring = [];
  let latest = null;
  let processes = [];
  let timer = null;
  let n = 0;
  let busy = false;

  async function sample() {
    if (busy) return null;
    busy = true;
    try {
      // Plain file reads from /proc and statfs(): no child processes (see procfs.js).
      const r = reader.sample();
      const m = r.mem;
      const s = {
        ts: Date.now(),
        cpu: round(r.cpu),
        cores: r.cores.map(round),
        mem: round((m.used / m.total) * 100),
        memUsed: m.used, memTotal: m.total,
        swap: m.swapTotal ? round((m.swapUsed / m.swapTotal) * 100) : 0,
        swapUsed: m.swapUsed, swapTotal: m.swapTotal,
        disk: r.disks.length ? Math.max(...r.disks.map((d) => d.pct)) : null,
        disks: r.disks.map((d) => ({ mount: d.mount, fs: d.fs, type: d.type, size: d.size, used: d.used, pct: d.pct })),
        rx: round(r.rx), tx: round(r.tx), rd: round(r.rd), wr: round(r.wr),
        load1: round(os.loadavg()[0]),
        load: os.loadavg().map(round),
        uptime: os.uptime(),
      };
      if (n++ % PROC_EVERY === 0) processes = reader.processes(10, s.ts, m.total);
      latest = s;
      if (s.cpu != null) {          // the very first reading has no CPU delta yet
        ring.push(compact(s));
        if (ring.length > RING_SIZE) ring.shift();
        if (rollup) rollup.add(compact(s));
      }
      bus.emit('sample', s);
      return s;
    } catch (e) {
      console.error('[collector]', e.message);
      return null;
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    sample();
    timer = setInterval(sample, intervalMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; if (rollup) rollup.flush(); }

  return {
    start, stop, sample,
    latest: () => latest,
    ring: () => ring.slice(),
    processes: () => processes,
    staticInfo: async () => {
      const [osInfo, cpu, sys] = await Promise.all([si.osInfo(), si.cpu(), si.system().catch(() => ({}))]);
      return {
        hostname: osInfo.hostname, distro: `${osInfo.distro} ${osInfo.release}`, kernel: osInfo.kernel, arch: osInfo.arch,
        cpu: `${cpu.manufacturer} ${cpu.brand}`.trim(), cores: cpu.cores, model: sys.model || '',
      };
    },
  };
}

// What goes to storage and the ring: numbers only.
function compact(s) {
  return { ts: s.ts, cpu: s.cpu, mem: s.mem, swap: s.swap, disk: s.disk, rx: s.rx, tx: s.tx, rd: s.rd, wr: s.wr, load1: s.load1 };
}
function round(v) { return v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10; }

module.exports = { createCollector, compact, REAL_FS };
