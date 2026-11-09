/**
 * Small time series for live charts: [time ms, value] points, kept compact.
 * Pure helpers, unit-tested.
 */
export type Pt = [number, number];

/**
 * Append a point. When the series grows past `max`, the older half is thinned (every other
 * point dropped), so recent detail stays sharp and the whole history still fits.
 */
export function pushPoint(arr: Pt[], p: Pt, max = 400): Pt[] {
  const last = arr[arr.length - 1];
  if (last && p[0] <= last[0]) return arr; // never out of order or duplicated
  arr.push(p);
  if (arr.length > max) {
    const half = Math.floor(arr.length / 2);
    const older = arr.slice(0, half).filter((_, i) => i % 2 === 0);
    arr.splice(0, arr.length, ...older, ...arr.slice(half));
  }
  return arr;
}

/** At most n points, evenly spread, always keeping the first and the last. */
export function downsample(arr: Pt[], n: number): Pt[] {
  if (arr.length <= n || n < 2) return arr.slice();
  const out: Pt[] = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

/** Only points at or after `from`. */
export const since = (arr: Pt[], from: number): Pt[] => arr.filter((p) => p[0] >= from);

/** Running total of values over time (e.g. profit per sell -> profit so far). */
export function runningTotal(events: { t: number; v: number }[]): Pt[] {
  let sum = 0;
  return [...events].sort((a, b) => a.t - b.t).map((e) => [e.t, Math.round((sum += e.v) * 1e6) / 1e6] as Pt);
}
