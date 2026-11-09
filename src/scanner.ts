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
  chain?: 'solana' | 'base';
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
  rules?: 'normal' | 'strict' | 'loose'; // which entry rules (see entryRulesFor)
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
export const RULES = {
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
    const e = entryRulesFor(kind, opts.rules ?? 'normal');
    if (up1h == null || up1h < e.minUp || up1h > e.maxUp) continue; // rising, but hasn't already run
    if ((r.change.h24 ?? 0) > e.maxUp24) continue; // exhausted
    if (r.change.m5 != null && r.change.m5 < -3) continue; // falling right now
    const buys = r.buys1h ?? 0;
    const sells = r.sells1h ?? 0;
    if (buys < k.minBuys1h) continue;
    const ratio = buys / Math.max(1, sells);
    if (ratio < 1.2) continue; // more buyers than sellers
    const surge = r.volume1h != null && vol24 > 0 ? r.volume1h / (vol24 / 24) : 1;
    if (surge < e.minSurge) continue; // busier than usual
    const score = Math.min(up1h, e.maxUp) * Math.min(ratio, 3) * Math.min(surge, 4) * (kind === 'old' ? 1.5 : 1);
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

// ---------------------------------------------------------------------------
// Proving the scanner: what would its exits have made on a signal?
// ---------------------------------------------------------------------------

import type { Candle } from './markets';

export type ScanExits = { stopLossPct: number; takeProfitPct: number; trailingAfterPct: number; trailingStopPct: number; maxHoldHours: number };
export type ExitReplay = { pnlPct: number; reason: string; exitAt: number; done: boolean; peakPct: number; troughPct: number };

/**
 * Replay the scanner's exits on price candles after an entry. Within a candle the low is checked
 * before the high (the cautious order). costPct = fees, slippage and buying a little late, taken
 * off the result. done = false when the candles end before any exit (result is the last price).
 */
export function replayExit(entryPrice: number, entryAt: number, candles: Candle[], x: ScanExits, costPct = 3): ExitReplay {
  let peak = entryPrice;
  let trough = entryPrice;
  const pct = (p: number) => (p / entryPrice - 1) * 100;
  const out = (price: number, reason: string, at: number, done: boolean): ExitReplay => ({
    pnlPct: Math.round((pct(price) - costPct) * 10) / 10,
    reason,
    exitAt: at,
    done,
    peakPct: Math.round(pct(peak) * 10) / 10,
    troughPct: Math.round(pct(trough) * 10) / 10,
  });
  const stop = entryPrice * (1 - x.stopLossPct / 100);
  const target = x.takeProfitPct > 0 ? entryPrice * (1 + x.takeProfitPct / 100) : Infinity;
  const holdUntil = x.maxHoldHours > 0 ? entryAt + x.maxHoldHours * 3_600_000 : Infinity;
  let last: Candle | null = null;
  for (const k of candles) {
    if (k.t < entryAt) continue;
    last = k;
    // Trailing stop: once up enough, sell on a drop from the highest point so far.
    const trailing = x.trailingStopPct > 0 && pct(peak) >= x.trailingAfterPct;
    const floor = trailing ? Math.max(stop, peak * (1 - x.trailingStopPct / 100)) : stop;
    trough = Math.min(trough, k.l);
    if (k.l <= floor) return out(floor, trailing && floor > stop ? 'trailing stop' : 'stop-loss', k.t, true);
    if (k.h >= target) {
      peak = Math.max(peak, k.h);
      return out(target, 'take-profit', k.t, true);
    }
    peak = Math.max(peak, k.h);
    if (x.trailingStopPct > 0 && pct(peak) >= x.trailingAfterPct && k.c <= peak * (1 - x.trailingStopPct / 100)) return out(k.c, 'trailing stop', k.t, true);
    if (k.t >= holdUntil) return out(k.c, 'time limit', k.t, true);
  }
  return last ? out(last.c, 'still open', last.t, false) : out(entryPrice, 'no price data yet', entryAt, false);
}

export type EntryRules = { minUp: number; maxUp: number; maxUp24: number; minSurge: number };
export const entryRulesFor = (kind: 'new' | 'old', variant: 'normal' | 'strict' | 'loose' = 'normal'): EntryRules => {
  const k = RULES[kind];
  const base = { minUp: k.minUp, maxUp: k.maxUp, maxUp24: k.maxUp24, minSurge: 1.3 };
  if (variant === 'strict') return { minUp: k.minUp * 1.5, maxUp: k.maxUp * 0.75, maxUp24: k.maxUp24 * 0.6, minSurge: 2 };
  if (variant === 'loose') return { minUp: k.minUp * 0.6, maxUp: k.maxUp * 1.4, maxUp24: k.maxUp24 * 1.5, minSurge: 1.1 };
  return base;
};

export type PastSignal = { at: number; price: number; up1hPct: number; surge: number; result: ExitReplay };

/**
 * Where the scanner's price and volume rules would have fired in a coin's past 5-minute candles,
 * and what each signal's exits would have made. Buyer/seller counts aren't available for the past,
 * so that rule can't be replayed. After a signal the coin is skipped until the trade closes and
 * for 6 hours after (as the live scanner does).
 */
export function replaySignals(candles: Candle[], step: number, rules: EntryRules, x: ScanExits, costPct = 3): PastSignal[] {
  const per = Math.round(3_600_000 / step); // candles per hour
  const out: PastSignal[] = [];
  let nextAllowed = 0;
  for (let i = per * 2; i < candles.length; i++) {
    const k = candles[i];
    if (k.t < nextAllowed) continue;
    const hourAgo = candles[i - per];
    if (!hourAgo || k.t - hourAgo.t > 1.5 * 3_600_000) continue; // gap in the data
    const up1h = (k.c / hourAgo.c - 1) * 100;
    if (up1h < rules.minUp || up1h > rules.maxUp) continue;
    const dayAgo = candles[Math.max(0, i - per * 24)];
    if ((k.c / dayAgo.c - 1) * 100 > rules.maxUp24) continue;
    if ((k.c / candles[i - 1].c - 1) * 100 < -3) continue; // falling right now
    // Volume in the last hour vs the average hour before it (up to a day back).
    const recent = candles.slice(i - per + 1, i + 1).reduce((a, c) => a + (c.v ?? 0), 0);
    const before = candles.slice(Math.max(0, i - per * 24), i - per + 1);
    const beforeHours = before.length / per;
    const avg = beforeHours >= 1 ? before.reduce((a, c) => a + (c.v ?? 0), 0) / beforeHours : 0;
    const surge = avg > 0 ? recent / avg : 0;
    if (surge < rules.minSurge) continue;
    const entryAt = k.t + step; // bought at the next candle
    const result = replayExit(k.c, entryAt, candles, x, costPct);
    out.push({ at: k.t, price: k.c, up1hPct: Math.round(up1h * 10) / 10, surge: Math.round(surge * 10) / 10, result });
    nextAllowed = Math.max(result.exitAt, entryAt) + 6 * 3_600_000;
  }
  return out;
}

export type SignalStats = { signals: number; closed: number; wins: number; avgPnlPct: number | null; totalSol: number; worstPct: number | null; bestPct: number | null };

/** Results of a set of replayed trades, each with `sol` put in. Open trades count at their last price. */
export function signalStats(results: ExitReplay[], sol: number): SignalStats {
  const n = results.length;
  const pnls = results.map((r) => r.pnlPct);
  return {
    signals: n,
    closed: results.filter((r) => r.done).length,
    wins: pnls.filter((p) => p > 0).length,
    avgPnlPct: n ? Math.round((pnls.reduce((a, b) => a + b, 0) / n) * 10) / 10 : null,
    totalSol: Math.round(pnls.reduce((a, p) => a + (sol * p) / 100, 0) * 10_000) / 10_000,
    worstPct: n ? Math.min(...pnls) : null,
    bestPct: n ? Math.max(...pnls) : null,
  };
}

/** Exit setups compared by "Test on the past": the current one plus a range of quick to patient. */
export function exitVariants(current: ScanExits): { id: string; name: string; exits: ScanExits }[] {
  const same = (a: ScanExits, b: ScanExits) => JSON.stringify(a) === JSON.stringify(b);
  const all = [
    { id: 'current', name: 'Your scanner exits', exits: current },
    { id: 'quick', name: 'Quick: stop −10%, take +20%', exits: { stopLossPct: 10, takeProfitPct: 20, trailingAfterPct: 10, trailingStopPct: 7, maxHoldHours: 4 } },
    { id: 'balanced', name: 'Balanced: stop −20%, take +50%', exits: { stopLossPct: 20, takeProfitPct: 50, trailingAfterPct: 15, trailingStopPct: 12, maxHoldHours: 12 } },
    { id: 'ride', name: 'Ride it: stop −25%, trailing stop, no target', exits: { stopLossPct: 25, takeProfitPct: 0, trailingAfterPct: 20, trailingStopPct: 15, maxHoldHours: 24 } },
    { id: 'tight', name: 'Tight: stop −7%, take +15%', exits: { stopLossPct: 7, takeProfitPct: 15, trailingAfterPct: 8, trailingStopPct: 5, maxHoldHours: 2 } },
  ];
  // Don't test the user's own exits twice when they match a preset.
  return all.filter((v, i) => i === 0 || !same(v.exits, current));
}
