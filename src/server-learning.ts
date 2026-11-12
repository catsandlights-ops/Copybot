/** Wallet health checks, backtest data, learning, shadow promotion and the weekly auto-tune. */
import { portfolio, SERIES_FILE } from './server-status';
import { writeAtomic } from './util';
import fs from 'node:fs';
import { sanitizeConfig, saveConfig } from './config';
import { chainOf } from './chains';
import { type Check } from './status';
import { alchemyUrl, NEEDS_ALCHEMY } from './chains/base-history';
import { since } from './series';
import { makeConnection } from './env';
import { fetchSwaps } from './analyze';
import * as markets from './markets';
import * as ai from './ai';
import { runBacktest } from './backtest';
import { optimizeExits } from './optimize';
import { applyStrategy, strategyById, pickWalletStrategy } from './strategies';
import { bucketStats, LEARN, learnLessons, updateLessons, type Lesson, type Outcome, type Retired } from './learn';
import { shadowStats, shadowVerdict } from './shadow';
import { engine, broadcast, alert, jobs, addJob, HttpError, addressList, applyChange, chainForAddr, solPerUnit } from './server-core';
import { measuredCopyGap } from './server-scout';

// ---------- wallet health check ----------
export const HEALTH_FILE = 'data/health.json';
export type HealthRow = { address: string; label: string; verdict: import('./rules').HealthVerdict; totalSol: number; roiPct: number | null; closed: number; wins: number; copied: number; unreadable: number; coveredFrom: number | null };
export let lastHealth: { at: number; period: { from: number; to: number }; delayPct: number; wallets: HealthRow[] } | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  } catch {
    return null;
  }
})();

// ---------- backtest data (shared by Backtest and "Find my best settings") ----------
export type BacktestSpec = { wallets: string[]; delayPct: number; replayExits: boolean; range: { from: number; to: number } | null; txs: number; endAt?: number; strategy: string | null; input: Record<string, unknown> };

export function backtestSpec(b: any): BacktestSpec {
  const wallets = addressList(b.wallets, 5, 'wallet address');
  const delayPct = Math.min(50, Math.max(0, Number.isFinite(Number(b.delayPct)) ? Number(b.delayPct) : 5));
  const replayExits = b.replayExits !== false;
  const now = Date.now();
  let range: { from: number; to: number } | null = null;
  if (b.from !== undefined) {
    const from = Number(b.from);
    const to = b.to === undefined || b.to === null ? now : Math.min(now, Number(b.to));
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new HttpError(400, 'Pick a start and end date.');
    if (to <= from) throw new HttpError(400, 'The end date must be after the start date.');
    if (from < now - 180 * 86_400_000) throw new HttpError(400, 'The start date can be at most 180 days ago.');
    if (to - from > 90 * 86_400_000) throw new HttpError(400, 'Pick a period of at most 90 days.');
    range = { from, to };
  }
  const txs = range ? 5000 : Math.min(2000, Math.max(100, Number(b.txs) || 600));
  const endAt = range && range.to < now - 30 * 60_000 ? range.to : undefined; // past period: value holdings at its end
  const strategy = b.strategy === undefined || b.strategy === null ? null : strategyById(b.strategy)?.id ?? null;
  if (b.strategy && !strategy) throw new HttpError(400, 'Unknown strategy');
  return { wallets, delayPct, replayExits, range, txs, endAt, strategy, input: { wallets, txs: range ? null : txs, from: range?.from ?? null, to: range?.to ?? null, delayPct, replayExits, strategy } };
}

/**
 * Everything a backtest needs: the wallets' swaps (cached on disk), the user's settings, price
 * candles (for replaying exits, or valuing holdings at the end of a past period) and today's prices.
 * `widestOpen`: price every token any exit setup might still hold (for comparing setups).
 */
export async function loadBacktestData(spec: BacktestSpec, progress: (p: string) => void, wantCandles: boolean, widestOpen = false) {
  const conn = makeConnection();
  const swaps: import('./decode').Swap[] = [];
  const stats: import('./analyze').FetchStats = { read: 0, failed: 0 };
  const truncated: { wallet: string; oldestMs: number | null }[] = [];
  const { range, wallets, txs } = spec;
  for (const [i, w] of wallets.entries()) {
    const ws: import('./analyze').FetchStats = { read: 0, failed: 0 };
    swaps.push(
      ...(await fetchSwaps(
        conn,
        w,
        txs,
        (n, t) => {
          if (n % 25 === 0 || n === t) progress(`Wallet ${i + 1}/${wallets.length}: reading transaction ${n} of ${t}`);
        },
        { tries: 5, stats: ws, ...(range ? { since: range.from, until: range.to, onScan: (n: number) => progress(`Wallet ${i + 1}/${wallets.length}: finding transactions in your dates (${n} checked)…`) } : {}) },
      )),
    );
    stats.read += ws.read;
    stats.failed += ws.failed;
    if (ws.truncated) truncated.push({ wallet: w, oldestMs: ws.oldestMs ?? null });
  }
  // Your current settings (or a strategy applied to them); wallets you don't copy yet use size ×1 and no budget.
  const cfg = spec.strategy ? applyStrategy(engine.cfg, strategyById(spec.strategy)!) : structuredClone(engine.cfg);
  for (const w of wallets) if (!cfg.wallets.some((x) => x.address === w)) cfg.wallets.push({ address: w, label: w.slice(0, 4), enabled: true, sizeMultiplier: 1, maxExposureSol: 0 });
  const opts = { delayPct: spec.delayPct, feeSol: 0.0002, endAt: spec.endAt };
  // "Follow their sells only" leaves the most positions open, so it shows every token that might need a price.
  // (and with no minimum buy size, so it also sees every token any strategy could buy).
  const probeCfg = widestOpen
    ? { ...structuredClone(cfg), buy: { ...cfg.buy, minTargetBuySol: 0 }, exits: { recoverCostAtPct: 0, tp1AtPct: 0, tp1SellPct: 50, tp2AtPct: 0, tp2SellPct: 50, trailingAfterPct: 0, trailingStopPct: 0, lockAtPct: 0 }, risk: { ...cfg.risk, stopLossPct: 100, takeProfitPct: 0 } }
    : cfg;
  const probe = runBacktest(swaps, probeCfg, opts);
  const stillOpen = new Set(probe.open.map((o) => o.mint));
  const bought = [...new Set(swaps.filter((s) => s.side === 'buy' && probe.trades.some((t) => t.mint === s.mint)).map((s) => s.mint))];
  const prices = new Map<string, import('./backtest').PriceSeries>();
  const needCandles = (wantCandles ? bought : spec.endAt ? bought.filter((m) => stillOpen.has(m)) : []).slice(0, 40);
  for (const [i, mint] of needCandles.entries()) {
    progress(`Loading price history (${i + 1}/${needCandles.length})…`);
    const times = swaps.filter((s) => s.mint === mint && s.blockTime).map((s) => s.blockTime! * 1000);
    const from = Math.min(...times);
    const to = stillOpen.has(mint) ? spec.endAt ?? Date.now() : Math.max(...times) + 3_600_000;
    const h = await markets.priceHistory(mint, from, to, chainForAddr(mint)).catch(() => null);
    if (h) prices.set(mint, h);
  }
  // A period that ends now: price what would still be held at today's prices.
  const marks = new Map<string, number | null>();
  if (!spec.endAt) {
    const open = (needCandles.length ? runBacktest(swaps, probeCfg, opts, new Map(), prices) : probe).open.slice(0, 25);
    for (const [i, o] of open.entries()) {
      progress(`Pricing open positions (${i + 1}/${open.length})…`);
      const raw = BigInt(Math.max(1, Math.floor(o.tokensRaw)));
      marks.set(o.mint, await solPerUnit(o.mint, raw, cfg.safety.slippageBps));
    }
  }
  return { swaps, cfg, opts, prices, marks, stats, truncated, bought: bought.length };
}

/** Start a fresh paper experiment: paper positions, P&L and trades are set aside (a copy is kept). */
export async function resetPaper() {
  const stamp = Date.now();
  await applyChange(() => {
    fs.mkdirSync('data', { recursive: true });
    // Keep a copy, then start fresh: paper positions, paper P&L and paper trades.
    if (fs.existsSync('data/state-paper.json')) fs.renameSync('data/state-paper.json', `data/state-paper.reset-${stamp}.json`);
    if (fs.existsSync('data/trades.jsonl')) {
      const lines = fs.readFileSync('data/trades.jsonl', 'utf8').split('\n').filter(Boolean);
      const isPaper = (l: string) => {
        try {
          return JSON.parse(l).mode === 'paper';
        } catch {
          return false;
        }
      };
      fs.writeFileSync(`data/trades-paper.reset-${stamp}.jsonl`, lines.filter(isPaper).join('\n') + '\n');
      fs.writeFileSync('data/trades.jsonl.tmp', lines.filter((l) => !isPaper(l)).map((l) => l + '\n').join(''));
      fs.renameSync('data/trades.jsonl.tmp', 'data/trades.jsonl');
    }
  });
  // The charts and counts start again too: the 24-hour paper wallet chart and the "signals seen / skipped" counts.
  portfolio.delete('paper');
  fs.rmSync(SERIES_FILE('paper'), { force: true });
  engine.resetPaperStats();
  engine.log(`Paper results reset: the paper wallet is back to ${engine.cfg.paper.startSol} SOL. The old results were kept in the data folder.`, 'system');
  broadcast('trades-reset', {});
}

// ---------- learning: lessons from your own results, and exits re-tuned as markets change ----------
export type JournalEntry = { at: number; kind: 'lesson' | 'retired' | 'exits' | 'strategy' | 'undo'; text: string; setup?: string; undo?: { stopLossPct: number; takeProfitPct: number; exits: import('./config').Config['exits'] }; undoStrategy?: { wallet: string; strategy: string | null } };
export type Learning = { lessons: Lesson[]; retired: Retired[]; journal: JournalEntry[]; lastAt: number; vetoed?: { setup: string; until: number }[] };
export const learnFile = (mode: string) => `data/learning-${mode}.json`;
export function loadLearning(mode: string): Learning {
  try {
    const j = JSON.parse(fs.readFileSync(learnFile(mode), 'utf8'));
    return { lessons: j.lessons ?? [], retired: j.retired ?? [], journal: j.journal ?? [], lastAt: j.lastAt ?? 0, vetoed: j.vetoed ?? [] };
  } catch {
    return { lessons: [], retired: [], journal: [], lastAt: 0 };
  }
}
export let learning = loadLearning(engine.cfg.mode);
export let learningMode = engine.cfg.mode;
export const currentLearning = () => {
  if (learningMode !== engine.cfg.mode) {
    learning = loadLearning(engine.cfg.mode);
    learningMode = engine.cfg.mode;
  }
  engine.lessons = learning.lessons;
  return learning;
};
export function saveLearning() {
  learning.journal = learning.journal.slice(-200);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(learnFile(learningMode) + '.tmp', JSON.stringify(learning));
  fs.renameSync(learnFile(learningMode) + '.tmp', learnFile(learningMode));
  engine.lessons = learning.lessons;
  broadcast('learning', learningView());
}
export const journal = (e: JournalEntry) => {
  learning.journal.push(e);
  engine.log(`Learning: ${e.text}`, 'ai');
};
/** Results of finished sales, with the conditions each position was bought in. */
export function outcomesNow(): Outcome[] {
  return (engine.readTrades() as any[])
    .filter((t) => t.mode === engine.cfg.mode && t.side === 'sell' && typeof t.pnl === 'number' && t.entry && t.sol - t.pnl > 0)
    .map((t) => ({ at: t.t, entry: t.entry, pnl: t.pnl, cost: t.sol - t.pnl }));
}
export function learnRound() {
  const L = currentLearning();
  const now = Date.now();
  const upd = updateLessons(L.lessons, L.retired, learnLessons(outcomesNow(), now, L.retired), now);
  L.lessons = upd.lessons;
  L.retired = upd.retired;
  L.lastAt = now;
  for (const l of upd.expired) journal({ at: now, kind: 'retired', text: `giving ${l.label} another chance after a week; new results will decide.` });
  for (const l of upd.added) journal({ at: now, kind: 'lesson', text: `${l.label} lost you ${Math.abs(l.avgPct).toFixed(0)}% on average over your last ${l.n} trades like it (${l.pnlSol.toFixed(3)} SOL), so Remora avoids them for a week.` });
  saveLearning();
}
export function learningView() {
  const L = currentLearning();
  const outs = outcomesNow().filter((o) => Date.now() - o.at <= LEARN.windowDays * 86_400_000);
  const stats = bucketStats(outs).filter((b) => b.n >= 3);
  return {
    enabled: engine.cfg.learn.enabled,
    autoTuneExits: engine.cfg.learn.autoTuneExits,
    lessons: L.lessons.filter((l) => l.expiresAt > Date.now()),
    journal: L.journal.slice(-30).reverse(),
    lastAt: L.lastAt || null,
    tradesLearnedFrom: outs.length,
    needed: LEARN.minTrades,
    best: [...stats].sort((a, b) => b.avgPct - a.avgPct).slice(0, 3),
    worst: [...stats].sort((a, b) => a.avgPct - b.avgPct).slice(0, 3),
  };
}
currentLearning();
setInterval(() => {
  if (!engine.cfg.learn.enabled || !engine.running) return;
  if (Date.now() - currentLearning().lastAt < 6 * 3_600_000) return;
  try {
    learnRound();
  } catch (e) {
    engine.log(`Learning round failed: ${(e as Error).message}`, 'warn');
  }
}, 10 * 60_000).unref();

/** Switch exits to a better setup, remembering the old ones so it can be undone. */
export async function applyExits(best: NonNullable<Tune['best']>, why: string) {
  const next = structuredClone(engine.cfg);
  const undo = { stopLossPct: next.risk.stopLossPct, takeProfitPct: next.risk.takeProfitPct, exits: structuredClone(next.exits) };
  next.risk.stopLossPct = best.stopLossPct;
  next.risk.takeProfitPct = best.takeProfitPct;
  next.exits = { lockAtPct: next.exits.lockAtPct, lockFloorPct: next.exits.lockFloorPct, ...best.exits };
  const clean = sanitizeConfig(next, true);
  await applyChange(() => saveConfig(clean));
  currentLearning();
  journal({ at: Date.now(), kind: 'exits', text: `exit settings changed to "${best.name}" (${why}).`, setup: best.name, undo });
  saveLearning();
}

/**
 * Learning, per wallet: replay each wallet's last week with your settings and with every strategy,
 * and give it the one that clearly fits it best (switched in paper mode, suggested in live).
 */
export async function tuneWalletStrategies(d: Awaited<ReturnType<typeof loadBacktestData>>, auto: boolean, progress: (p: string) => void) {
  const recentFrom = Date.now() - 2 * 86_400_000;
  const L = currentLearning();
  const vetoed = (key: string) => (L.vetoed ?? []).some((v) => v.setup === key && v.until > Date.now());
  const changes: { address: string; to: string | null; from: string | null; text: string }[] = [];
  for (const w of d.cfg.wallets.filter((x) => x.enabled && replayable(x) && d.swaps.some((s) => s.wallet === x.address))) {
    progress(`Checking which strategy fits ${w.label}…`);
    const pick = pickWalletStrategy(d.swaps, d.cfg, d.opts, d.marks, d.prices, w.address, recentFrom);
    if (!pick?.change || vetoed(`${w.address}:${pick.best.id}`)) continue;
    const sol = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(3)} SOL`;
    changes.push({ address: w.address, to: pick.best.id === 'mine' ? null : pick.best.id, from: w.strategy || null, text: `${w.label}: "${pick.best.name}" fits it best (${sol(pick.best.totalSol)} over the last week vs ${sol(pick.current.totalSol)} with "${pick.current.name}")` });
  }
  if (!changes.length) return;
  if (!auto) {
    for (const c of changes) engine.log(`Strategy check: ${c.text}. Change it on the Wallets page if you agree.`, 'ai');
    alert('autopilot', `🔧 ${changes.length} wallet${changes.length > 1 ? 's' : ''} would do better with another strategy. Open Remora → Wallets.`);
    return;
  }
  const next = structuredClone(engine.cfg);
  for (const c of changes) {
    const w = next.wallets.find((x) => x.address === c.address);
    if (!w) continue;
    if (c.to) w.strategy = c.to;
    else delete w.strategy;
    w.strategyBy = 'learning';
    w.strategyAt = Date.now();
  }
  await applyChange(() => saveConfig(sanitizeConfig(next, false)));
  currentLearning();
  for (const c of changes) journal({ at: Date.now(), kind: 'strategy', text: `${c.text}, so it was switched.`, setup: `${c.address}:${c.to ?? 'mine'}`, undoStrategy: { wallet: c.address, strategy: c.from } });
  saveLearning();
}

// ---------- shadow copying: promote wallets that proved themselves virtually, drop the ones that didn't ----------
export async function checkShadows() {
  const cfg = engine.cfg;
  const shadows = cfg.wallets.filter((w) => w.shadow);
  if (!shadows.length) return;
  const next = structuredClone(cfg);
  const notes: string[] = [];
  for (const w of shadows) {
    const v = shadowVerdict(shadowStats(engine.shadow, w.address, Date.now()));
    const nw = next.wallets.find((x) => x.address === w.address)!;
    if (v.verdict === 'promote') {
      if (next.wallets.filter((x) => x.enabled).length >= cfg.scanner.maxWallets) continue; // wait for a free slot
      Object.assign(nw, { enabled: true, shadow: undefined, pausedReason: undefined, since: Date.now(), ...(cfg.trial.enabled ? { trialStage: 0 as const } : {}) });
      notes.push(`${w.label} proved itself in shadow (${v.why}): now copying for real${cfg.trial.enabled ? ', starting at ¼ size' : ''}.`);
    } else if (v.verdict === 'drop') {
      Object.assign(nw, { shadow: undefined, pausedReason: "didn't prove itself in shadow" });
      notes.push(`${w.label} stopped being shadowed: ${v.why}.`);
    }
  }
  if (!notes.length) return;
  for (const w of next.wallets) if (!w.shadow) delete w.shadow;
  await applyChange(() => saveConfig(sanitizeConfig(next, false)));
  for (const n of notes) engine.log(`Shadow: ${n}`, 'system');
  if (notes.some((n) => n.includes('for real'))) alert('autopilot', `🌓 ${notes.join(' ')}`);
}
setInterval(() => {
  if (engine.running) checkShadows().catch((e) => engine.log(`Shadow check failed: ${(e as Error).message}`, 'warn'));
}, 10 * 60_000).unref();

// ---------- weekly auto-tune: your exits vs other setups on the last 7 days ----------
export type Tune = { at: number; status: 'better' | 'fine' | 'error'; message: string; best?: { name: string; stopLossPct: number; takeProfitPct: number; exits: import('./config').Config['exits']; totalSol: number }; currentSol?: number; dismissed?: boolean };
export const TUNE_FILE = 'data/autotune.json';
export let lastTune: Tune | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(TUNE_FILE, 'utf8'));
  } catch {
    return null;
  }
})();
export function saveTune() {
  fs.mkdirSync('data', { recursive: true });
  writeAtomic(TUNE_FILE, JSON.stringify(lastTune));
  broadcast('autotune', lastTune);
}
/** Wallets whose history can be replayed: Solana always, Base when there's an Alchemy key to read it. */
export const replayable = (w: { address: string; chain?: string }) => chainOf(w) === 'solana' || (chainOf(w) === 'base' && !!alchemyUrl());
export function runAutoTune(manual = false) {
  const wallets = engine.cfg.wallets.filter((w) => w.enabled && replayable(w)).slice(0, 8).map((w) => w.address);
  if (!wallets.length) throw new HttpError(400, engine.cfg.wallets.some((w) => w.enabled && chainOf(w) === 'base') ? NEEDS_ALCHEMY : 'Add wallets to copy first (the settings check replays their history).');
  if (jobs.some((j) => j.kind === 'optimize' && (j.status === 'queued' || j.status === 'running'))) throw new HttpError(409, 'A settings comparison is already running.');
  const now = Date.now();
  const spec = backtestSpec({ wallets, from: now - 7 * 86_400_000, to: now, delayPct: measuredCopyGap() ?? 5 });
  return addJob('optimize', { ...spec.input, auto: !manual }, async (progress) => {
    try {
      const d = await loadBacktestData(spec, progress, true, true);
      progress('Comparing exit settings…');
      const o = optimizeExits(d.swaps, d.cfg, d.opts, d.marks, d.prices);
      let better = o.verdict === 'better';
      // Learning: only trust a winner that also wins on the most recent 2 days alone (not one lucky stretch).
      let recentNote = '';
      if (better && engine.cfg.learn.enabled) {
        const since = (Date.now() - 2 * 86_400_000) / 1000;
        const recent = optimizeExits(d.swaps.filter((x: any) => (x.blockTime ?? 0) >= since), d.cfg, d.opts, d.marks, d.prices);
        const rb = recent.results.find((r) => r.setup.id === o.best.setup.id);
        const rc = recent.results.find((r) => r.setup.id === 'current');
        if (!rb || !rc || rb.closed < 3 || rb.totalSol <= rc.totalSol) {
          better = false;
          recentNote = ` "${o.best.setup.name}" did better over the week but not over the last 2 days, so nothing changes yet.`;
        }
      }
      lastTune = {
        at: Date.now(),
        status: better ? 'better' : 'fine',
        message: better
          ? `On the last 7 days, "${o.best.setup.name}" would have made ${o.best.totalSol >= 0 ? '+' : ''}${o.best.totalSol.toFixed(3)} SOL vs ${o.current.totalSol >= 0 ? '+' : ''}${o.current.totalSol.toFixed(3)} SOL with your exits.`
          : o.verdict === 'all-lose'
            ? 'On the last 7 days every exit setup lost money with these wallets: the wallets are the problem, not the exits. Check them on the Wallets page.'
            : o.verdict === 'few-trades'
              ? 'Too few trades in the last 7 days to compare exit settings fairly. Checking again next week.'
              : 'Your exit settings are as good as any on the last 7 days. Nothing to change.' + recentNote,
        ...(better ? { best: { name: o.best.setup.name, stopLossPct: o.best.setup.stopLossPct, takeProfitPct: o.best.setup.takeProfitPct, exits: o.best.setup.exits, totalSol: o.best.totalSol }, currentSol: o.current.totalSol } : {}),
      };
      saveTune();
      engine.log(`Settings check: ${lastTune.message}`, better ? 'ai' : 'system');
      const auto = engine.cfg.learn.enabled && (engine.cfg.learn.autoTuneExits === 'always' || (engine.cfg.learn.autoTuneExits === 'paper' && engine.cfg.mode === 'paper'));
      const vetoed = (currentLearning().vetoed ?? []).some((v) => v.setup === lastTune!.best?.name && v.until > Date.now());
      if (better && auto && lastTune.best && !vetoed) {
        await applyExits(lastTune.best, `it beat your exits over the last week and the last 2 days: ${o.best.totalSol >= 0 ? '+' : ''}${o.best.totalSol.toFixed(3)} vs ${o.current.totalSol >= 0 ? '+' : ''}${o.current.totalSol.toFixed(3)} SOL`);
        lastTune = { ...lastTune, status: 'fine', message: `Learning switched your exits to "${lastTune.best.name}". You can undo it on the Autopilot page.`, dismissed: true };
        saveTune();
      } else if (better) alert('autopilot', `🔧 ${lastTune.message} Open Remora to use them.`);
      if (engine.cfg.learn.enabled) await tuneWalletStrategies(d, auto, progress);
      return o;
    } catch (e) {
      lastTune = { at: Date.now(), status: 'error', message: `The weekly settings check couldn't run: ${(e as Error).message}` };
      saveTune();
      throw e;
    }
  });
}
setInterval(() => {
  if (!(engine.cfg.tune.weekly || engine.cfg.learn.enabled) || !engine.running || !engine.cfg.wallets.some((w) => w.enabled)) return;
  // Learning re-checks exits every day so they follow the market; otherwise once a week.
  if (Date.now() - (lastTune?.at ?? 0) < (engine.cfg.learn.enabled ? 1 : 7) * 86_400_000) return;
  try {
    runAutoTune();
    engine.log('Weekly settings check: comparing your exits with other setups on the last 7 days…', 'system');
  } catch {
    /* busy: next hour */
  }
}, 60 * 60_000).unref();

/** Which chain a token (or wallet) address belongs to, from its format. */

/** For the routes: the module's own variables can only be changed from here. */
export const setLastTune = (v: typeof lastTune) => (lastTune = v);
export const setLastHealth = (v: typeof lastHealth) => (lastHealth = v);
