// Reading the machine straight from /proc and statfs(), in-process.
//
// Why not systeminformation for the 2-second loop: on the live server its
// processes() ran a shell with one `cat /proc/<pid>/stat` per process, and
// fsSize()/networkStats() spawn df, ip and friends on every call. Together
// that cost a quarter of a CPU core — a monitor must not be the load it
// measures. Everything here is a file read: no child processes at all.
// (systeminformation is still used once at start for the static facts.)
'use strict';
const fs = require('fs');
const os = require('os');

const CLK_TCK = 100;           // USER_HZ on Linux
const PAGE = 4096;
const REAL_FS = /^(ext[234]|xfs|btrfs|zfs|vfat|f2fs)$/i;

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ---- CPU -------------------------------------------------------------------
function parseStat(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('cpu')) continue;
    const [name, ...v] = line.trim().split(/\s+/);
    const n = v.map(Number);
    const idle = (n[3] || 0) + (n[4] || 0);                 // idle + iowait
    const total = n.slice(0, 8).reduce((a, b) => a + (b || 0), 0);   // excludes guest (already in user)
    out[name] = { idle, total };
  }
  return out;
}

function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - (cur.idle - prev.idle) / dt) * 100));
}

// ---- Memory ----------------------------------------------------------------
function parseMeminfo(text) {
  const m = {};
  for (const line of String(text || '').split('\n')) {
    const x = line.match(/^(\w+):\s+(\d+)/);
    if (x) m[x[1]] = Number(x[2]) * 1024;
  }
  const total = m.MemTotal || os.totalmem();
  const available = m.MemAvailable != null ? m.MemAvailable : os.freemem();
  return { total, used: total - available, available, swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0) };
}

// ---- Network ---------------------------------------------------------------
function parseNetDev(text) {
  let rx = 0, tx = 0;
  for (const line of String(text || '').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    const iface = name.trim();
    if (iface === 'lo' || /^(docker|veth|br-|virbr)/.test(iface)) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

// ---- Disk IO ---------------------------------------------------------------
// Whole disks only (sda, vda, nvme0n1, xvda) — partitions would double count.
function parseDiskstats(text) {
  let rd = 0, wr = 0;
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2];
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name)) continue;
    rd += Number(f[5]) * 512;
    wr += Number(f[9]) * 512;
  }
  return { rd, wr };
}

// ---- Filesystems -----------------------------------------------------------
function parseMounts(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const [dev, mount, type] = line.split(' ');
    if (!dev || !REAL_FS.test(type || '') || seen.has(dev)) continue;
    seen.add(dev);
    out.push({ fs: dev, mount: mount.replace(/\\040/g, ' '), type });
  }
  return out;
}

function diskUsage(mounts) {
  const out = [];
  for (const m of mounts) {
    try {
      const s = fs.statfsSync(m.mount);
      const size = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;                  // what a normal user can still write, as df shows
      const used = (s.blocks - s.bfree) * s.bsize;
      if (!size) continue;
      out.push({ ...m, size, used, pct: Math.round((used / (used + free)) * 1000) / 10 });
    } catch { /* unreadable mount: skip */ }
  }
  return out;
}

// ---- Processes -------------------------------------------------------------
function parsePidStat(text) {
  // pid (comm with spaces) state ppid ...  — comm may contain ')'
  const i = text.indexOf('(');
  const j = text.lastIndexOf(')');
  if (i < 0 || j < 0) return null;
  const comm = text.slice(i + 1, j);
  const f = text.slice(j + 2).split(' ');
  // f[0] = state (field 3); utime = field 14 -> f[11], stime -> f[12], rss = field 24 -> f[21]
  return { comm, state: f[0], ticks: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * PAGE };
}

let userMap = null;
let userMapAt = 0;
function userName(uid) {
  if (!userMap || Date.now() - userMapAt > 600_000) {
    userMap = {};
    for (const line of String(read('/etc/passwd') || '').split('\n')) {
      const f = line.split(':');
      if (f.length > 2) userMap[f[2]] = f[0];
    }
    userMapAt = Date.now();
  }
  return userMap[uid] || String(uid);
}

function createProcReader(root = '/proc') {
  let prevStat = null;
  let prevNet = null;
  let prevDisk = null;
  let prevProcs = new Map();      // pid -> ticks
  let prevProcAt = 0;
  let mounts = null;
  let mountsAt = 0;

  function sample(now = Date.now()) {
    const stat = parseStat(read(`${root}/stat`));
    const cores = Object.keys(stat).filter((k) => /^cpu\d+$/.test(k)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
    const cpu = prevStat ? cpuPercent(prevStat.v.cpu, stat.cpu) : null;
    const perCore = prevStat ? cores.map((k) => cpuPercent(prevStat.v[k], stat[k])) : cores.map(() => null);
    const net = parseNetDev(read(`${root}/net/dev`));
    const disk = parseDiskstats(read(`${root}/diskstats`));
    const secs = prevStat ? (now - prevStat.at) / 1000 : null;
    const rate = (a, b) => (secs && b != null && a != null ? Math.max(0, (a - b) / secs) : null);
    const out = {
      cpu, cores: perCore,
      mem: parseMeminfo(read(`${root}/meminfo`)),
      rx: rate(net.rx, prevNet && prevNet.rx), tx: rate(net.tx, prevNet && prevNet.tx),
      rd: rate(disk.rd, prevDisk && prevDisk.rd), wr: rate(disk.wr, prevDisk && prevDisk.wr),
    };
    // Mount list changes rarely; re-read it every minute. statfs itself is cheap.
    if (!mounts || now - mountsAt > 60_000) { mounts = parseMounts(read(`${root}/mounts`)); mountsAt = now; }
    out.disks = diskUsage(mounts);
    prevStat = { at: now, v: stat };
    prevNet = net;
    prevDisk = disk;
    return out;
  }

  // Top processes by CPU since the previous call (first call: by memory).
  function processes(limit = 10, now = Date.now(), memTotal = os.totalmem()) {
    let pids = [];
    try { pids = fs.readdirSync(root).filter((d) => /^\d+$/.test(d)); } catch { return []; }
    const elapsedTicks = prevProcAt ? ((now - prevProcAt) / 1000) * CLK_TCK : 0;
    const cur = new Map();
    const rows = [];
    for (const pid of pids) {
      const s = read(`${root}/${pid}/stat`);
      if (!s) continue;
      const p = parsePidStat(s);
      if (!p) continue;
      cur.set(pid, p.ticks);
      const before = prevProcs.get(pid);
      const cpu = elapsedTicks && before != null ? ((p.ticks - before) / elapsedTicks) * 100 : 0;
      rows.push({ pid: Number(pid), name: p.comm, cpu, rss: p.rss });
    }
    prevProcs = cur;
    prevProcAt = now;
    rows.sort((a, b) => (b.cpu - a.cpu) || (b.rss - a.rss));
    return rows.slice(0, limit).map((r) => {
      const status = read(`${root}/${r.pid}/status`) || '';
      const uid = (status.match(/^Uid:\s+(\d+)/m) || [])[1];
      const cmd = (read(`${root}/${r.pid}/cmdline`) || '').replace(/\0/g, ' ').trim();
      return { pid: r.pid, name: r.name, user: uid != null ? userName(uid) : '', cpu: round(r.cpu), mem: round((r.rss / memTotal) * 100), rss: r.rss, command: (cmd || `[${r.name}]`).slice(0, 80) };
    });
  }

  return { sample, processes };
}

function round(v) { return v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10; }

module.exports = { createProcReader, parseStat, cpuPercent, parseMeminfo, parseNetDev, parseDiskstats, parseMounts, parsePidStat, diskUsage };
