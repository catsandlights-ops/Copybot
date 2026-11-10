/**
 * "Find my best settings": replay the same history with different exit setups and rank them.
 * Pure: takes the swaps, price candles and end-of-period prices the backtest already loaded.
 */
import type { Config } from './config';
import type { Swap } from './decode';
import { BacktestOpts, PriceSeries, runBacktest } from './backtest';

export type ExitSetup = { id: string; name: string; stopLossPct: number; exits: Config['exits']; takeProfitPct: number };

const STYLES: { id: string; name: string; exits: Config['exits'] }[] = [
  { id: 'ride', name: 'Ride it: cost back at 2x, profits at +300%/+900%, trailing stop', exits: { recoverCostAtPct: 100, tp1AtPct: 300, tp1SellPct: 50, tp2AtPct: 900, tp2SellPct: 50, trailingAfterPct: 50, trailingStopPct: 30 } },
  { id: 'quick', name: 'Quick profits: half at +50%, the rest at +100%', exits: { recoverCostAtPct: 0, tp1AtPct: 50, tp1SellPct: 50, tp2AtPct: 100, tp2SellPct: 100, trailingAfterPct: 30, trailingStopPct: 20 } },
  { id: 'early', name: 'Cost back early: at +50%, profits at +200%, trailing stop', exits: { recoverCostAtPct: 50, tp1AtPct: 200, tp1SellPct: 50, tp2AtPct: 0, tp2SellPct: 50, trailingAfterPct: 50, trailingStopPct: 25 } },
  { id: 'trail', name: 'Tight trailing stop: cost back at 2x, sell on a 15% drop after +20%', exits: { recoverCostAtPct: 100, tp1AtPct: 0, tp1SellPct: 50, tp2AtPct: 0, tp2SellPct: 50, trailingAfterPct: 20, trailingStopPct: 15 } },
  { id: 'follow', name: 'Follow their sells only (no take-profits)', exits: { recoverCostAtPct: 0, tp1AtPct: 0, tp1SellPct: 50, tp2AtPct: 0, tp2SellPct: 50, trailingAfterPct: 0, trailingStopPct: 0 } },
];
const STOPS = [25, 40, 60];

export function exitSetups(current: Config): ExitSetup[] {
  const out: ExitSetup[] = [{ id: 'current', name: 'Your current settings', stopLossPct: current.risk.stopLossPct, exits: { ...current.exits }, takeProfitPct: current.risk.takeProfitPct }];
  for (const s of STYLES) for (const sl of STOPS) out.push({ id: `${s.id}-${sl}`, name: `${s.name}; stop-loss −${sl}%`, stopLossPct: sl, exits: s.exits, takeProfitPct: 0 });
  return out;
}

export type SetupResult = { setup: ExitSetup; totalSol: number; roiPct: number | null; closed: number; wins: number; maxDrawdownSol: number; spentSol: number };
export type OptimizeResult = { results: SetupResult[]; best: SetupResult; current: SetupResult; verdict: 'better' | 'small' | 'current' | 'few-trades' | 'all-lose' };

/** Replay every setup; rank by total profit. Ties go to the one with the smaller worst dip. */
export function optimizeExits(swaps: Swap[], cfg: Config, opts: BacktestOpts, marks: Map<string, number | null>, prices: Map<string, PriceSeries>): OptimizeResult {
  const results = exitSetups(cfg).map((setup) => {
    const c = structuredClone(cfg);
    c.risk.stopLossPct = setup.stopLossPct;
    c.risk.takeProfitPct = setup.takeProfitPct;
    c.exits = { lockAtPct: c.exits.lockAtPct, lockFloorPct: c.exits.lockFloorPct, ...setup.exits };
    // Per-wallet exit overrides would hide the difference between setups; test the global ones.
    c.wallets = c.wallets.map(({ exits: _x, strategy: _s, ...w }) => w);
    const r = runBacktest(swaps, c, opts, marks, prices);
    return { setup, totalSol: r.totalSol, roiPct: r.roiPct, closed: r.closed, wins: r.wins, maxDrawdownSol: r.maxDrawdownSol, spentSol: r.spentSol };
  });
  results.sort((a, b) => b.totalSol - a.totalSol || a.maxDrawdownSol - b.maxDrawdownSol);
  const best = results[0];
  const current = results.find((r) => r.setup.id === 'current')!;
  const margin = best.totalSol - current.totalSol;
  const verdict: OptimizeResult['verdict'] =
    best.closed > 0 && best.totalSol <= 0 ? 'all-lose' : best.setup.id === 'current' ? 'current' : current.closed < 10 ? 'few-trades' : margin < Math.max(0.01, current.spentSol * 0.1) ? 'small' : 'better';
  return { results, best, current, verdict };
}
