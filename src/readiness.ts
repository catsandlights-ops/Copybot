/**
 * "Ready for live?": judges each paper source (a copied wallet, the market scanner, your orders)
 * on its paper results and how often its trades were missed, plus a checklist of the settings
 * that protect real money. Pure (unit-tested).
 */

export type SkipCategory = 'filters' | 'safety' | 'limits' | 'busy' | 'other';
export type SignalStats = Record<string, { seen: number; copied: number; skips: Partial<Record<SkipCategory, number>> }>;

/** Which kind of reason a skipped buy had. "busy" = a missed trade (a service didn't answer). */
export function skipCategory(why: string): SkipCategory {
  if (/busy|rate|429|limit(ing|s)? exceeded|no answer|timed out|timeout|fetch failed|unavailable|couldn't (check|get)/i.test(why)) return 'busy';
  if (/honeypot|route|freeze|mint authority|token-2022|tax|round-trip|blacklist|rug|pausable|owner|holder|largest|top 10/i.test(why)) return 'safety';
  if (/liquidity|market cap|token age|pool|chase|above their entry|below .* sol|too old|lone|only one wallet|mood/i.test(why)) return 'filters';
  if (/max |budget|exposure|paper wallet|balance|paused|loss limit|losing streak|already holding|positions/i.test(why)) return 'limits';
  return 'other';
}

export type PaperTrade = { t: number; mode: string; side: 'buy' | 'sell'; pnl?: number; source?: string; sources?: string[]; chain?: string };
export type SourceVerdict = 'ready' | 'risky' | 'no' | 'not-yet';
export type SourceReport = {
  source: string;
  name: string;
  chain: string;
  days: number;
  buys: number;
  closed: number;
  wins: number;
  pnlSol: number;
  profitFactor: number | null; // money won / money lost
  worstDipSol: number; // largest fall from a high in its running total
  seen: number;
  copied: number;
  missedPct: number | null; // trades missed because a service was busy
  verdict: SourceVerdict;
  why: string;
};

export const READY_RULES = { minDays: 3, minClosed: 10, minProfitFactor: 1.2, maxMissedPct: 20 };

export function sourceReport(source: string, name: string, chain: string, trades: PaperTrade[], stats: SignalStats[string] | undefined, liveAvailable: boolean, now: number): SourceReport {
  const mine = trades.filter((t) => t.mode === 'paper' && (t.side === 'buy' ? t.source === source : t.sources?.includes(source))).sort((a, b) => a.t - b.t);
  const sells = mine.filter((t) => t.side === 'sell' && typeof t.pnl === 'number');
  let run = 0;
  let high = 0;
  let worst = 0;
  let won = 0;
  let lost = 0;
  for (const s of sells) {
    const p = s.pnl! / Math.max(1, s.sources?.length ?? 1);
    run += p;
    high = Math.max(high, run);
    worst = Math.max(worst, high - run);
    if (p > 0) won += p;
    else lost -= p;
  }
  const days = mine.length ? (now - mine[0].t) / 86_400_000 : 0;
  const missed = stats?.skips.busy ?? 0;
  const missedPct = stats && stats.seen > 0 ? (missed / stats.seen) * 100 : null;
  const r = { source, name, chain, days: Math.round(days * 10) / 10, buys: mine.filter((t) => t.side === 'buy').length, closed: sells.length, wins: sells.filter((s) => s.pnl! > 0).length, pnlSol: Math.round(run * 10_000) / 10_000, profitFactor: lost > 0 ? Math.round((won / lost) * 100) / 100 : won > 0 ? null : null, worstDipSol: Math.round(worst * 10_000) / 10_000, seen: stats?.seen ?? 0, copied: stats?.copied ?? 0, missedPct: missedPct == null ? null : Math.round(missedPct) };
  const R = READY_RULES;
  const pf = lost > 0 ? won / lost : won > 0 ? Infinity : 0;
  let verdict: SourceVerdict;
  let why: string;
  if (r.closed < R.minClosed || days < R.minDays) {
    verdict = 'not-yet';
    why = `needs at least ${R.minClosed} closed trades over ${R.minDays} days in paper mode (has ${r.closed} over ${r.days} days)`;
  } else if (run <= 0) {
    verdict = 'no';
    why = `lost ${run.toFixed(3)} SOL in paper mode: it would lose real money too`;
  } else if (pf < R.minProfitFactor) {
    verdict = 'risky';
    why = `made money, but barely (won ${pf.toFixed(2)}× what it lost): one bad trade could wipe it out`;
  } else if (missedPct != null && missedPct > R.maxMissedPct) {
    verdict = 'risky';
    why = `${Math.round(missedPct)}% of its trades were missed because a service was busy: fix your connection first (Settings → Connection status)`;
  } else {
    verdict = 'ready';
    why = `made ${run.toFixed(3)} SOL in paper mode, winning ${pf === Infinity ? 'every trade' : `${pf.toFixed(2)}× what it lost`}`;
  }
  if (!liveAvailable && verdict === 'ready') {
    verdict = 'risky';
    why += `; but live trading on ${chain === 'base' ? 'Base' : chain} isn't available yet`;
  }
  return { ...r, verdict, why };
}

export type CheckItem = { ok: boolean; text: string; fix: string };

/** The settings that protect real money, as a checklist. */
export function liveChecklist(c: { hasKey: boolean; privateRpc: boolean; dailyLossLimitSol: number; stopLossPct: number; maxTotalExposureSol: number; connectionOk: boolean | null; autopilotBudgetOk: boolean }): CheckItem[] {
  return [
    { ok: c.hasKey, text: 'A trading wallet is set up', fix: 'Settings → Trading wallet. Use a new wallet with only the SOL you are willing to risk.' },
    { ok: c.privateRpc, text: 'A private Solana RPC (not the free public one)', fix: 'The public node misses trades. Add a free Helius RPC in Settings → Connection.' },
    { ok: c.connectionOk !== false, text: c.connectionOk == null ? 'Connection status (not checked yet)' : 'All services are working', fix: 'Run Settings → Connection status and fix what it reports.' },
    { ok: c.dailyLossLimitSol > 0, text: 'A daily loss limit is set', fix: 'Settings → Limits: stops new buys after a bad day.' },
    { ok: c.stopLossPct > 0 && c.stopLossPct <= 60, text: 'A stop-loss is set (60% or less)', fix: 'Settings → Selling.' },
    { ok: c.maxTotalExposureSol > 0 && c.maxTotalExposureSol <= 5, text: 'Total money in trades is capped (5 SOL or less to start)', fix: 'Settings → Limits → Max SOL in open positions. Start small.' },
    { ok: c.autopilotBudgetOk, text: 'The AI autopilot (if on) has a daily budget', fix: 'Settings → Autopilot → Daily AI budget.' },
  ];
}

export function overallVerdict(sources: SourceReport[], checklist: CheckItem[]): { level: 'ready' | 'partly' | 'not-yet'; text: string } {
  const ready = sources.filter((s) => s.verdict === 'ready');
  const failing = checklist.filter((c) => !c.ok);
  if (!ready.length) return { level: 'not-yet', text: sources.some((s) => s.verdict === 'not-yet') ? 'Not yet: keep running in paper mode until your wallets have more results.' : 'Not yet: none of your paper sources made money reliably.' };
  if (failing.length) return { level: 'partly', text: `${ready.length} source${ready.length === 1 ? ' looks' : 's look'} ready, but fix ${failing.length} setting${failing.length === 1 ? '' : 's'} below first.` };
  return { level: 'ready', text: `Ready to try live with ${ready.map((s) => s.name).join(', ')}. Start small, and keep the others in paper.` };
}
