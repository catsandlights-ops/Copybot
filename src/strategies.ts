/**
 * Ready-made trading strategies: bundles of buying rules, token filters and exits.
 * A strategy never touches the user's money settings (SOL per buy, total exposure, daily loss
 * limit, reserve) or the safety checks; it only changes HOW the bot trades.
 */
import type { Config } from './config';
import { BacktestOpts, PriceSeries, runBacktest } from './backtest';
import type { Swap } from './decode';

import { STRATEGIES, strategyById, type Patch, type Strategy } from './presets';
export { STRATEGIES, strategyById, type Strategy };

/** The config with a strategy applied (money settings and safety checks untouched). */
export function applyStrategy(cfg: Config, s: Strategy): Config {
  const c = structuredClone(cfg);
  for (const [section, values] of Object.entries(s.patch) as [keyof Patch, Record<string, unknown>][]) {
    Object.assign(c[section] as object, values);
  }
  return c;
}

/** Every setting the strategy would change: [path, current value, new value]. */
export function strategyChanges(cfg: Config, s: Strategy): [string, unknown, unknown][] {
  const out: [string, unknown, unknown][] = [];
  for (const [section, values] of Object.entries(s.patch) as [keyof Patch, Record<string, unknown>][]) {
    for (const [k, v] of Object.entries(values)) {
      const cur = (cfg[section] as Record<string, unknown>)[k];
      if (cur !== v) out.push([`${section}.${k}`, cur, v]);
    }
  }
  return out;
}

/** Which strategy the current settings match exactly, if any. */
export const activeStrategy = (cfg: Config) => STRATEGIES.find((s) => strategyChanges(cfg, s).length === 0)?.id ?? null;

// ---------------- comparing strategies on the same history ----------------

export type StrategyResult = { id: string; name: string; totalSol: number; roiPct: number | null; closed: number; wins: number; maxDrawdownSol: number; spentSol: number; copied: number };
export type CompareResult = { results: StrategyResult[]; best: StrategyResult; current: StrategyResult; currentIs: string | null; verdict: 'better' | 'small' | 'current' | 'few-trades' | 'all-lose' };

/**
 * Replay the same swaps with the user's current settings and with every strategy.
 * Per-wallet exit overrides are left out so the strategies' own exits are compared.
 */
export function compareStrategies(swaps: Swap[], cfg: Config, opts: BacktestOpts, marks: Map<string, number | null>, prices: Map<string, PriceSeries>): CompareResult {
  const base = { ...structuredClone(cfg), wallets: cfg.wallets.map(({ exits: _x, strategy: _s, ...w }) => w) };
  const run = (id: string, name: string, c: Config): StrategyResult => {
    const r = runBacktest(swaps, c, opts, marks, prices);
    return { id, name, totalSol: r.totalSol, roiPct: r.roiPct, closed: r.closed, wins: r.wins, maxDrawdownSol: r.maxDrawdownSol, spentSol: r.spentSol, copied: r.trades.filter((t) => t.side === 'buy').length };
  };
  const currentIs = activeStrategy(cfg);
  const results = [run('current', 'Your current settings', base), ...STRATEGIES.filter((s) => s.id !== currentIs).map((s) => run(s.id, s.name, applyStrategy(base, s)))];
  // A strategy that would have made no trades isn't a winner, it just sat out: rank those last.
  results.sort((a, b) => Number(a.copied === 0) - Number(b.copied === 0) || b.totalSol - a.totalSol || a.maxDrawdownSol - b.maxDrawdownSol);
  const best = results[0];
  const current = results.find((r) => r.id === 'current')!;
  const margin = best.totalSol - current.totalSol;
  const verdict: CompareResult['verdict'] =
    best.copied > 0 && best.totalSol <= 0 ? 'all-lose' : best.id === 'current' ? 'current' : Math.max(current.closed, best.closed) < 10 ? 'few-trades' : margin < Math.max(0.01, Math.max(current.spentSol, best.spentSol) * 0.1) ? 'small' : 'better';
  return { results, best, current, currentIs, verdict };
}

// ---------------- the best strategy for one wallet ----------------

/** 'mine' = no strategy of its own: the wallet follows your global settings. */
export type WalletStrategyResult = { id: string; name: string; totalSol: number; closed: number; spentSol: number; recentSol: number; recentClosed: number };
export type WalletStrategyPick = { address: string; current: WalletStrategyResult; best: WalletStrategyResult; results: WalletStrategyResult[]; change: boolean; why: string };

/**
 * Replay one wallet's trades with your own settings and with each strategy, and decide whether
 * another strategy clearly fits it better: enough finished trades, a real profit, a clear margin,
 * and not worse on the most recent days (one lucky stretch isn't enough). Your per-wallet exit
 * overrides are left out of the comparison (they'd hide the differences) but are kept when applying.
 */
export function pickWalletStrategy(swaps: Swap[], cfg: Config, opts: BacktestOpts, marks: Map<string, number | null>, prices: Map<string, PriceSeries>, address: string, recentFrom: number): WalletStrategyPick | null {
  const w = cfg.wallets.find((x) => x.address === address);
  if (!w) return null;
  const mine = swaps.filter((s) => s.wallet === address);
  if (!mine.length) return null;
  const recent = mine.filter((s) => (s.blockTime ?? 0) * 1000 >= recentFrom);
  const run = (id: string, name: string): WalletStrategyResult => {
    const c = structuredClone(cfg);
    const { exits: _x, strategy: _s, ...rest } = w;
    c.wallets = [{ ...rest, enabled: true, ...(id === 'mine' ? {} : { strategy: id }) }];
    const all = runBacktest(mine, c, opts, marks, prices);
    const late = recent.length ? runBacktest(recent, c, opts, marks, prices) : null;
    return { id, name, totalSol: all.totalSol, closed: all.closed, spentSol: all.spentSol, recentSol: late?.totalSol ?? 0, recentClosed: late?.closed ?? 0 };
  };
  const results = [run('mine', 'Your settings'), ...STRATEGIES.map((s) => run(s.id, s.name))];
  results.sort((a, b) => b.totalSol - a.totalSol);
  const current = results.find((r) => r.id === (w.strategy || 'mine')) ?? results.find((r) => r.id === 'mine')!;
  const best = results[0];
  const margin = best.totalSol - current.totalSol;
  const need = Math.max(0.005, Math.max(best.spentSol, current.spentSol) * 0.1);
  const why =
    best.id === current.id ? 'its current strategy did best'
    : best.closed < 5 ? 'too few finished trades to tell'
    : best.totalSol <= 0 ? 'no strategy made money with it'
    : margin < need ? 'the difference was too small'
    : best.recentClosed >= 2 && best.recentSol < current.recentSol ? 'it did worse over the last 2 days'
    : 'clearly better';
  return { address, current, best, results, change: why === 'clearly better', why };
}
