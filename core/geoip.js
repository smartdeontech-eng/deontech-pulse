// Country lookup for login IPs, done locally.
//
// Uses DB-IP's free "IP to Country Lite" database (CC BY 4.0 — attribution is
// on the Access page). scripts/geoip-update.sh downloads it monthly to
// /var/lib/pulse/dbip-country-lite.csv. Login IPs are never sent to anyone.
//
// The CSV is ~600k rows of "start,end,CC". IPv4 ranges go into Uint32Arrays;
// IPv6 ranges are indexed by their top 64 bits (BigUint64Array), which is
// finer than any country boundary. Lookup is a binary search. No file, or a
// bad one, means every country reads "unknown" — never a crash.
'use strict';
const fs = require('fs');
const readline = require('readline');
const { parseIp } = require('./trust');

let v4 = null;
let v6 = null;
let loadedFrom = null;

// Parsing ~600k CSV rows costs ~20 s of CPU and a lot of memory, so the
// packed tables are cached beside the CSV and reused until the CSV changes.
function cachePath(file) { return `${file}.packed`; }

function saveCache(file) {
  try {
    const codes = (t) => t.C.map((c) => (c + '  ').slice(0, 2)).join('');
    const parts = [Buffer.from(v4.S.buffer), Buffer.from(v4.E.buffer), Buffer.from(codes(v4), 'latin1'), Buffer.from(v6.S.buffer), Buffer.from(v6.E.buffer), Buffer.from(codes(v6), 'latin1')];
    const head = Buffer.from(JSON.stringify({ mtime: fs.statSync(file).mtimeMs, n4: v4.S.length, n6: v6.S.length }) + '\n');
    const tmp = `${cachePath(file)}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([head, ...parts]));
    fs.renameSync(tmp, cachePath(file));
  } catch { /* cache is an optimisation only */ }
}

function loadCache(file) {
  try {
    const buf = fs.readFileSync(cachePath(file));
    const nl = buf.indexOf(10);
    const h = JSON.parse(buf.subarray(0, nl).toString());
    if (h.mtime !== fs.statSync(file).mtimeMs) return false;
    let o = nl + 1;
    const take = (n) => { const c = new Uint8Array(n); c.set(buf.subarray(o, o + n)); o += n; return c; };   // own buffer, offset 0: aligned for typed arrays
    const u32 = (n) => { const b = take(n * 4); return new Uint32Array(b.buffer, b.byteOffset, n); };
    const u64 = (n) => { const b = take(n * 8); return new BigUint64Array(b.buffer, b.byteOffset, n); };
    const cc = (n) => { const str = Buffer.from(take(n * 2)).toString('latin1'); return Array.from({ length: n }, (_, i) => str.slice(i * 2, i * 2 + 2).trim()); };
    v4 = { S: u32(h.n4), E: u32(h.n4), C: cc(h.n4) };
    v6 = { S: u64(h.n6), E: u64(h.n6), C: cc(h.n6) };
    loadedFrom = file;
    return { ok: true, v4: h.n4, v6: h.n6, cached: true };
  } catch { return false; }
}

async function load(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, reason: 'missing' };
  const cached = loadCache(file);
  if (cached) return cached;
  const s4 = [], e4 = [], c4 = [], s6 = [], e6 = [], c6 = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const [a, b, cc] = line.split(',').map((x) => x.replace(/"/g, '').trim());
    if (!cc) continue;
    const pa = parseIp(a), pb = parseIp(b);
    if (!pa || !pb || pa.v !== pb.v) continue;
    if (pa.v === 4) { s4.push(Number(pa.n)); e4.push(Number(pb.n)); c4.push(cc); }
    else { s6.push(pa.n >> 64n); e6.push(pb.n >> 64n); c6.push(cc); }
  }
  v4 = pack(s4, e4, c4, Uint32Array);
  v6 = pack(s6, e6, c6, BigUint64Array);
  loadedFrom = file;
  saveCache(file);
  return { ok: true, v4: s4.length, v6: s6.length };
}

function pack(starts, ends, codes, T) {
  const order = starts.map((_, i) => i).sort((x, y) => (starts[x] < starts[y] ? -1 : starts[x] > starts[y] ? 1 : 0));
  const S = new T(order.length), E = new T(order.length);
  const C = new Array(order.length);
  order.forEach((j, i) => { S[i] = starts[j]; E[i] = ends[j]; C[i] = codes[j]; });
  return { S, E, C };
}

function search(t, key) {
  if (!t || !t.S.length) return null;
  let lo = 0, hi = t.S.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.S[mid] <= key) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 && key <= t.E[found] ? t.C[found] : null;
}

function isPrivate(p) {
  if (p.v === 4) {
    const n = Number(p.n);
    const a = n >>> 24, b = (n >>> 16) & 255;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  const top = p.n >> 112n;
  return p.n === 1n || (top & 0xfe00n) === 0xfc00n || (top & 0xffc0n) === 0xfe80n;
}

function country(ip) {
  const p = parseIp(ip);
  if (!p) return null;
  if (isPrivate(p)) return 'LAN';
  return p.v === 4 ? search(v4, Number(p.n)) : search(v6, p.n >> 64n);
}

module.exports = { load, country, loaded: () => !!loadedFrom, isPrivate };
