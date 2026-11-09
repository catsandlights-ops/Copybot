/**
 * Market scanner: picks coins worth buying on their own, from GeckoTerminal's trending, new and
 * top-volume pools. Pure (no network, no clock reads), so the rules are unit-tested; the server
 * runs it every few minutes and hands the best signal to the engine, which still runs every
 * buy check (limits, liquidity, holders, rug and honeypot checks) before buying.
 *
 * What counts as a signal: a coin that is rising right now on real buying, not one that already
 * ran. Up over the last hour but not too far, more buys than sells, more volume than usual, and
 * not falling in the last 5 minutes.
 */
import type { PoolRow } from './markets';

export type CoinSignal = {
  mint: string;
  pool: string;
  symbol: string;
  kind: 'new' | 'old';
  ageHours: number;
  priceUsd: number | null;
  liquidityUsd: number;
  change1hPct: number;
  buySellRatio: number;
  volumeSurge: number; // last hour's volume vs its 24h hourly average
  score: number;
  why: string;
};

export type SignalOpts = {
  newCoins: boolean;
  oldCoins: boolean;
  minLiquidityUsd?: number; // the user's own liquidity filter, if stricter
  skip?: Set<string>; // held, bought recently, blacklisted
};

const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const HOUR = 3_600_000;
const NEW_MAX_MS = 7 * 24 * HOUR;

/** Thresholds per kind of coin. Older coins move less, so they need less of a move but more depth. */
const RULES = {
  new: { minLiq: 25_000, minVol24: 100_000, minBuys1h: 60, minUp: 8, maxUp: 60, maxUp24: 400 },
  old: { minLiq: 100_000, minVol24: 400_000, minBuys1h: 80, minUp: 4, maxUp: 25, maxUp24: 120 },
};

/** Every coin that passes, best first. */
export function coinSignals(rows: PoolRow[], now: number, opts: SignalOpts): CoinSignal[] {
  // One entry per coin: its deepest pool.
  const best = new Map<string, PoolRow>();
  for (const r of rows) {
    if (SKIP_MINTS.has(r.mint) || opts.skip?.has(r.mint)) continue;
    const prev = best.get(r.mint);
    if (!prev || (r.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) best.set(r.mint, r);
  }
  const out: CoinSignal[] = [];
  for (const r of best.values()) {
    if (!r.createdAt) continue;
    const age = now - r.createdAt;
    if (age < HOUR) continue; // brand-new launches are mostly snipers and rugs
    const kind = age <= NEW_MAX_MS ? 'new' : 'old';
    if (kind === 'new' ? !opts.newCoins : !opts.oldCoins) continue;
    const k = RULES[kind];
    const liq = r.liquidityUsd ?? 0;
    const vol24 = r.volume24h ?? 0;
    if (liq < Math.max(k.minLiq, opts.minLiquidityUsd ?? 0) || vol24 < k.minVol24) continue;
    const up1h = r.change.h1;
    if (up1h == null || up1h < k.minUp || up1h > k.maxUp) continue; // rising, but hasn't already run
    if ((r.change.h24 ?? 0) > k.maxUp24) continue; // exhausted
    if (r.change.m5 != null && r.change.m5 < -3) continue; // falling right now
    const buys = r.buys1h ?? 0;
    const sells = r.sells1h ?? 0;
    if (buys < k.minBuys1h) continue;
    const ratio = buys / Math.max(1, sells);
    if (ratio < 1.2) continue; // more buyers than sellers
    const surge = r.volume1h != null && vol24 > 0 ? r.volume1h / (vol24 / 24) : 1;
    if (surge < 1.3) continue; // busier than usual
    const score = Math.min(up1h, k.maxUp) * Math.min(ratio, 3) * Math.min(surge, 4) * (kind === 'old' ? 1.5 : 1);
    out.push({
      mint: r.mint,
      pool: r.pool,
      symbol: r.symbol,
      kind,
      ageHours: Math.round(age / HOUR),
      priceUsd: r.priceUsd,
      liquidityUsd: liq,
      change1hPct: up1h,
      buySellRatio: Math.round(ratio * 10) / 10,
      volumeSurge: Math.round(surge * 10) / 10,
      score,
      why: `up ${up1h.toFixed(0)}% in the last hour, ${ratio.toFixed(1)}× more buys than sells, ${surge.toFixed(1)}× its usual volume`,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Scanner positions held longer than the limit (0 = no limit). */
export const overHeld = (openedAt: number, now: number, maxHoldHours: number) => maxHoldHours > 0 && now - openedAt >= maxHoldHours * HOUR;
