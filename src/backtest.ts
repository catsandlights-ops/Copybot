/**
 * Backtest: replay wallets' real swap history with the user's settings and estimate what copying
 * them would have made.
 *
 * Pricing: we fill AFTER the copied wallet, so every copied buy pays `delayPct` more per token than
 * they did and every copied sell gets `delayPct` less, plus a network fee per trade.
 *
 * Exits: we sell when the copied wallet sells (if "copy their sells" is on). When price candles are
 * given for a token, the stop-loss, staged take-profits and trailing stop are replayed too: the
 * token's SOL price between trades is estimated from the last real fill and the candles' USD moves.
 * Within one candle the low is checked before the high (the cautious order).
 *
 * Pure: no network. The server fetches the swaps, candles and current prices.
 */
import { exitConfigFor, walletRules, type Config } from './config';
import type { Swap } from './decode';
import type { Candle } from './markets';
import { buyBlockReason, ExitStep, freshGuard, GuardState, planExit, recordSell } from './rules';

/** endAt: value what's still held at this time (a past date range) instead of today. */
export type BacktestOpts = { delayPct: number; feeSol: number; endAt?: number };
export type PriceSeries = { step: number; candles: Candle[] };
export type BtTrade = { t: number; side: 'buy' | 'sell'; mint: string; wallet: string; sol: number; pnl?: number; reason?: string };
export type BtOpen = { mint: string; costSol: number; tokensRaw: number; valueSol: number | null; wallets: string[] };
export type BtWallet = { wallet: string; signals: number; copied: number; closed: number; wins: number; pnlSol: number };
export type BacktestResult = {
  from: number | null;
  to: number | null;
  realizedSol: number;
  unrealizedSol: number | null; // null when open positions couldn't be priced
  totalSol: number;
  peakExposureSol: number;
  spentSol: number; // total SOL put into copied buys
  roiPct: number | null; // total profit vs total SOL spent
  closed: number;
  wins: number;
  maxDrawdownSol: number;
  best: BtTrade | null;
  worst: BtTrade | null;
  curve: [number, number][]; // [time ms, cumulative realized SOL]
  skipped: Record<string, number>;
  wallets: BtWallet[];
  open: BtOpen[];
  trades: BtTrade[]; // newest first, capped
  exitsReplayed: { tokens: number; withPrices: number; exitSells: number };
};

type Pos = { mint: string; tokens: number; costSol: number; wallets: Set<string>; openedAt: number; steps: ExitStep[]; peakMultiple?: number };
type Anchor = { solPerRaw: number; usd: number | null };

/** Close of the candle covering time t (or the last one before it). */
export function usdAt(series: PriceSeries | undefined, t: number): number | null {
  if (!series) return null;
  let lo = 0;
  let hi = series.candles.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.candles[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && t - series.candles[found].t < series.step * 3 ? series.candles[found].c : null;
}

/** Replay the swaps. `marks` = current SOL per raw token for tokens still held; `prices` = candles per token. */
export function runBacktest(swaps: Swap[], cfg: Config, opts: BacktestOpts, marks: Map<string, number | null> = new Map(), prices: Map<string, PriceSeries> = new Map()): BacktestResult {
  const r = cfg.risk;
  const d = opts.delayPct / 100;
  const ordered = swaps
    .filter((s) => s.quote === 'SOL' && s.blockTime && s.tokenAmount > 0n && s.quoteAmount > 0 && (opts.endAt === undefined || s.blockTime * 1000 <= opts.endAt))
    .sort((a, b) => a.blockTime! - b.blockTime!);
  const positions = new Map<string, Pos>();
  const anchors = new Map<string, Anchor>();
  const cursor = new Map<string, number>();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const wallets = new Map<string, BtWallet>();
  const wal = (w: string) => wallets.get(w) ?? (wallets.set(w, { wallet: w, signals: 0, copied: 0, closed: 0, wins: 0, pnlSol: 0 }), wallets.get(w)!);
  const trades: BtTrade[] = [];
  const boughtMints = new Set<string>();
  let realized = 0;
  let exposure = 0;
  let peakExposure = 0;
  let spent = 0;
  let exitSells = 0;
  let guard: GuardState | null = null;

  /** Sell `fraction` of a position for `proceedsBeforeFee` SOL. */
  const sell = (p: Pos, fraction: number, proceedsBeforeFee: number, now: number, wallet: string, reason: string) => {
    const proceeds = Math.max(0, proceedsBeforeFee - opts.feeSol);
    const cost = p.costSol * fraction;
    const pnl = proceeds - cost;
    p.tokens -= p.tokens * fraction;
    p.costSol -= cost;
    exposure = Math.max(0, exposure - cost);
    if (fraction >= 0.999 || p.tokens <= 0) positions.delete(p.mint);
    realized += pnl;
    guard = recordSell(guard ?? freshGuard(now), pnl, r, now).guard;
    for (const src of p.wallets) {
      const ws = wal(src);
      ws.closed++;
      if (pnl > 0) ws.wins++;
      ws.pnlSol += pnl / p.wallets.size;
    }
    trades.push({ t: now, side: 'sell', mint: p.mint, wallet, sol: proceeds, pnl, reason });
  };

  /** Walk open positions through every candle that ended before `until`, running the exit plan. */
  const advance = (until: number) => {
    for (const p of [...positions.values()]) {
      const series = prices.get(p.mint);
      const a = anchors.get(p.mint);
      if (!series || !a?.usd) continue;
      let i = cursor.get(p.mint) ?? 0;
      const exitCfg = exitConfigFor(cfg, [...p.wallets]);
      for (; i < series.candles.length && positions.has(p.mint); i++) {
        const c = series.candles[i];
        if (c.t + series.step > until) break;
        if (c.t + series.step <= p.openedAt) continue;
        const valueAt = (usd: number) => p.tokens * a.solPerRaw * (usd / a.usd!) * (1 - d);
        // Low first (stop-loss / trailing stop), then the high (take-profits), cautious order.
        for (const usd of [c.l, c.h]) {
          for (let k = 0; k < 3 && positions.has(p.mint); k++) {
            const v = valueAt(usd);
            const { action, peakMultiple } = planExit(p, v, exitCfg);
            p.peakMultiple = peakMultiple;
            if (!action) break;
            if (action.step) p.steps.push(action.step);
            sell(p, action.fraction, v * action.fraction, c.t + series.step, [...p.wallets][0], action.reason);
            exitSells++;
          }
        }
      }
      cursor.set(p.mint, i);
    }
  };

  for (const s of ordered) {
    const now = s.blockTime! * 1000;
    advance(now);
    guard ??= freshGuard(now);
    const w = cfg.wallets.find((x) => x.address === s.wallet);
    const stats = wal(s.wallet);
    const theirPrice = s.quoteAmount / Number(s.tokenAmount); // SOL per raw token
    // Every real fill re-anchors the token's SOL price for the candle replay.
    anchors.set(s.mint, { solPerRaw: theirPrice, usd: usdAt(prices.get(s.mint), now) });

    if (s.side === 'buy') {
      stats.signals++;
      const blocked = buyBlockReason(guard, r, now);
      if (blocked) {
        skip(blocked.startsWith('daily') ? 'daily loss limit' : 'losing-streak pause');
        continue;
      }
      const held = positions.get(s.mint);
      if (held && r.skipIfAlreadyHolding) { skip('already holding'); continue; }
      if (!held && positions.size >= r.maxOpenPositions) { skip('max open positions'); continue; }
      if (s.quoteAmount < walletRules(cfg, s.wallet).minTargetBuySol) { skip('their buy too small'); continue; }
      let sol = cfg.buy.sizing === 'percent' ? (s.quoteAmount * cfg.buy.percentOfTarget) / 100 : cfg.buy.fixedSol;
      sol = Math.min(cfg.buy.maxSol, Math.max(cfg.buy.minSol, sol * (w?.sizeMultiplier ?? 1)));
      if (exposure + sol > r.maxTotalExposureSol) { skip('max SOL in trades'); continue; }
      if (w && w.maxExposureSol > 0) {
        let used = 0;
        for (const p of positions.values()) if (p.wallets.has(s.wallet)) used += p.costSol / p.wallets.size;
        if (used + sol > w.maxExposureSol) { skip('wallet budget used up'); continue; }
      }
      if (cfg.safety.blacklist.includes(s.mint)) { skip('blacklisted'); continue; }
      const p = held ?? { mint: s.mint, tokens: 0, costSol: 0, wallets: new Set<string>(), openedAt: now, steps: [] };
      p.tokens += sol / (theirPrice * (1 + d));
      p.costSol += sol + opts.feeSol;
      p.wallets.add(s.wallet);
      positions.set(s.mint, p);
      boughtMints.add(s.mint);
      exposure += sol + opts.feeSol;
      spent += sol + opts.feeSol;
      peakExposure = Math.max(peakExposure, exposure);
      stats.copied++;
      trades.push({ t: now, side: 'buy', mint: s.mint, wallet: s.wallet, sol });
    } else {
      const p = positions.get(s.mint);
      if (!p || !p.wallets.has(s.wallet) || !cfg.sell.copySells) continue;
      const fraction = s.tokenPost === 0n || s.tokenPre === 0n ? 1 : Math.min(1, Number(s.tokenAmount) / Number(s.tokenPre));
      sell(p, fraction, p.tokens * fraction * theirPrice * (1 - d), now, s.wallet, fraction >= 0.999 ? 'they sold everything' : `they sold ${Math.round(fraction * 100)}%`);
    }
  }
  advance(opts.endAt ?? Infinity);

  const open: BtOpen[] = [...positions.values()].map((p) => {
    let perRaw: number | null | undefined;
    if (opts.endAt !== undefined) {
      // Value at the end of the period from the candles, anchored on the last real fill.
      const a = anchors.get(p.mint);
      const u = usdAt(prices.get(p.mint), opts.endAt);
      perRaw = a?.usd && u ? a.solPerRaw * (u / a.usd) : null;
    } else perRaw = marks.get(p.mint);
    return { mint: p.mint, costSol: p.costSol, tokensRaw: p.tokens, valueSol: perRaw == null ? null : Math.max(0, p.tokens * perRaw * (1 - d) - opts.feeSol), wallets: [...p.wallets] };
  });
  const unrealizedSol = open.every((o) => o.valueSol !== null) ? open.reduce((a, o) => a + (o.valueSol! - o.costSol), 0) : null;
  // Unpriced open positions count as a total loss in the headline number (conservative).
  const unrealizedForTotal = open.reduce((a, o) => a + ((o.valueSol ?? 0) - o.costSol), 0);
  const sells = trades.filter((t) => t.side === 'sell').sort((a, b) => a.t - b.t);
  // Profit curve and worst dip, in time order.
  const curve: [number, number][] = [];
  let run = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of sells) {
    run += t.pnl!;
    peak = Math.max(peak, run);
    maxDd = Math.max(maxDd, peak - run);
    curve.push([t.t, run]);
  }
  const byPnl = [...sells].sort((a, b) => b.pnl! - a.pnl!);
  const total = realized + unrealizedForTotal;
  trades.sort((a, b) => a.t - b.t);
  return {
    from: ordered.length ? ordered[0].blockTime! * 1000 : null,
    to: ordered.length ? ordered[ordered.length - 1].blockTime! * 1000 : null,
    realizedSol: realized,
    unrealizedSol,
    totalSol: total,
    peakExposureSol: peakExposure,
    spentSol: spent,
    roiPct: spent > 0 ? (total / spent) * 100 : null,
    closed: sells.length,
    wins: sells.filter((t) => t.pnl! > 0).length,
    maxDrawdownSol: maxDd,
    best: byPnl[0] ?? null,
    worst: byPnl.length ? byPnl[byPnl.length - 1] : null,
    curve,
    skipped,
    wallets: [...wallets.values()].sort((a, b) => b.pnlSol - a.pnlSol),
    open,
    trades: trades.reverse().slice(0, 200),
    exitsReplayed: { tokens: boughtMints.size, withPrices: [...boughtMints].filter((m) => prices.has(m)).length, exitSells },
  };
}
