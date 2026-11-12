/** Finding wallets: the autopilot's wallet reviews, the wallet scout and the spotter. */
import { writeAtomic } from './util';
import fs from 'node:fs';
import { sanitizeConfig, saveConfig } from './config';
import { chainOf } from './chains';
import { plainSkip } from './readiness';
import { alchemyUrl, NEEDS_ALCHEMY } from './chains/base-history';
import { since } from './series';
import { PublicKey } from '@solana/web3.js';
import { hasSecret, makeConnection, rpcUrl } from './env';
import { fetchSwaps, score } from './analyze';
import { earlyBuyers, rankCandidates } from './discover';
import * as markets from './markets';
import { median, walletRecords } from './rules';
import * as ai from './ai';
import { runBacktest } from './backtest';
import { SHADOW } from './shadow';
import { addSpotted, forgetSpotted, mergeCaught, spottedFor, type Spotted } from './spotter';
import { earlyVerdict, prescreen, readEnough, rejectReason, searchSummary } from './scout';
import { passesBacktest, passesBasics, pickCandidates, pickTokens, pumpBuyers, rulePicks, suggestStrategy, ScoutReport, ScoutResult } from './scout';
import { engine, broadcast, jobs, addJob, HttpError, applyChange, trialAndResume, solPerUnit } from './server-core';
import { scannerView } from './server-scanner';

// ---------- autopilot: wallet reviews ----------
export const WALLET_REVIEW_FILE = 'data/ai-wallet-review.json';
export let lastWalletReview = (() => {
  try {
    return Number(JSON.parse(fs.readFileSync(WALLET_REVIEW_FILE, 'utf8')).at) || 0;
  } catch {
    return 0;
  }
})();
export let walletReviewBusy = false;

export const scoutView = (r: ScoutReport): ai.CandidateView => ({
  address: r.wallet,
  source: 'scout',
  stats: { swaps: r.swaps, days: r.days, tradesPerDay: r.tradesPerDay, closedTokens: r.closedTokens, winRate: r.winRate, realizedPnlSol: r.realizedPnlSol, roiPct: r.roiPct, medianBuySol: r.medianBuySol, medianHoldMin: r.medianHoldMin, earlyOnPumpedTokens: r.earlyOn, caughtRecentPumpOn: r.pumpOn ?? [], topTraderOn: r.topTraderOn, backtestCopyingItWithOurSettings: r.bt ?? null, notes: r.notes },
});

/** Wallets the AI may add: the ones the user analyzed or discovered, plus the latest scout results. */
export function aiCandidates(): ai.CandidateView[] {
  const out = new Map<string, ai.CandidateView>();
  for (const r of lastScout?.reports ?? []) if (passesBasics(r) && (!r.bt || passesBacktest(r))) out.set(r.wallet, scoutView(r));
  for (const j of jobs) {
    if (j.status !== 'done') continue;
    if (j.kind === 'scout') continue; // covered by lastScout
    if (j.kind === 'analyze') {
      for (const r of j.result as any[]) {
        if (r.swaps > 0) out.set(r.wallet, { address: r.wallet, source: 'analyzed', stats: { swaps: r.swaps, days: r.days, tradesPerDay: r.tradesPerDay, closedTokens: r.closedTokens, winRate: r.winRate, realizedPnlSol: r.realizedPnlSol, roiPct: r.roiPct, medianBuySol: r.medianBuySol, medianHoldMin: r.medianHoldMin, notes: r.notes } });
      }
    } else {
      for (const c of (j.result as any).candidates ?? []) {
        if (!out.has(c.wallet)) out.set(c.wallet, { address: c.wallet, source: 'early buyer', stats: { earlyOnTokens: c.mints.length, solSpentEarly: c.sol } });
      }
    }
  }
  const mine = new Set(engine.cfg.wallets.map((w) => w.address));
  return [...out.values()].filter((c) => !mine.has(c.address));
}

export async function runWalletReview(): Promise<{ changes: ai.WalletChange[]; summary: string }> {
  if (walletReviewBusy) throw new HttpError(409, `${ai.AiName(engine.cfg)} is already reviewing your wallets.`);
  const cfg = engine.cfg;
  if (!cfg.wallets.length && !aiCandidates().length) throw new HttpError(400, 'Add some wallets, or analyze a few candidates on the Find wallets page first.');
  walletReviewBusy = true;
  lastWalletReview = Date.now();
  fs.mkdirSync('data', { recursive: true });
  writeAtomic(WALLET_REVIEW_FILE, JSON.stringify({ at: lastWalletReview }));
  try {
    const recs = walletRecords(engine.readTrades(), cfg.mode);
    const view: ai.WalletView[] = cfg.wallets.map((w) => ({ address: w.address, label: w.label, enabled: w.enabled, sizeMultiplier: w.sizeMultiplier, budgetSol: w.maxExposureSol, ourRecord: recs[w.address] ?? { trades: 0, closed: 0, wins: 0, pnlSol: 0 } }));
    engine.log(`${ai.AiName(engine.cfg)} is reviewing your wallets…`, 'ai');
    const r = await ai.reviewWallets(cfg, view, aiCandidates());
    if (!r) throw new HttpError(502, ai.aiStatus(cfg).lastError ?? `${ai.AiName(engine.cfg)} did not answer.`);
    if (!r.changes.length) {
      engine.log(`${ai.AiName(engine.cfg)}: no wallet changes. ${r.summary}`, 'ai');
      return r;
    }
    // Apply to the latest config, never going over the active-wallet limit.
    const next = structuredClone(engine.cfg);
    const applied: ai.WalletChange[] = [];
    const active = () => next.wallets.filter((w) => w.enabled).length;
    for (const ch of r.changes) {
      const w = next.wallets.find((x) => x.address === ch.address);
      if (ch.action === 'add') {
        if (w || active() >= cfg.ai.maxWallets || next.wallets.length >= 100) continue;
        next.wallets.push({ address: ch.address, label: `ai-${ch.address.slice(0, 4)}`, enabled: true, sizeMultiplier: ch.sizeMultiplier, maxExposureSol: ch.budgetSol });
      } else if (!w) continue;
      else if (ch.action === 'pause') w.enabled = false;
      else if (ch.action === 'resume') {
        if (w.enabled || active() >= cfg.ai.maxWallets) continue;
        w.enabled = true;
      } else {
        w.sizeMultiplier = ch.sizeMultiplier;
        w.maxExposureSol = ch.budgetSol;
      }
      applied.push(ch);
    }
    if (applied.length) {
      const clean = sanitizeConfig(next, false);
      trialAndResume(clean);
      await applyChange(() => saveConfig(clean));
      for (const ch of applied) engine.log(`${ai.AiName(engine.cfg)}: ${ch.action} ${ch.address.slice(0, 4)}…${ch.address.slice(-4)}${ch.action === 'pause' ? '' : ` (size ×${ch.sizeMultiplier}${ch.budgetSol ? `, budget ${ch.budgetSol} SOL` : ''})`}: ${ch.reason}`, 'ai');
    }
    return { changes: applied, summary: r.summary };
  } finally {
    walletReviewBusy = false;
  }
}

// ---------- wallet scout ----------
export const SCOUT_FILE = 'data/scout.json';
export let lastScout: ScoutResult | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(SCOUT_FILE, 'utf8'));
  } catch {
    return null;
  }
})();
export let scoutRunning = false;

/** The user's median copy gap (%) in the current mode, once there are 5+ measured trades. */
export function measuredCopyGap(): number | null {
  const g = engine.readTrades().filter((t: any) => t.mode === engine.cfg.mode && typeof t.gapPct === 'number').map((t: any) => t.gapPct as number);
  return g.length >= 5 ? Math.max(0, median(g)!) : null;
}

/** What copying one wallet over its fetched history would have made with the user's settings. */
export async function quickBacktest(wallet: string, swaps: import('./decode').Swap[], delayPct: number): Promise<import('./scout').ScoutBacktest> {
  const cfg = structuredClone(engine.cfg);
  if (!cfg.wallets.some((w) => w.address === wallet)) cfg.wallets.push({ address: wallet, label: wallet.slice(0, 4), enabled: true, sizeMultiplier: 1, maxExposureSol: 0 });
  const opts = { delayPct, feeSol: 0.0002 };
  const first = runBacktest(swaps, cfg, opts);
  const marks = new Map<string, number | null>();
  for (const o of first.open.slice(0, 8)) {
    const raw = BigInt(Math.max(1, Math.floor(o.tokensRaw)));
    marks.set(o.mint, await solPerUnit(o.mint, raw, cfg.safety.slippageBps));
  }
  const r = runBacktest(swaps, cfg, opts, marks);
  return { totalSol: r.totalSol, roiPct: r.roiPct, closed: r.closed, wins: r.wins, delayPct };
}

// Tokens scanned by recent searches go to the back of the line next time, so searches vary.
export const SCOUT_HISTORY = 'data/scout-history.json';

// ---------- the spotter: traders who just caught a move, noted between full wallet searches ----------
export const SPOT_FILE = 'data/spotted.json';
export let spotPool: Spotted[] = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(SPOT_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
})();
export const saveSpot = () => {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(SPOT_FILE + '.tmp', JSON.stringify(spotPool));
  fs.renameSync(SPOT_FILE + '.tmp', SPOT_FILE);
};
export let lastSpotAt = 0;
export let spotBusy = false;
export const spotRecent = new Map<string, number>(); // pool -> when last spotted (rotate through coins)
/** One spotting round on a chain: what's moving now, and who bought it well (market data only, a few requests). */
export async function spotOnce(chain: import('./chains').ChainId): Promise<number> {
  const now = Date.now();
  const rows = await markets.scoutPools(chain);
  const recent = new Set([...spotRecent].filter(([, t]) => now - t < 2 * 3_600_000).map(([m]) => m));
  const tokens = pickTokens(rows, now, 4, recent, 1);
  const found = new Map<string, string[]>();
  for (const t of tokens) {
    spotRecent.set(t.mint, now);
    const trades = await markets.poolTrades(t.pool, 300, chain).catch(() => []);
    for (const w of pumpBuyers(trades, t.priceUsd, 25).keys()) found.set(w, [...(found.get(w) ?? []), t.symbol]);
  }
  spotPool = addSpotted(spotPool, chain, found, now);
  saveSpot();
  return found.size;
}
export const spottedCount = (chain?: import('./chains').ChainId) => spotPool.filter((s) => !chain || s.chain === chain).length;
export function recentScoutMints(): Set<string> {
  try {
    const l = JSON.parse(fs.readFileSync(SCOUT_HISTORY, 'utf8'));
    return new Set(Array.isArray(l) ? l.filter((m) => typeof m === 'string') : []);
  } catch {
    return new Set();
  }
}
export function rememberScoutMints(mints: string[]) {
  const l = [...mints, ...recentScoutMints()].filter((m, i, a) => a.indexOf(m) === i).slice(0, 18);
  fs.mkdirSync('data', { recursive: true });
  writeAtomic(SCOUT_HISTORY, JSON.stringify(l));
}

export function startScout(auto: boolean, chain: import('./chains').ChainId = 'solana') {
  if (scoutRunning || jobs.some((j) => j.kind === 'scout' && (j.status === 'queued' || j.status === 'running'))) throw new HttpError(409, 'The wallet scout is already running.');
  if (chain === 'base' && !alchemyUrl()) throw new HttpError(400, NEEDS_ALCHEMY);
  scoutRunning = true;
  return addJob('scout', { auto, chain }, async (progress) => {
    try {
      return await runScout(progress, auto, chain);
    } finally {
      scoutRunning = false;
    }
  });
}

export async function runScout(progress: (p: string) => void, auto = false, chain: import('./chains').ChainId = 'solana'): Promise<ScoutResult> {
  const notes: string[] = [];
  const at = Date.now();
  const onBase = chain === 'base';
  progress(`Looking for coins that are moving${onBase ? ' on Base' : ''}: trending, new launches, top volume and older coins…`);
  const rows = await markets.scoutPools(chain);
  if (onBase) notes.push(`Base search: traders who caught recent moves and early buyers (DexCheck top traders are Solana-only).${engine.cfg.mode === 'live' && !engine.cfg.execution.baseLive ? ' In live mode, Base wallets are only copied once Live trading on Base is on (Settings → Trading wallet).' : ''}`);
  const tokens = pickTokens(rows, at, 7, recentScoutMints(), 2);
  if (!tokens.length) throw new Error('No suitable coins right now (none up 30%+ in 6 or 24 hours with real liquidity, or older coins up 15%+). Try again later.');
  const symbols = new Map(tokens.map((t) => [t.mint, t.symbol]));

  // 1. "Caught the pump": recent big buyers now well in profit (every token, fast).
  const pump = new Map<string, string[]>();
  for (const [i, t] of tokens.entries()) {
    progress(`Token ${i + 1}/${tokens.length} (${t.symbol}): finding buyers who caught the move…`);
    const trades = await markets.poolTrades(t.pool, 300, chain).catch(() => []);
    for (const w of pumpBuyers(trades, t.priceUsd, 40).keys()) pump.set(onBase ? w.toLowerCase() : w, [...(pump.get(onBase ? w.toLowerCase() : w) ?? []), t.symbol]);
  }
  // 2. True early buyers, for tokens quiet enough to read back to their launch.
  const conn = makeConnection();
  const perMint = new Map<string, Map<string, number>>();
  // On Base, a coin's first transfers are read directly (oldest first), so any coin will do.
  const quiet = onBase ? [...tokens.filter((t) => t.quiet), ...tokens.filter((t) => !t.quiet)].slice(0, 3) : tokens.filter((t) => t.quiet).slice(0, 3);
  for (const [i, t] of quiet.entries()) {
    progress(`Early buyers ${i + 1}/${quiet.length} (${t.symbol})…`);
    if (onBase) {
      const early = await import('./chains/base-history').then((m) => m.baseEarlyBuyers(t.mint, t.pool, 120)).catch((e: Error) => {
        notes.push(`${t.symbol}: couldn't read its early buyers (${plainSkip(e.message)}).`);
        return null;
      });
      if (early?.size) perMint.set(t.mint, early);
      continue;
    }
    // A busy node shouldn't sink the whole search: skip this coin's early buyers and carry on.
    const early = await earlyBuyers(conn, t.mint, 120, 30, () => notes.push(`${t.symbol}: its "early buyers" are the earliest within its last 30,000 transactions, not its very first.`), (m) => progress(`Early buyers ${i + 1}/${quiet.length} (${t.symbol}): ${m}`)).catch((e: Error) => {
      notes.push(`${t.symbol}: couldn't read its early buyers (${plainSkip(e.message)}); a private RPC such as Helius makes searches more complete.`);
      return null;
    });
    if (early) perMint.set(t.mint, early);
  }
  const top = new Map<string, string[]>();
  if (!onBase && hasSecret('DEXCHECK_API_KEY')) {
    progress('Adding DexCheck top traders…');
    for (const t of tokens) {
      const traders = await markets.topTraders(t.pool, '7d').catch(() => []);
      for (const tr of traders.filter((x: any) => (x.profitUsd ?? 0) > 0).slice(0, 10)) top.set(tr.wallet, [...(top.get(tr.wallet) ?? []), t.symbol]);
    }
  }
  const mine = new Set(engine.cfg.wallets.map((w) => w.address));
  // Traders the spotter noted since the last search join in (those seen on several coins rank higher).
  const spotted = spottedFor(spotPool, chain, mine);
  if (spotted.size) notes.push(`${spotted.size} trader${spotted.size > 1 ? 's' : ''} spotted catching moves since the last search ${spotted.size > 1 ? 'were' : 'was'} considered too.`);
  const cands = pickCandidates(rankCandidates(perMint), top, symbols, mine, 15, mergeCaught(pump, spotted));
  if (!cands.length) throw new Error('Found no wallets worth analyzing this time. Try again later.');

  const reports: ScoutReport[] = [];
  const unreadable: string[] = [];
  const quick: { wallet: string; why: string }[] = []; // set aside early: no need to read their whole history
  const history = new Map<string, import('./decode').Swap[]>();
  // A busy node can make this crawl: after 40 minutes, decide with the wallets checked so far.
  const deadline = at + 40 * 60_000;
  for (const [i, c] of cands.entries()) {
    if (Date.now() > deadline && i > 0) {
      notes.push(`Stopped after 40 minutes (the network was slow); the other ${cands.length - i} wallet${cands.length - i === 1 ? '' : 's'} wait for the next search. A private RPC such as Helius makes searches much faster.`);
      break;
    }
    // 1. One cheap look at its latest transactions: skip obvious bots and wallets that stopped trading.
    if (!onBase) {
      const page = await conn.getSignaturesForAddress(new PublicKey(c.wallet), { limit: 1000 }).catch(() => null);
      const why = page ? prescreen(page.map((x) => x.blockTime ?? null), Date.now()) : null;
      if (why) {
        quick.push({ wallet: c.wallet, why });
        continue;
      }
    }
    const progressFn = (n: number, t: number) => {
      if (n % 25 === 0 || n === t) progress(`Checking wallet ${i + 1}/${cands.length}: transaction ${n} of ${t}`);
    };
    // 2. Its latest 150 transactions first; a wallet that's clearly out isn't read further.
    const stats = { read: 0, failed: 0 };
    let swaps = await fetchSwaps(conn, c.wallet, 150, progressFn, { deadline: i > 0 ? deadline : undefined, tries: 4, stats }).catch(() => null);
    // Too much of the history failed to download: don't judge the wallet on scraps; try again next search.
    if (swaps && !readEnough(stats)) {
      unreadable.push(c.wallet);
      continue;
    }
    if (!swaps) continue;
    const early = earlyVerdict(score(c.wallet, swaps));
    if (early) {
      quick.push({ wallet: c.wallet, why: early });
      continue;
    }
    // 3. Promising: read up to 500 (the first 150 come from the cache) and judge on all of it.
    const stats2 = { read: 0, failed: 0 };
    const more = await fetchSwaps(conn, c.wallet, 500, progressFn, { deadline: i > 0 ? deadline : undefined, tries: 4, stats: stats2 }).catch(() => null);
    if (more && readEnough(stats2)) swaps = more;
    history.set(c.wallet, swaps);
    reports.push({ ...score(c.wallet, swaps), earlyOn: c.earlyOn, topTraderOn: c.topTraderOn, pumpOn: c.pumpOn });
  }
  // Spotted traders that were checked are done; ones not reached stay for the next search.
  spotPool = forgetSpotted(spotPool, chain, [...reports.map((r) => r.wallet), ...quick.map((q) => q.wallet)]);
  saveSpot();
  // Backtest the promising ones with the user's own settings and copy delay: a wallet that made
  // money for itself can still lose money for someone copying it a few seconds later.
  const delayPct = measuredCopyGap() ?? 5;
  const promising = reports.filter(passesBasics).slice(0, 8);
  for (const [i, r] of promising.entries()) {
    progress(`Backtesting ${i + 1}/${promising.length} with your settings…`);
    r.bt = await quickBacktest(r.wallet, history.get(r.wallet) ?? [], delayPct);
  }
  reports.sort((a, b) => b.realizedPnlSol - a.realizedPnlSol);

  // Let Claude choose; fall back to the rule-based ranking.
  const cfg = engine.cfg;
  // Added automatically by the autopilot, or by the market scanner's trader finder on its own runs.
  const byAi = cfg.ai.enabled && cfg.ai.manageWallets;
  const byScanner = !byAi && auto && cfg.scanner.findTraders;
  const autoAdd = byAi || byScanner;
  const maxWallets = byAi ? cfg.ai.maxWallets : cfg.scanner.maxWallets;
  const perRun = byAi ? cfg.ai.scoutMaxPicks : byScanner ? cfg.scanner.picksPerRun : cfg.ai.scoutMaxPicks;
  const free = Math.max(0, maxWallets - cfg.wallets.filter((w) => w.enabled).length);
  const max = autoAdd ? Math.min(perRun, free) : perRun;
  if (autoAdd && !free) notes.push(`You already copy ${maxWallets} wallets (the ${byAi ? "autopilot's" : "scanner's"} maximum), so nothing new was added.`);
  // Only wallets that pass the basic checks can be picked, by Claude or by the rules.
  const basics = reports.filter(passesBasics);
  const eligible = basics.filter(passesBacktest);
  const btNote = (r: ScoutReport) => (r.bt ? ` Copying it with your settings would have made ${r.bt.totalSol >= 0 ? '+' : ''}${r.bt.totalSol.toFixed(3)} SOL over ${r.bt.closed} trades.` : '');
  let picks = rulePicks(eligible, max).map((p) => ({ ...p, reason: p.reason + btNote(eligible.find((r) => r.wallet === p.address)!) }));
  let pickedBy: ScoutResult['pickedBy'] = 'rules';
  let summary = picks.length
    ? `Ranked by win rate, return and number of trades, among wallets whose backtest with your settings made money.`
    : basics.length
      ? `${basics.length} wallet${basics.length > 1 ? 's' : ''} looked good on ${basics.length > 1 ? 'their' : 'its'} own record, but a backtest with your settings and a ${delayPct.toFixed(1)}% copy delay showed copying ${basics.length > 1 ? 'them' : 'it'} would have lost money, so nothing was picked.`
      : `None of the ${reports.length} wallets checked passed the basics: 10+ finished trades, profitable overall, not a bot, and not selling within 2 minutes. Most wallets that catch one pump don't keep winning.`;
  if (max > 0 && eligible.length && (cfg.ai.provider === 'ollama' || hasSecret('ANTHROPIC_API_KEY'))) {
    progress('Claude is choosing…');
    const recs = walletRecords(engine.readTrades(), cfg.mode);
    const current = cfg.wallets.map((w) => ({ address: w.address, label: w.label, enabled: w.enabled, sizeMultiplier: w.sizeMultiplier, budgetSol: w.maxExposureSol, ourRecord: recs[w.address] ?? { trades: 0, closed: 0, wins: 0, pnlSol: 0 } }));
    const r = await ai.pickWallets(cfg, current, eligible.map(scoutView), max);
    if (r) {
      picks = r.picks;
      pickedBy = 'claude';
      summary = r.summary;
    } else notes.push(`${ai.AiName(engine.cfg)} wasn't available (${ai.aiStatus(cfg).lastError ?? 'no answer'}), so the picks are rule-based.`);
  }

  // Suggest a strategy that suits each pick's trading style.
  picks = picks.map((p) => {
    const rep = reports.find((r) => r.wallet === p.address);
    if (!rep) return p;
    const s = suggestStrategy(rep);
    return { ...p, strategy: s.id, strategyWhy: s.why };
  });
  const added: string[] = [];
  if (autoAdd && picks.length) {
    const next = structuredClone(engine.cfg);
    // In live mode (or always, if chosen), new finds are copied virtually first and must prove themselves.
    const shadowFirst = (cfg.trial.shadowFirst === 'always' || (cfg.trial.shadowFirst === 'live' && cfg.mode === 'live'));
    for (const p of picks) {
      if (next.wallets.some((w) => w.address === p.address)) continue;
      if (shadowFirst ? next.wallets.filter((w) => w.shadow).length >= SHADOW.max : next.wallets.filter((w) => w.enabled).length >= maxWallets) continue;
      next.wallets.push({ address: p.address, label: `scout-${p.address.slice(0, 4)}`, enabled: !shadowFirst, ...(shadowFirst ? { shadow: true } : {}), sizeMultiplier: p.sizeMultiplier, maxExposureSol: p.budgetSol, ...(p.strategy && p.strategy !== 'balanced' ? { strategy: p.strategy, strategyBy: 'search' as const, strategyAt: Date.now() } : {}) });
      added.push(p.address);
    }
    if (added.length) {
      const clean = sanitizeConfig(next, false);
      trialAndResume(clean);
      await applyChange(() => saveConfig(clean));
      for (const a of added) engine.log(`${byAi ? 'Wallet scout' : 'Market scanner'}: ${shadowFirst ? 'now copying virtually (shadow) until it proves itself' : 'now copying on a trial'} ${a.slice(0, 4)}…${a.slice(-4)}: ${picks.find((p) => p.address === a)!.reason}`, byAi ? 'ai' : 'system');
    }
  }
  // What happened to every wallet checked, in one line (on the Scanner page and in the activity log).
  const pickedSet = new Set(picks.map((p) => p.address));
  const tally = searchSummary(reports.length + quick.length, added.length, unreadable.length, [...quick.map((q) => q.why), ...reports.filter((r) => !added.includes(r.wallet) && !pickedSet.has(r.wallet)).map(rejectReason)]);
  notes.unshift(`This search ${tally}.`);
  if (unreadable.length && rpcUrl().includes('api.mainnet-beta.solana.com')) notes.push('A private Solana RPC (Settings → Connections) lets every wallet be read in full.');
  if (auto) engine.log(`${byAi ? 'Wallet scout' : 'Market scanner'}: wallet search done, ${tally}.`, added.length ? 'system' : 'info');
  const result: ScoutResult = { at, tokens, reports, picks, pickedBy, summary, added, notes };
  rememberScoutMints(tokens.map((t) => t.mint));
  lastScout = result;
  fs.mkdirSync('data', { recursive: true });
  writeAtomic(SCOUT_FILE, JSON.stringify(result));
  broadcast('scout', result);
  return result;
}

// Automatic scouting while the bot is running: by the autopilot, or the scanner's trader finder.
export let lastAutoScoutTry = 0;
export let lastAutoChain: import('./chains').ChainId = 'base'; // so the first search is on Solana

// The spotter runs every few minutes (Settings → Market scanner) while traders are being looked for.
export const spotEveryMs = () => engine.cfg.scanner.spotEveryMin * 60_000;
export const nextWalletSearchAt = () => {
  const sc = engine.cfg.scanner;
  return sc.findTraders ? Math.max((lastScout?.at ?? 0) + sc.traderEveryHours * 3_600_000, lastAutoScoutTry + 30 * 60_000) : null;
};
setInterval(() => {
  const sc = engine.cfg.scanner;
  // Market data only, so it keeps going even while a slow wallet search runs.
  if (!engine.running || !sc.findTraders || spotBusy || Date.now() - lastSpotAt < spotEveryMs()) return;
  spotBusy = true;
  lastSpotAt = Date.now();
  const chains: import('./chains').ChainId[] = ['solana', ...(sc.baseCoins || engine.cfg.wallets.some((w) => chainOf(w) === 'base') ? (['base'] as const) : [])];
  (async () => {
    for (const c of chains) {
      const n = await spotOnce(c).catch(() => 0);
      if (n) engine.log(`Spotter: ${n} trader${n > 1 ? 's' : ''} just caught a move${c === 'base' ? ' on Base' : ''}; the next wallet search checks them (${spottedCount()} noted).`, 'system');
    }
  })().finally(() => {
    spotBusy = false;
    broadcast('scanner', scannerView());
  });
}, 60_000).unref();
setInterval(() => {
  const a = engine.cfg.ai;
  const sc = engine.cfg.scanner;
  if (!engine.running || scoutRunning) return;
  const aiDue = a.enabled && a.manageWallets && a.scoutEveryHours > 0 && Date.now() - (lastScout?.at ?? 0) >= a.scoutEveryHours * 3_600_000;
  const scanDue = sc.findTraders && Date.now() - (lastScout?.at ?? 0) >= sc.traderEveryHours * 3_600_000;
  if (!aiDue && !scanDue) return;
  if (Date.now() - lastAutoScoutTry < 30 * 60_000) return; // a failed search waits half an hour
  lastAutoScoutTry = Date.now();
  // Alternate Solana and Base when Base history can be read (a free Alchemy key).
  const chain: import('./chains').ChainId = alchemyUrl() && lastAutoChain === 'solana' ? 'base' : 'solana';
  try {
    startScout(true, chain);
    lastAutoChain = chain;
    engine.log(aiDue ? `Wallet scout: searching for new wallets to copy${chain === 'base' ? ' on Base' : ''}…` : `Market scanner: looking for traders worth copying${chain === 'base' ? ' on Base' : ''} (${spottedCount(chain)} spotted since the last search)…`, aiDue ? 'ai' : 'system');
  } catch {
    /* already running */
  }
}, 60_000).unref();
