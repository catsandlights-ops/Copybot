/**
 * Backtest: replay wallets' real swap history with the user's settings and estimate what copying
 * them would have made.
 *
 * Pricing: we fill AFTER the copied wallet, so every copied buy pays `delayPct` more per token than
 * they did and every copied sell gets `delayPct` less, plus a network fee per trade.
 * Exits follow the copied wallets' sells (if "copy their sells" is on). Stop-loss and take-profit
 * steps need minute-by-minute prices for every token, so they are not replayed.
 *
 * Pure: no network. The server fetches the swaps and current prices.
 */
import type { Config } from './config';
import type { Swap } from './decode';
import { buyBlockReason, freshGuard, GuardState, recordSell } from './rules';

export type BacktestOpts = { delayPct: number; feeSol: number };
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
};

type Pos = { mint: string; tokens: number; costSol: number; wallets: Set<string>; openedAt: number };

/** Replay the swaps. `marks` gives the current SOL value per raw token for tokens still held (null = unknown). */
export function runBacktest(swaps: Swap[], cfg: Config, opts: BacktestOpts, marks: Map<string, number | null> = new Map()): BacktestResult {
  const r = cfg.risk;
  const d = opts.delayPct / 100;
  const ordered = swaps.filter((s) => s.quote === 'SOL' && s.blockTime && s.tokenAmount > 0n && s.quoteAmount > 0).sort((a, b) => a.blockTime! - b.blockTime!);
  const positions = new Map<string, Pos>();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const wallets = new Map<string, BtWallet>();
  const wal = (w: string) => wallets.get(w) ?? (wallets.set(w, { wallet: w, signals: 0, copied: 0, closed: 0, wins: 0, pnlSol: 0 }), wallets.get(w)!);
  const trades: BtTrade[] = [];
  const curve: [number, number][] = [];
  let realized = 0;
  let peakRealized = 0;
  let maxDd = 0;
  let exposure = 0;
  let peakExposure = 0;
  let spent = 0;
  let guard: GuardState | null = null;

  for (const s of ordered) {
    const now = s.blockTime! * 1000;
    guard ??= freshGuard(now);
    const w = cfg.wallets.find((x) => x.address === s.wallet);
    const stats = wal(s.wallet);
    const theirPrice = s.quoteAmount / Number(s.tokenAmount); // SOL per raw token

    if (s.side === 'buy') {
      stats.signals++;
      const blocked = buyBlockReason(guard, r, now);
      if (blocked) { skip(blocked.startsWith('daily') ? 'daily loss limit' : 'losing-streak pause'); continue; }
      const held = positions.get(s.mint);
      if (held && r.skipIfAlreadyHolding) { skip('already holding'); continue; }
      if (!held && positions.size >= r.maxOpenPositions) { skip('max open positions'); continue; }
      if (s.quoteAmount < cfg.buy.minTargetBuySol) { skip('their buy too small'); continue; }
      let sol = cfg.buy.sizing === 'percent' ? (s.quoteAmount * cfg.buy.percentOfTarget) / 100 : cfg.buy.fixedSol;
      sol = Math.min(cfg.buy.maxSol, Math.max(cfg.buy.minSol, sol * (w?.sizeMultiplier ?? 1)));
      if (exposure + sol > r.maxTotalExposureSol) { skip('max SOL in trades'); continue; }
      if (w && w.maxExposureSol > 0) {
        let used = 0;
        for (const p of positions.values()) if (p.wallets.has(s.wallet)) used += p.costSol / p.wallets.size;
        if (used + sol > w.maxExposureSol) { skip('wallet budget used up'); continue; }
      }
      if (cfg.safety.blacklist.includes(s.mint)) { skip('blacklisted'); continue; }
      const tokens = sol / (theirPrice * (1 + d));
      const p = held ?? { mint: s.mint, tokens: 0, costSol: 0, wallets: new Set<string>(), openedAt: now };
      p.tokens += tokens;
      p.costSol += sol + opts.feeSol;
      p.wallets.add(s.wallet);
      positions.set(s.mint, p);
      exposure += sol + opts.feeSol;
      spent += sol + opts.feeSol;
      peakExposure = Math.max(peakExposure, exposure);
      stats.copied++;
      trades.push({ t: now, side: 'buy', mint: s.mint, wallet: s.wallet, sol });
    } else {
      const p = positions.get(s.mint);
      if (!p || !p.wallets.has(s.wallet) || !cfg.sell.copySells) continue;
      const fraction = s.tokenPost === 0n || s.tokenPre === 0n ? 1 : Math.min(1, Number(s.tokenAmount) / Number(s.tokenPre));
      const sold = p.tokens * fraction;
      const proceeds = Math.max(0, sold * theirPrice * (1 - d) - opts.feeSol);
      const cost = p.costSol * fraction;
      const pnl = proceeds - cost;
      p.tokens -= sold;
      p.costSol -= cost;
      exposure = Math.max(0, exposure - cost);
      if (fraction >= 0.999 || p.tokens <= 0) positions.delete(s.mint);
      realized += pnl;
      peakRealized = Math.max(peakRealized, realized);
      maxDd = Math.max(maxDd, peakRealized - realized);
      curve.push([now, realized]);
      guard = recordSell(guard, pnl, r, now).guard;
      for (const src of p.wallets) {
        const ws = wal(src);
        ws.closed++;
        if (pnl > 0) ws.wins++;
        ws.pnlSol += pnl / p.wallets.size;
      }
      trades.push({ t: now, side: 'sell', mint: s.mint, wallet: s.wallet, sol: proceeds, pnl, reason: fraction >= 0.999 ? 'they sold everything' : `they sold ${Math.round(fraction * 100)}%` });
    }
  }

  const open: BtOpen[] = [...positions.values()].map((p) => {
    const m = marks.get(p.mint);
    return { mint: p.mint, costSol: p.costSol, tokensRaw: p.tokens, valueSol: m == null ? null : Math.max(0, p.tokens * m * (1 - d) - opts.feeSol), wallets: [...p.wallets] };
  });
  const unrealizedSol = open.every((o) => o.valueSol !== null) ? open.reduce((a, o) => a + (o.valueSol! - o.costSol), 0) : null;
  // Unpriced open positions count as a total loss in the headline number (conservative).
  const unrealizedForTotal = open.reduce((a, o) => a + ((o.valueSol ?? 0) - o.costSol), 0);
  const sells = trades.filter((t) => t.side === 'sell');
  const byPnl = [...sells].sort((a, b) => b.pnl! - a.pnl!);
  const total = realized + unrealizedForTotal;
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
  };
}
