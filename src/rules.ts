/**
 * Trading rules as pure functions (no network, no clock reads unless passed in),
 * so each one can be unit-tested. The engine calls these and acts on the result.
 */
import type { Config } from './config';

// ---------------------------------------------------------------------------
// Staged exits: take back cost → take-profit 1 → take-profit 2 → trailing stop
// ---------------------------------------------------------------------------

export type ExitStep = 'recover' | 'tp1' | 'tp2';
export type ExitPosition = { costSol: number; steps?: ExitStep[]; peakMultiple?: number };
export type ExitAction = { fraction: number; reason: string; step?: ExitStep };

/**
 * Decide what (if anything) to sell for one position, given its current value.
 * `multiple` = value / cost basis (2 = doubled). Returns the new peak to remember.
 * Order of priority: stop-loss, trailing stop, sell-everything target, then the staged steps.
 */
/** Rule #1's defaults when a setup doesn't say: lock in once up 20%, sell if it falls back to +5% (covers fees). */
export const LOCK_DEFAULT = { atPct: 20, floorPct: 5 };

export function planExit(p: ExitPosition, valueSol: number, cfg: Pick<Config, 'risk' | 'exits'>): { action: ExitAction | null; peakMultiple: number } {
  const multiple = p.costSol > 0 ? valueSol / p.costSol : 1;
  const peak = Math.max(p.peakMultiple ?? 1, multiple);
  const gainPct = (multiple - 1) * 100;
  const peakGainPct = (peak - 1) * 100;
  const done = new Set(p.steps ?? []);
  const { risk, exits } = cfg;
  const out = (action: ExitAction | null) => ({ action, peakMultiple: peak });

  // Rule #1: a profitable trade is a good trade. Once clearly up, never let it turn into a loss.
  const lockAt = exits.lockAtPct ?? LOCK_DEFAULT.atPct;
  const lockFloor = exits.lockFloorPct ?? LOCK_DEFAULT.floorPct;
  if (lockAt > 0 && peakGainPct >= lockAt && gainPct <= lockFloor) {
    return out({ fraction: 1, reason: gainPct >= 0 ? `profit lock: was up +${peakGainPct.toFixed(0)}%, sold at +${gainPct.toFixed(0)}% to keep it a winner` : `profit lock: was up +${peakGainPct.toFixed(0)}%, fell fast to ${gainPct.toFixed(0)}%; sold before it got worse` });
  }

  if (gainPct <= -risk.stopLossPct) return out({ fraction: 1, reason: `stop-loss ${gainPct.toFixed(0)}%` });

  if (exits.trailingStopPct > 0 && peakGainPct >= exits.trailingAfterPct) {
    const dropPct = (1 - multiple / peak) * 100;
    if (dropPct >= exits.trailingStopPct) {
      return out({ fraction: 1, reason: `trailing stop: down ${dropPct.toFixed(0)}% from its peak (+${peakGainPct.toFixed(0)}%)` });
    }
  }

  if (risk.takeProfitPct > 0 && gainPct >= risk.takeProfitPct) return out({ fraction: 1, reason: `take-profit +${gainPct.toFixed(0)}%` });

  if (exits.recoverCostAtPct > 0 && !done.has('recover') && gainPct >= exits.recoverCostAtPct) {
    // Sell just enough to get the SOL we put in back out: cost / value of the holding.
    return out({ fraction: Math.min(1, 1 / multiple), step: 'recover', reason: `took back my cost at +${gainPct.toFixed(0)}%` });
  }
  if (exits.tp1AtPct > 0 && !done.has('tp1') && gainPct >= exits.tp1AtPct) {
    return out({ fraction: exits.tp1SellPct / 100, step: 'tp1', reason: `take-profit 1 at +${gainPct.toFixed(0)}%` });
  }
  if (exits.tp2AtPct > 0 && !done.has('tp2') && gainPct >= exits.tp2AtPct) {
    return out({ fraction: exits.tp2SellPct / 100, step: 'tp2', reason: `take-profit 2 at +${gainPct.toFixed(0)}%` });
  }
  return out(null);
}

// ---------------------------------------------------------------------------
// Don't chase: how far above the copied wallet's entry would we be buying?
// ---------------------------------------------------------------------------

/** % our price per token is above theirs (negative = we'd buy cheaper). Both raw amounts use the same decimals. */
export function priceDriftPct(theirSol: number, theirTokenRaw: bigint, ourLamports: bigint, ourTokenRaw: bigint): number | null {
  if (theirTokenRaw <= 0n || ourTokenRaw <= 0n || theirSol <= 0) return null;
  const theirs = (theirSol * 1e9) / Number(theirTokenRaw); // lamports per raw unit
  const ours = Number(ourLamports) / Number(ourTokenRaw);
  return (ours / theirs - 1) * 100;
}

// ---------------------------------------------------------------------------
// Market filters (liquidity, trade size vs liquidity, market cap, token age)
// ---------------------------------------------------------------------------

/** liquidityUsd is null when unknown, e.g. pump.fun bonding-curve tokens (Dexscreener reports no pool liquidity for them). */
export type MarketInfo = {
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  createdAt: number | null;
  // extras (biggest pool), shown to the AI
  symbol?: string | null;
  name?: string | null;
  volume24hUsd?: number | null;
  change1hPct?: number | null;
  change5mPct?: number | null;
  buys1h?: number | null;
  sells1h?: number | null;
  buys5m?: number | null;
  sells5m?: number | null;
};

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);

/** Returns a reason to skip the token, or null if it passes. */
export function marketSkipReason(info: MarketInfo | null, f: Config['filters'], tradeUsd: number | null, now: number): string | null {
  const anyFilter = f.minLiquidityUsd > 0 || f.maxTradePctOfLiquidity > 0 || f.minMarketCapUsd > 0 || f.maxMarketCapUsd > 0 || f.minTokenAgeMin > 0;
  if (!anyFilter) return null;
  if (!info) return f.skipIfNoMarketData ? 'no market data for this token yet' : null;
  // Unknown liquidity (bonding curve): skip the liquidity checks; the buy-then-sell quote check still measures real exit cost.
  if (f.minLiquidityUsd > 0 && info.liquidityUsd != null && info.liquidityUsd < f.minLiquidityUsd) return `liquidity ${usd(info.liquidityUsd)} is below ${usd(f.minLiquidityUsd)}`;
  if (f.maxTradePctOfLiquidity > 0 && tradeUsd != null && info.liquidityUsd != null && info.liquidityUsd > 0) {
    const pct = (tradeUsd / info.liquidityUsd) * 100;
    if (pct > f.maxTradePctOfLiquidity) return `your buy would be ${pct.toFixed(1)}% of the pool (max ${f.maxTradePctOfLiquidity}%)`;
  }
  if (info.marketCapUsd != null) {
    if (f.minMarketCapUsd > 0 && info.marketCapUsd < f.minMarketCapUsd) return `market cap ${usd(info.marketCapUsd)} is below ${usd(f.minMarketCapUsd)}`;
    if (f.maxMarketCapUsd > 0 && info.marketCapUsd > f.maxMarketCapUsd) return `market cap ${usd(info.marketCapUsd)} is above ${usd(f.maxMarketCapUsd)}`;
  }
  if (f.minTokenAgeMin > 0 && info.createdAt != null) {
    const ageMin = (now - info.createdAt) / 60_000;
    if (ageMin < f.minTokenAgeMin) return `token is only ${Math.max(0, ageMin).toFixed(0)} min old (min ${f.minTokenAgeMin})`;
  }
  return null;
}

/** Holder concentration check (Solscan). Null stats = no data, so no verdict. */
export function holderSkipReason(h: { largestPct: number; top10Pct: number } | null, f: Pick<Config['filters'], 'maxTopHolderPct' | 'maxTop10HoldersPct'>): string | null {
  if (!h) return null;
  if (f.maxTopHolderPct > 0 && h.largestPct > f.maxTopHolderPct) return `one wallet owns ${h.largestPct.toFixed(1)}% of the supply (max ${f.maxTopHolderPct}%)`;
  if (f.maxTop10HoldersPct > 0 && h.top10Pct > f.maxTop10HoldersPct) return `the 10 largest wallets own ${h.top10Pct.toFixed(0)}% of the supply (max ${f.maxTop10HoldersPct}%)`;
  return null;
}

// ---------------------------------------------------------------------------
// Rug and dump protection for open positions
// ---------------------------------------------------------------------------

export type DangerInputs = {
  now: number;
  valueSol: number;
  samples: [number, number][]; // recent [time ms, value SOL], oldest first
  liquidityUsd: number | null;
  peakLiquidityUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  change5mPct?: number | null; // the market's own 5-minute price change, if known
};

/** Heavy selling only counts as a dump when the price is really falling this much within 5 minutes. */
export const DUMP_CONFIRM_PCT = 5;

/** Why an open position should be sold right away to escape a rug or dump, or null. */
/**
 * The crash check compares the price per token over time, not the position's total value: selling
 * part of a position (or buying more) changes the total without the price moving at all.
 */
export const perTokenValue = (valueSol: number, amountRaw: string | bigint) => {
  const raw = Number(amountRaw);
  return raw > 0 ? (valueSol / raw) * 1e9 : 0;
};

export function dangerReason(d: DangerInputs, p: Config['protect']): string | null {
  if (p.liquidityDropPct > 0 && d.liquidityUsd != null && d.peakLiquidityUsd && d.peakLiquidityUsd > 0) {
    const drop = (1 - d.liquidityUsd / d.peakLiquidityUsd) * 100;
    if (drop >= p.liquidityDropPct) return `rug protection: the pool's liquidity fell ${drop.toFixed(0)}% from its high`;
  }
  if (p.crashPct > 0) {
    const since = d.now - p.crashWindowMin * 60_000;
    const recent = d.samples.filter(([t]) => t >= since).map(([, v]) => v);
    const high = Math.max(...recent, 0);
    if (high > 0 && recent.length >= 2) {
      const drop = (1 - d.valueSol / high) * 100;
      if (drop >= p.crashPct) return `dump protection: price fell ${drop.toFixed(0)}% in under ${p.crashWindowMin} min`;
    }
  }
  if (p.maxSellBuyRatio > 0 && d.sells5m != null && d.sells5m >= 20) {
    const buys = Math.max(1, d.buys5m ?? 0);
    if (d.sells5m / buys >= p.maxSellBuyRatio) {
      // Many small sells while the price holds aren't a dump: require the price to be falling too.
      const recent = d.samples.filter(([t]) => t >= d.now - 5 * 60_000).map(([, v]) => v);
      const high = Math.max(...recent, 0);
      const ownDrop = high > 0 && recent.length >= 2 ? (1 - d.valueSol / high) * 100 : 0;
      const marketDrop = d.change5mPct != null ? -d.change5mPct : 0;
      const drop = Math.max(ownDrop, marketDrop);
      if (drop >= DUMP_CONFIRM_PCT) return `dump protection: ${d.sells5m} sells vs ${d.buys5m ?? 0} buys in the last 5 min, price down ${drop.toFixed(0)}%`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wallet trial period and auto-pause
// ---------------------------------------------------------------------------

/** Size factor for a wallet on trial: quarter, then half, then full. */
export const trialFactor = (stage?: 0 | 1) => (stage === 0 ? 0.25 : stage === 1 ? 0.5 : 1);

/**
 * After a sell copied from this wallet: should it step up its trial size, or be paused?
 * `pnls` = profit of each sell copied from it since `since`, oldest first.
 */
export function walletLifecycle(w: { trialStage?: 0 | 1 }, pnls: number[], t: { enabled: boolean; winsToStepUp: number; pauseAfterLosses: number }): { stepUp: boolean; pause: string | null } {
  const n = t.pauseAfterLosses;
  if (n > 0 && pnls.length >= n && pnls.slice(-n).every((p) => p < 0)) {
    return { stepUp: false, pause: `${n} losing copies in a row` };
  }
  const wins = pnls.filter((p) => p > 0).length;
  return { stepUp: t.enabled && w.trialStage !== undefined && wins >= t.winsToStepUp, pause: null };
}

// ---------------------------------------------------------------------------
// Paper wallet
// ---------------------------------------------------------------------------

/** SOL free to spend in the paper wallet: what it started with, plus closed profits, minus what's in open positions. */
export const paperFreeSol = (startSol: number, realizedPnlSol: number, openCostSol: number) => startSol + realizedPnlSol - openCostSol;

/**
 * Pick wallets for a quick paper experiment from recent "caught the move" buyers:
 * wallets seen on the most tokens first, then the biggest gain.
 */
export function experimentPicks(caught: Map<string, { tokens: string[]; bestGainPct: number }>, skip: Set<string>, n = 3) {
  const ranked = [...caught.entries()]
    .filter(([w]) => !skip.has(w))
    .sort((a, b) => b[1].tokens.length - a[1].tokens.length || b[1].bestGainPct - a[1].bestGainPct);
  // Spread the picks over different tokens: skip a trader whose tokens are all already covered,
  // then fill any empty places from the rest.
  const picked: typeof ranked = [];
  const covered = new Set<string>();
  for (const e of ranked) {
    if (picked.length >= n) break;
    if (e[1].tokens.every((t) => covered.has(t))) continue;
    picked.push(e);
    e[1].tokens.forEach((t) => covered.add(t));
  }
  for (const e of ranked) if (picked.length < n && !picked.includes(e)) picked.push(e);
  return picked.map(([wallet, v]) => ({ wallet, ...v }));
}

// ---------------------------------------------------------------------------
// Wallet health check
// ---------------------------------------------------------------------------

export type HealthVerdict = 'keep' | 'losing' | 'unclear' | 'quiet';
/** From one wallet's backtest with the user's settings: worth keeping, losing money, too few trades, or no trades. */
export function healthVerdict(r: { copied: number; closed: number; totalSol: number; read?: number; unreadable?: number }): HealthVerdict {
  // If a big part of the history couldn't be read, there's no fair verdict.
  if (r.read && (r.unreadable ?? 0) > r.read * 0.3) return 'unclear';
  if (r.copied === 0) return 'quiet';
  if (r.closed < 3) return 'unclear';
  return r.totalSol > 0 ? 'keep' : 'losing';
}

// ---------------------------------------------------------------------------
// Copy gap: how much worse our fill was than the copied wallet's
// ---------------------------------------------------------------------------

/**
 * Percent we lost to copying late on one trade (positive = worse for us).
 * Buys: we paid more per token than they did. Sells: we got less per token.
 */
export function copyGapPct(side: 'buy' | 'sell', theirSol: number, theirRaw: bigint, ourSol: number, ourRaw: bigint): number | null {
  if (theirRaw <= 0n || ourRaw <= 0n || theirSol <= 0 || ourSol <= 0) return null;
  const ratio = ourSol / Number(ourRaw) / (theirSol / Number(theirRaw));
  if (!Number.isFinite(ratio)) return null;
  return side === 'buy' ? (ratio - 1) * 100 : (1 - ratio) * 100;
}

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------------------
// Circuit breaker: daily loss limit + pause after a losing streak
// ---------------------------------------------------------------------------

/**
 * Automatic panic: today's closed-trade result plus what open positions are worth right now,
 * at or below −limit SOL. 0 = off. Returns the message to act on, or null.
 */
export function panicReason(dayPnlSol: number, unrealizedSol: number, limitSol: number): string | null {
  if (!(limitSol > 0)) return null;
  const total = dayPnlSol + unrealizedSol;
  return total <= -limitSol ? `today's total is ${total.toFixed(3)} SOL (closed ${dayPnlSol.toFixed(3)}, open ${unrealizedSol.toFixed(3)}), past your ${limitSol} SOL panic limit` : null;
}

export type GuardState = { day: string; dayPnlSol: number; lossStreak: number; pausedUntil: number; resumedDay?: string };

export const localDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const freshGuard = (now: number): GuardState => ({ day: localDay(now), dayPnlSol: 0, lossStreak: 0, pausedUntil: 0 });

/** Roll the day over (daily P&L resets at local midnight). */
export function rollDay(g: GuardState, now: number): GuardState {
  const today = localDay(now);
  return g.day === today ? g : { ...g, day: today, dayPnlSol: 0 };
}

/** Why new buys are blocked right now, or null. */
export function buyBlockReason(g: GuardState, risk: Config['risk'], now: number): string | null {
  g = rollDay(g, now);
  if (risk.dailyLossLimitSol > 0 && g.dayPnlSol <= -risk.dailyLossLimitSol && g.resumedDay !== g.day) {
    return `daily loss limit reached (${g.dayPnlSol.toFixed(3)} SOL today). No new buys until tomorrow.`;
  }
  if (g.pausedUntil > now) {
    return `paused after ${risk.pauseAfterLosses} losing trades in a row, until ${new Date(g.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  }
  return null;
}

/** Update the guard after a sell. Returns the new state and a message if a pause/limit just kicked in. */
/** A loss smaller than this share of what the trade cost is "about break-even": it doesn't count toward a losing streak. */
export const STREAK_MIN_LOSS_PCT = 2;

/** A sell that lost less than STREAK_MIN_LOSS_PCT of its cost (cost = proceeds - profit): break-even, not a loss. */
export const isBreakEvenLoss = (pnl: number, proceedsSol: number) => {
  const cost = proceedsSol - pnl;
  return pnl < 0 && cost > 0 && -pnl < (cost * STREAK_MIN_LOSS_PCT) / 100;
};

export function recordSell(g: GuardState, pnlSol: number, risk: Config['risk'], now: number, costSol?: number): { guard: GuardState; event: string | null } {
  g = rollDay(g, now);
  const before = buyBlockReason(g, risk, now);
  const breakEven = pnlSol < 0 && costSol != null && costSol > 0 && -pnlSol < (costSol * STREAK_MIN_LOSS_PCT) / 100;
  const lossStreak = breakEven ? g.lossStreak : pnlSol < 0 ? g.lossStreak + 1 : 0;
  const next: GuardState = { ...g, dayPnlSol: g.dayPnlSol + pnlSol, lossStreak };
  let event: string | null = null;
  if (risk.pauseAfterLosses > 0 && next.lossStreak >= risk.pauseAfterLosses) {
    next.pausedUntil = now + risk.pauseMinutes * 60_000;
    next.lossStreak = 0;
    event = `${risk.pauseAfterLosses} losing trades in a row: pausing new buys for ${risk.pauseMinutes} min. Sells and exits keep running.`;
  } else if (!before && risk.dailyLossLimitSol > 0 && next.dayPnlSol <= -risk.dailyLossLimitSol && next.resumedDay !== next.day) {
    event = `Daily loss limit reached (${next.dayPnlSol.toFixed(3)} SOL today): no new buys until tomorrow. Sells and exits keep running.`;
  }
  return { guard: next, event };
}

// ---------------------------------------------------------------------------
// Per-wallet budgets
// ---------------------------------------------------------------------------

/** SOL currently in positions copied from `wallet` (split evenly when several wallets bought the same token). */
export function walletExposureSol(positions: { costSol: number; sources: string[] }[], wallet: string): number {
  return positions.reduce((a, p) => (p.sources.includes(wallet) ? a + p.costSol / Math.max(1, p.sources.length) : a), 0);
}

// ---------------------------------------------------------------------------
// Per-wallet results (our own trades), for the AI and the scoreboard
// ---------------------------------------------------------------------------

export type TradeLike = { mode?: string; side: string; source?: string; sources?: string[]; pnl?: number };
export type WalletRecord = { trades: number; closed: number; wins: number; pnlSol: number };

/** What copying each wallet has earned us. A sell from a position copied from several wallets is split evenly. */
export function walletRecords(trades: TradeLike[], mode?: string): Record<string, WalletRecord> {
  const out: Record<string, WalletRecord> = {};
  const rec = (w: string) => (out[w] ??= { trades: 0, closed: 0, wins: 0, pnlSol: 0 });
  for (const t of trades) {
    if (mode && t.mode !== mode) continue;
    if (t.side === 'buy' && t.source) rec(t.source).trades++;
    if (t.side === 'sell' && typeof t.pnl === 'number' && t.sources?.length) {
      for (const w of t.sources) {
        const r = rec(w);
        r.closed++;
        if (t.pnl > 0) r.wins++;
        r.pnlSol += t.pnl / t.sources.length;
      }
    }
  }
  return out;
}
