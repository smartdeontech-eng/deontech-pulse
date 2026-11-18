// Phase 3 (early): "disk full in ~23 days".
//
// A least-squares line through the last 7 days of hourly disk use. Only
// reported when the trend is clearly upward and the fit is decent, so a
// one-off spike (a big upload, a backup) doesn't produce a scary date.
'use strict';

function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
  const den = n * sxx - sx * sx;
  if (!den) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  const ssRes = points.reduce((acc, [x, y]) => acc + (y - (slope * x + intercept)) ** 2, 0);
  return { slope, intercept, r2: ssTot ? 1 - ssRes / ssTot : 0 };
}

/**
 * @param rows [{ ts, disk }] hourly, oldest first
 * @returns { daysLeft, perDay, r2 } or null when there's no meaningful upward trend
 */
function diskForecast(rows, now = Date.now(), { fullAt = 100, minHours = 48 } = {}) {
  const pts = rows.filter((r) => typeof r.disk === 'number').map((r) => [(r.ts - now) / 86400_000, r.disk]);
  if (pts.length < minHours) return null;
  const f = linearFit(pts);
  if (!f || f.slope <= 0.05 || f.r2 < 0.5) return null;   // < 0.05 %/day is noise
  const current = f.intercept;                          // fitted value at x = 0 (now)
  const daysLeft = (fullAt - current) / f.slope;
  if (!Number.isFinite(daysLeft) || daysLeft < 0) return null;
  return { daysLeft: Math.round(daysLeft), perDay: Math.round(f.slope * 100) / 100, r2: Math.round(f.r2 * 100) / 100 };
}

module.exports = { linearFit, diskForecast };
