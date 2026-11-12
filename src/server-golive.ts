/** The "Ready for live?" report and the go-live assistant. */
import { paperVsLive } from './paperlive';
import { LIVE_FAILURES } from './trader';
import fs from 'node:fs';
import { ORDER_SOURCE, SCANNER_SOURCE } from './config';
import { chainOf } from './chains';
import { liveChecklist, overallVerdict, sourceReport } from './readiness';
import { getChain as getChainAdapter } from './chains';
import { currentLimits, rampAdvice, starterLimits, suggestRoles, type GoLiveRecord } from './golive';
import { hasSecret, rpcUrl } from './env';
import { engine, readTrades } from './server-core';
import { lastStatus } from './server-status';

export const GOLIVE_FILE = 'data/golive.json';
export let goLiveTesting = false;
export function readGoLive(): GoLiveRecord | null {
  try {
    return JSON.parse(fs.readFileSync(GOLIVE_FILE, 'utf8'));
  } catch {
    return null;
  }
}
/** Everything the go-live assistant shows: paper results, the checklist, the trading wallets, the starter limits. */
export async function goLivePlan() {
  const ready = readinessReport();
  const ctx = engine.chainCtx();
  const sol = getChainAdapter('solana');
  const base = getChainAdapter('base');
  const solAddr = engine.kp?.publicKey.toBase58() ?? null;
  const baseAddr = base.liveOwner?.() ?? null;
  const [solBal, ethBal] = await Promise.all([solAddr ? sol.balance(ctx, solAddr).catch(() => null) : null, baseAddr ? base.balance(ctx, baseAddr).catch(() => null) : null]);
  const ethInSol = ethBal != null ? await base.nativeToSol(ethBal).catch(() => null) : null;
  const money = (solBal ?? 0) + (ethInSol ?? 0);
  const usesBaseWallets = engine.cfg.wallets.some((w) => chainOf(w) === 'base' && (w.enabled || w.shadow));
  const rec = readGoLive();
  const liveSells = readTrades(1e9).filter((t: any) => t.mode === 'live' && t.side === 'sell');
  return {
    mode: engine.cfg.mode,
    ...ready,
    wallets: {
      solana: { hasKey: !!engine.kp, address: solAddr, balance: solBal, keyError: engine.keyError ?? null },
      base: { hasKey: hasSecret('BASE_PRIVATE_KEY'), address: baseAddr, balance: ethBal, balanceSol: ethInSol, liveOn: engine.cfg.execution.baseLive, used: usesBaseWallets },
    },
    moneySol: money,
    starter: starterLimits(money, engine.cfg),
    current: currentLimits(engine.cfg),
    roles: suggestRoles(engine.cfg.wallets, ready.sources),
    record: rec,
    ramp: rampAdvice(rec, liveSells, Date.now()),
  };
}

/** Paper results per source, the money-protecting checklist and the overall verdict (Settings and the go-live assistant). */
export function readinessReport() {
  // Paper results per source, with the paper-mode signal counts.
  let stats: import('./readiness').SignalStats = {};
  try {
    stats = engine.cfg.mode === 'paper' ? (engine.saveSigStats(), engine.sigStats) : JSON.parse(fs.readFileSync('data/signal-stats-paper.json', 'utf8'));
  } catch {
    /* none yet */
  }
  const trades = readTrades(1e9);
  const now = Date.now();
  const sources = [
    ...engine.cfg.wallets.map((w) => sourceReport(w.address, w.label, chainOf(w), trades, stats[w.address], getChainAdapter(chainOf(w)).liveTrading, now)),
    sourceReport(SCANNER_SOURCE, 'Market scanner', 'solana', trades, undefined, true, now),
    sourceReport(ORDER_SOURCE, 'Your orders', 'solana', trades, undefined, true, now),
  ].filter((s) => s.buys > 0 || engine.cfg.wallets.some((w) => w.address === s.source));
  const c = engine.cfg;
  const checklist = liveChecklist({
    hasKey: !!engine.kp,
    privateRpc: !rpcUrl().includes('api.mainnet-beta.solana.com'),
    dailyLossLimitSol: c.risk.dailyLossLimitSol,
    stopLossPct: c.risk.stopLossPct,
    maxTotalExposureSol: c.risk.maxTotalExposureSol,
    connectionOk: lastStatus ? lastStatus.summary.level !== 'bad' : null,
    autopilotBudgetOk: !c.ai.enabled || c.ai.dailyBudgetUsd <= 20,
  });
  return { at: now, sources, checklist, overall: overallVerdict(sources, checklist) };
}

export const setGoLiveTesting = (v: boolean) => (goLiveTesting = v);

/** Paper vs live: every live trade against what paper would have booked, plus failed live trades. */
export function paperLiveReport() {
  let failures: { t: number; chain?: string; side: string }[] = [];
  try {
    failures = fs.readFileSync(LIVE_FAILURES, 'utf8').split('\n').filter(Boolean).slice(-1000).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    /* none yet */
  }
  return paperVsLive(readTrades(1e9), failures);
}
