/**
 * The go-live assistant: a guided switch from paper to live. Pure parts (unit-tested):
 *  - starter limits sized to the money in the trading wallet(s), so the first live days are small;
 *  - which wallets go live (proven in paper) and which keep proving themselves in shadow;
 *  - when the starter period has earned a return to your normal limits.
 * Plus the round-trip test trade (native → USDC → native) that proves signing and sending work.
 */
import type { Config } from './config';
import type { ChainAdapter, ChainContext } from './chains/types';
import type { SourceReport } from './readiness';

/** The settings the starter limits change (and that "restore" puts back). */
export type LimitSet = { fixedSol: number; maxOpenPositions: number; maxTotalExposureSol: number; dailyLossLimitSol: number; stopLossPct: number };

export const currentLimits = (c: Config): LimitSet => ({
  fixedSol: c.buy.fixedSol,
  maxOpenPositions: c.risk.maxOpenPositions,
  maxTotalExposureSol: c.risk.maxTotalExposureSol,
  dailyLossLimitSol: c.risk.dailyLossLimitSol,
  stopLossPct: c.risk.stopLossPct,
});

export function withLimits(c: Config, l: LimitSet): Config {
  const n = structuredClone(c);
  n.buy.fixedSol = l.fixedSol;
  n.risk.maxOpenPositions = l.maxOpenPositions;
  n.risk.maxTotalExposureSol = l.maxTotalExposureSol;
  n.risk.dailyLossLimitSol = l.dailyLossLimitSol;
  n.risk.stopLossPct = l.stopLossPct;
  return n;
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** The least worth trading with: below this, network fees eat a real share of every trade. */
export const MIN_LIVE_SOL = 0.1;

/**
 * Small, safe limits for the first live days, from the money available (in SOL, all chains added up).
 * Never bigger than what you already have set; each trade is about 5% of the money.
 */
export function starterLimits(moneySol: number, c: Config): { limits: LimitSet; notes: string[] } {
  const cur = currentLimits(c);
  const notes: string[] = [];
  const fixedSol = round(Math.min(cur.fixedSol, Math.max(0.02, moneySol * 0.05)));
  const maxOpenPositions = Math.max(1, Math.min(cur.maxOpenPositions, 3));
  const exposureCap = round(Math.max(fixedSol, Math.min(moneySol * 0.5, fixedSol * maxOpenPositions * 1.5)));
  const maxTotalExposureSol = cur.maxTotalExposureSol > 0 ? Math.min(cur.maxTotalExposureSol, exposureCap) : exposureCap;
  const lossCap = round(Math.max(fixedSol, moneySol * 0.1));
  const dailyLossLimitSol = cur.dailyLossLimitSol > 0 ? Math.min(cur.dailyLossLimitSol, lossCap) : lossCap;
  const stopLossPct = cur.stopLossPct > 0 ? Math.min(cur.stopLossPct, 40) : 40;
  if (moneySol < MIN_LIVE_SOL) notes.push(`Only ${moneySol.toFixed(3)} SOL to trade with: network fees would take a big share of every trade. Add at least ${MIN_LIVE_SOL} SOL first.`);
  notes.push(`${fixedSol} SOL per trade (about 5% of your ${round(moneySol, 2)} SOL), at most ${maxOpenPositions} coins and ${maxTotalExposureSol} SOL in trades at once.`);
  notes.push(`New buys stop for the day after losing ${dailyLossLimitSol} SOL, and any coin down ${stopLossPct}% is sold.`);
  return { limits: { fixedSol, maxOpenPositions, maxTotalExposureSol, dailyLossLimitSol, stopLossPct }, notes };
}

export type WalletRole = 'live' | 'shadow' | 'off';

/** Proven wallets copy for real; the rest keep proving themselves in shadow (no money). */
export function suggestRoles(wallets: { address: string; enabled: boolean; shadow?: boolean }[], sources: Pick<SourceReport, 'source' | 'verdict'>[]): Record<string, WalletRole> {
  const out: Record<string, WalletRole> = {};
  for (const w of wallets) {
    if (!w.enabled && !w.shadow) {
      out[w.address] = 'off';
      continue;
    }
    const v = sources.find((s) => s.source === w.address)?.verdict;
    out[w.address] = v === 'ready' ? 'live' : 'shadow';
  }
  return out;
}

/** Apply the roles to a config: live = copied for real, shadow = copied virtually, off = neither. */
export function applyRoles(c: Config, roles: Record<string, WalletRole>, now: number): Config {
  const n = structuredClone(c);
  for (const w of n.wallets) {
    const r = roles[w.address];
    if (!r) continue;
    if (r === 'live') {
      if (!w.enabled) Object.assign(w, { enabled: true, since: now, pausedReason: undefined });
      delete w.shadow;
    } else if (r === 'shadow') Object.assign(w, { enabled: false, shadow: true });
    else {
      w.enabled = false;
      delete w.shadow;
    }
  }
  return n;
}

/** What the assistant remembers from the switch, so the starter limits can be undone later. */
export type GoLiveRecord = { at: number; before: LimitSet; starter: LimitSet | null; restoredAt?: number };

export const RAMP = { minDays: 7, minClosed: 10 };

/** After the starter period: back to your normal limits once live trading has proven itself. */
export function rampAdvice(rec: GoLiveRecord | null, liveSells: { t: number; pnl?: number }[], now: number): { due: boolean; text: string } | null {
  if (!rec?.starter || rec.restoredAt) return null;
  const mine = liveSells.filter((t) => t.t >= rec.at && typeof t.pnl === 'number');
  const pnl = mine.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const days = (now - rec.at) / 86_400_000;
  const res = `${mine.length} closed live trade${mine.length === 1 ? '' : 's'} in ${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}, ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL`;
  if (days >= RAMP.minDays && mine.length >= RAMP.minClosed && pnl > 0) return { due: true, text: `Starter limits since ${new Date(rec.at).toLocaleDateString()}: ${res}. Live trading is paying off, so your normal limits can come back.` };
  const need = [days < RAMP.minDays && `${Math.ceil(RAMP.minDays - days)} more day${Math.ceil(RAMP.minDays - days) === 1 ? '' : 's'}`, mine.length < RAMP.minClosed && `${RAMP.minClosed - mine.length} more closed trades`, mine.length >= RAMP.minClosed && pnl <= 0 && 'a profit'].filter(Boolean);
  return { due: false, text: `Starter limits since ${new Date(rec.at).toLocaleDateString()}: ${res}. Normal limits are suggested after ${need.join(' and ')}.` };
}

// ---------------- the test trade ----------------

export type TestResult = { ok: true; chain: string; buySig: string; sellSig: string; costNative: number; costSol: number; seconds: number; note: string } | { ok: false; chain: string; step: string; error: string; buySig?: string };

/**
 * A real, tiny round trip: native → the chain's USD stablecoin → native. Proves the key signs, the
 * node sends and confirms, and the swap service works, for a few cents of fees. If the sell back
 * fails, the stablecoin stays in the wallet (nothing is lost but fees).
 */
export async function roundTrip(chain: ChainAdapter, ctx: ChainContext, owner: string, amountNative: number, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<TestResult> {
  const id = chain.meta.id;
  const usd = chain.meta.stable.address;
  const started = Date.now();
  const raw = BigInt(Math.round(amountNative * 10 ** chain.meta.native.decimals));
  const slip = Math.max(ctx.cfg.safety.slippageBps, 100);
  const bal = () => chain.balance(ctx, owner);
  const before = await bal().catch(() => null);
  if (before == null) return { ok: false, chain: id, step: 'balance', error: `couldn't read the ${chain.meta.native.symbol} balance` };
  if (before < amountNative * 3) return { ok: false, chain: id, step: 'balance', error: `the wallet has ${before.toFixed(4)} ${chain.meta.native.symbol}; the test needs at least ${(amountNative * 3).toFixed(4)}` };
  const usdBefore = chain.tokenBalance ? await chain.tokenBalance(ctx, owner, usd).catch(() => 0n) : 0n;
  const buyQ = await chain.quoteBuy(usd, raw, slip).catch((e) => (e as Error));
  if (!buyQ || buyQ instanceof Error) return { ok: false, chain: id, step: 'quote', error: buyQ instanceof Error ? buyQ.message : 'no price for the test swap' };
  let buySig: string;
  try {
    buySig = await chain.executeSwap(ctx, buyQ, { test: true });
  } catch (e) {
    return { ok: false, chain: id, step: 'buy', error: (e as Error).message };
  }
  // What the buy really gave (the wallet may already hold some of the stablecoin).
  let got = 0n;
  for (let i = 0; i < 10 && got <= 0n; i++) {
    if (i) await wait(1500);
    const now = chain.tokenBalance ? await chain.tokenBalance(ctx, owner, usd).catch(() => usdBefore) : BigInt(buyQ.outAmount);
    got = now - usdBefore;
  }
  if (got <= 0n) got = BigInt(buyQ.outAmount);
  const sellQ = await chain.quoteSell(usd, got, slip).catch(() => null);
  if (!sellQ) return { ok: false, chain: id, step: 'quote back', error: `no price to swap back; the ${chain.meta.stable.symbol} stays in the wallet`, buySig };
  let sellSig: string;
  try {
    sellSig = await chain.executeSwap(ctx, sellQ, { test: true });
  } catch (e) {
    return { ok: false, chain: id, step: 'sell', error: `${(e as Error).message} (the ${chain.meta.stable.symbol} stays in the wallet; it can be swapped back by hand)`, buySig };
  }
  await wait(1500);
  const after = await bal().catch(() => null);
  const costNative = after == null ? NaN : Math.max(0, before - after);
  const costSol = Number.isFinite(costNative) ? await chain.nativeToSol(costNative).catch(() => NaN) : NaN;
  const note = id === 'solana' && usdBefore === 0n ? ' Part of it is a small refundable deposit Solana keeps for the new USDC account.' : '';
  return { ok: true, chain: id, buySig, sellSig, costNative, costSol, seconds: Math.round((Date.now() - started) / 100) / 10, note };
}
