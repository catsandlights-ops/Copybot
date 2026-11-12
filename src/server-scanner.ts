/** The market scanner (coins to trade) and its "Test on the past". */
import { writeAtomic } from './util';
import fs from 'node:fs';
import { SCANNER_SOURCE } from './config';
import { coinSignals, entryRulesFor, exitVariants, replayExit, replaySignals, RULES, signalStats, type CoinSignal, type ExitReplay, type ScanExits } from './scanner';
import { type Check } from './status';
import { alchemyUrl } from './chains/base-history';
import { getChain as getChainAdapter } from './chains';
import { downsample, runningTotal, since } from './series';
import * as markets from './markets';
import { walletExposureSol, walletRecords } from './rules';
import { engine, broadcast } from './server-core';
import { lastWalletReview, walletReviewBusy, runWalletReview, lastSpotAt, spottedCount, spotEveryMs, nextWalletSearchAt } from './server-scout';
import { sparkCache, refreshSparks } from './server-status';

// ---------- market scanner: coins to trade ----------
export type ScanState = { at: number; signals: CoinSignal[]; error: string | null; bought: { mint: string; symbol: string; at: number }[] };
export let lastScan: ScanState = { at: 0, signals: [], error: null, bought: [] };
export const scanTried = new Map<string, number>(); // mint -> when the scanner last tried it (6 h cooldown)
export let scanBusy = false;

// Every signal is written down and checked later against real prices: "is the scanner any good?"
export type SignalRec = { chain?: import('./chains').ChainId; mint: string; symbol: string; kind: 'new' | 'old'; at: number; priceUsd: number; why: string; bought: boolean; skipped?: string; exits: ScanExits; outcome?: ExitReplay; checks?: number };
export const SIGNALS_FILE = 'data/signals.json';
export let signalLog: SignalRec[] = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
})();
export const saveSignals = () => {
  signalLog = signalLog.slice(-1000);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(SIGNALS_FILE + '.tmp', JSON.stringify(signalLog));
  fs.renameSync(SIGNALS_FILE + '.tmp', SIGNALS_FILE);
};
export const scanExits = (): ScanExits => {
  const { stopLossPct, takeProfitPct, trailingAfterPct, trailingStopPct, maxHoldHours } = engine.cfg.scanner;
  return { stopLossPct, takeProfitPct, trailingAfterPct, trailingStopPct, maxHoldHours, lockAtPct: engine.cfg.exits.lockAtPct, lockFloorPct: engine.cfg.exits.lockFloorPct };
};
export function noteSignal(s: CoinSignal, now: number) {
  // One entry per coin per 6 hours, like the scanner's own cooldown.
  if (!s.priceUsd || signalLog.some((r) => r.mint === s.mint && now - r.at < 6 * 3_600_000)) return null;
  const rec: SignalRec = { chain: s.chain ?? 'solana', mint: s.mint, symbol: s.symbol, kind: s.kind, at: now, priceUsd: s.priceUsd, why: s.why, bought: false, exits: scanExits() };
  signalLog.push(rec);
  return rec;
}

/** Check how past signals did: replay their exits on the price since. A few per round (rate limits). */
export let checkingSignals = false;
export async function checkSignals() {
  if (checkingSignals) return;
  checkingSignals = true;
  try {
    const now = Date.now();
    const due = signalLog.filter((r) => !r.outcome?.done && now - r.at >= 3_600_000 && (r.checks ?? 0) < 30).slice(0, 4);
    for (const r of due) {
      const h = await markets.priceHistory(r.mint, r.at, now, r.chain ?? 'solana').catch(() => null);
      r.checks = (r.checks ?? 0) + 1;
      if (!h) continue;
      r.outcome = replayExit(r.priceUsd, r.at + 60_000, h.candles, r.exits);
      // A coin that never hit an exit is settled at its last price once the hold limit (or a day) has passed.
      const limitMs = (r.exits.maxHoldHours || 24) * 3_600_000 + 3_600_000;
      if (!r.outcome.done && now - r.at > limitMs) r.outcome = { ...r.outcome, done: true, reason: 'time limit' };
    }
    if (due.length) {
      saveSignals();
      broadcast('scanner', scannerView());
    }
  } finally {
    checkingSignals = false;
  }
}
setInterval(() => checkSignals().catch(() => {}), 10 * 60_000).unref();
setTimeout(() => checkSignals().catch(() => {}), 60_000).unref();

export function signalProof() {
  const sc = engine.cfg.scanner;
  const done = signalLog.filter((r) => r.outcome?.done);
  const stats = (list: SignalRec[]) => signalStats(list.map((r) => r.outcome!), sc.buySol);
  return {
    tracked: signalLog.length,
    waiting: signalLog.length - done.length,
    all: stats(done),
    bought: stats(done.filter((r) => r.bought)),
    newCoins: stats(done.filter((r) => r.kind === 'new')),
    oldCoins: stats(done.filter((r) => r.kind === 'old')),
    since: signalLog[0]?.at ?? null,
    curve: downsample(runningTotal(done.map((r) => ({ t: r.outcome!.exitAt, v: (sc.buySol * r.outcome!.pnlPct) / 100 }))), 200),
    recent: signalLog
      .slice(-15)
      .reverse()
      .map((r) => ({ mint: r.mint, symbol: r.symbol, kind: r.kind, at: r.at, bought: r.bought, skipped: r.skipped ?? null, outcome: r.outcome ?? null })),
  };
}

/** The coin list may be this old (a little under the scan pace, so every scan sees a fresh one). */
export const coinListAge = () => Math.max(20_000, engine.cfg.scanner.coinsEverySec * 1000 - 5_000);
export let lastScanStart = 0;
export async function scanCoins() {
  const sc = engine.cfg.scanner;
  if (!engine.running || (!sc.tradeCoins && !sc.trackSignals) || scanBusy) return;
  if (Date.now() - lastScanStart < sc.coinsEverySec * 1000 - 2_000) return;
  lastScanStart = Date.now();
  scanBusy = true;
  try {
    const now = Date.now();
    for (const [m, t] of scanTried) if (now - t > 6 * 3_600_000) scanTried.delete(m);
    let rows: import('./markets').PoolRow[];
    try {
      rows = await markets.scoutPools('solana', coinListAge());
    } catch (e) {
      lastScan = { ...lastScan, at: now, error: (e as Error).message };
      broadcast('scanner', scannerView());
      return;
    }
    const skip = new Set([...Object.keys(engine.state.positions), ...scanTried.keys(), ...engine.cfg.safety.blacklist]);
    const opts = { rules: sc.rules, newCoins: sc.newCoins, oldCoins: sc.oldCoins, minLiquidityUsd: engine.cfg.filters.minLiquidityUsd, skip };
    const signals: (CoinSignal & { chain: 'solana' | 'base' })[] = coinSignals(rows, now, opts).map((x) => ({ ...x, chain: 'solana' as const }));
    // Base coins too, when turned on.
    if (sc.baseCoins && (engine.cfg.mode === 'paper' || getChainAdapter('base').liveTrading)) {
      const baseRows = await markets.scoutPools('base', coinListAge()).catch(() => []);
      signals.push(...coinSignals(baseRows, now, opts).map((x) => ({ ...x, chain: 'base' as const })));
      signals.sort((a, b) => b.score - a.score);
    }
    lastScan = { ...lastScan, at: now, signals: signals.slice(0, 8), error: null };
    refreshSparks(signals.slice(0, 5).map((s) => ({ mint: s.mint, chain: s.chain }))).then(() => broadcast('scanner', scannerView())).catch(() => {});
    const notes = new Map<string, SignalRec>();
    for (const s of signals.slice(0, 8)) {
      const rec = noteSignal(s, now);
      if (rec) notes.set(s.mint, rec);
    }
    // Only try to buy when the scanner has room, so a full scanner doesn't fill the log.
    const positions = Object.values(engine.state.positions);
    const held = positions.filter((p) => p.sources.includes(SCANNER_SOURCE)).length;
    const room = sc.tradeCoins && held < sc.maxPositions && sc.budgetSol - walletExposureSol(positions, SCANNER_SOURCE) >= Math.max(0.001, sc.buySol / 2);
    if (sc.tradeCoins && !room) for (const r of notes.values()) r.skipped = 'scanner full';
    if (!sc.tradeCoins) for (const r of notes.values()) r.skipped = 'watching only';
    if (room) {
      for (const s of signals.slice(0, 2)) {
        scanTried.set(s.mint, now);
        const why = await engine.scannerBuy({ mint: s.mint, symbol: s.symbol, why: s.why, chain: s.chain });
        const rec = notes.get(s.mint);
        if (rec) {
          rec.bought = !why;
          if (why) rec.skipped = why;
        }
        if (!why) {
          lastScan.bought = [{ mint: s.mint, symbol: s.symbol, at: Date.now() }, ...lastScan.bought].slice(0, 10);
          break; // one coin per scan
        }
        if (!engine.running || !engine.cfg.scanner.tradeCoins) break;
      }
    }
    if (notes.size) saveSignals();
    broadcast('scanner', scannerView());
  } finally {
    scanBusy = false;
  }
}

// ---------- "Test on the past": replay the scanner's rules on recent price history ----------
export const SCANTEST_FILE = 'data/scanner-test.json';
export type ScanTestRow = { entry: 'normal' | 'strict' | 'loose'; exitId: string; name: string; exits: ScanExits; stats: ReturnType<typeof signalStats> };
export type ScanTest = { at: number; days: number; coins: { symbol: string; kind: 'new' | 'old'; signals: number }[]; rows: ScanTestRow[]; trades: { symbol: string; kind: string; at: number; up1hPct: number; result: ExitReplay }[]; skippedCoins: number };
export let lastScannerTest: ScanTest | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(SCANTEST_FILE, 'utf8'));
  } catch {
    return null;
  }
})();
export const ENTRY_NAMES = { normal: 'Your rules', strict: 'Pickier rules', loose: 'Looser rules' } as const;

export function scannerTestSummary(t: ScanTest) {
  const ranked = [...t.rows].sort((a, b) => b.stats.totalSol - a.stats.totalSol);
  const current = t.rows.find((r) => r.entry === 'normal' && r.exitId === 'current')!;
  const best = ranked[0];
  const verdict = current.stats.signals < 10 ? 'few' : best.stats.totalSol <= 0 ? 'all-lose' : current.stats.totalSol > 0 ? (best === current ? 'current-best' : 'works') : 'current-loses';
  return { at: t.at, days: t.days, coins: t.coins.length, coinsWithSignals: t.coins.filter((c) => c.signals).length, skippedCoins: t.skippedCoins, current, best, verdict, rows: ranked.map((r) => ({ ...r, entryName: ENTRY_NAMES[r.entry] })), trades: t.trades.slice(0, 60) };
}

export async function runScannerTest(days: number, progress: (p: string) => void): Promise<ScanTest> {
  const sc = engine.cfg.scanner;
  progress('Finding coins to test on: trending, new and top volume…');
  const rows = await markets.scoutPools();
  const now = Date.now();
  // One pool per coin (its deepest), with enough liquidity and trading to be a scanner candidate.
  const best = new Map<string, import('./markets').PoolRow>();
  for (const r of rows) {
    if (!r.createdAt || now - r.createdAt < 3_600_000) continue;
    const kind = now - r.createdAt <= 7 * 86_400_000 ? 'new' : 'old';
    if (kind === 'new' ? !sc.newCoins : !sc.oldCoins) continue;
    if ((r.liquidityUsd ?? 0) < RULES[kind].minLiq || (r.volume24h ?? 0) < RULES[kind].minVol24) continue;
    if (['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'].includes(r.mint)) continue;
    const prev = best.get(r.mint);
    if (!prev || (r.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) best.set(r.mint, r);
  }
  const coins = [...best.values()].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, 24);
  if (!coins.length) throw new Error('No coins with enough liquidity and trading to test on right now. Try again later.');
  const series: { r: import('./markets').PoolRow; kind: 'new' | 'old'; candles: import('./markets').Candle[]; step: number }[] = [];
  let skipped = 0;
  for (const [i, r] of coins.entries()) {
    progress(`Loading price history ${i + 1}/${coins.length} (${r.symbol})…`);
    // A day extra before the test period, for the "usual volume" and 24-hour change.
    const h = await markets.priceHistory(r.mint, now - (days + 1) * 86_400_000, now).catch(() => null);
    // 5-minute candles for 1 day, 15-minute for longer (the service returns at most 1000 candles).
    if (!h || h.step > 900_000 || h.candles.length < (3_600_000 / h.step) * 26) {
      skipped++;
      continue;
    }
    series.push({ r, kind: now - r.createdAt! <= 7 * 86_400_000 ? 'new' : 'old', candles: h.candles, step: h.step });
  }
  if (!series.length) throw new Error("Couldn't load price history for any coin. The market data service may be busy: try again in a few minutes.");
  progress('Replaying the scanner rules…');
  const from = now - days * 86_400_000;
  const out: ScanTestRow[] = [];
  let trades: ScanTest['trades'] = [];
  const coinSignalsCount = new Map<string, number>();
  for (const entry of ['normal', 'strict', 'loose'] as const) {
    for (const v of exitVariants(scanExits())) {
      const results: ExitReplay[] = [];
      for (const s of series) {
        const sig = replaySignals(s.candles, s.step, entryRulesFor(s.kind, entry), v.exits).filter((x) => x.at >= from);
        results.push(...sig.map((x) => x.result));
        if (entry === 'normal' && v.id === 'current') {
          coinSignalsCount.set(s.r.mint, sig.length);
          trades.push(...sig.map((x) => ({ symbol: s.r.symbol, kind: s.kind, at: x.at, up1hPct: x.up1hPct, result: x.result })));
        }
      }
      out.push({ entry, exitId: v.id, name: v.name, exits: v.exits, stats: signalStats(results, sc.buySol) });
    }
  }
  trades = trades.sort((a, b) => b.at - a.at);
  const result: ScanTest = { at: now, days, coins: series.map((s) => ({ symbol: s.r.symbol, kind: s.kind, signals: coinSignalsCount.get(s.r.mint) ?? 0 })), rows: out, trades, skippedCoins: skipped };
  lastScannerTest = result;
  fs.mkdirSync('data', { recursive: true });
  writeAtomic(SCANTEST_FILE, JSON.stringify(result));
  return result;
}

export function scannerView() {
  const rec = walletRecords(engine.readTrades(), engine.cfg.mode)[SCANNER_SOURCE] ?? { trades: 0, closed: 0, wins: 0, pnlSol: 0 };
  return { ...lastScan, sparks: Object.fromEntries(lastScan.signals.map((s) => [s.mint, downsample(sparkCache.get(s.mint)?.pts ?? [], 48)])), record: rec, proof: signalProof(), test: lastScannerTest ? scannerTestSummary(lastScannerTest) : null, nextTraderSearch: nextWalletSearchAt(), spotter: { solana: spottedCount('solana'), base: spottedCount('base'), lastAt: lastSpotAt || null, nextAt: engine.cfg.scanner.findTraders ? Math.max(lastSpotAt + spotEveryMs(), Date.now()) : null, alternatesBase: !!alchemyUrl() } };
}

setInterval(() => scanCoins().catch((e) => engine.log(`Market scanner: ${(e as Error).message}`, 'warn')), 10_000).unref();

// Automatic wallet reviews while the bot is running.
setInterval(() => {
  const a = engine.cfg.ai;
  if (!engine.running || !a.enabled || !a.manageWallets || walletReviewBusy) return;
  if (Date.now() - lastWalletReview < a.walletReviewHours * 3_600_000) return;
  runWalletReview().catch((e) => engine.log(`Claude wallet review: ${(e as Error).message}`, 'warn'));
}, 10 * 60_000).unref();
