/**
 * Local control panel for the bot.
 *   npm run app      → browser version on http://localhost:4777
 *   desktop app      → Electron imports this module and calls startServer()
 *
 * Security model: the server only listens on 127.0.0.1, and every API request must
 * carry a random per-session token. Other programs and websites can't use the API
 * because they don't have the token.
 */
import http from 'node:http';
import { Connection } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BotEngine } from './engine';
import { isAddress, sanitizeConfig, saveConfig } from './config';
import { backupRpcUrl, failover, onRpcSwitch } from './env';
import { readSecret } from './env';
import { canEncryptKey, encryptPlaintextKey, hasSecret, isHttpsUrl, saveSecret, secretIsEncrypted, jupKey, jupUrl, keyIsEncrypted, makeConnection, parseKeypair, rpcUrl, savePrivateKey, updateEnv } from './env';
import { fetchSwaps, score } from './analyze';
import { earlyBuyers, rankCandidates } from './discover';
import * as markets from './markets';
import { getSolUsd } from './market';
import { experimentPicks, healthVerdict, marketSkipReason, median, walletRecords } from './rules';
import * as ai from './ai';
import { getHolderStats } from './solscan';
import { runBacktest } from './backtest';
import { optimizeExits } from './optimize';
import { applyStrategy, compareStrategies, STRATEGIES, strategyById } from './strategies';
import { tradesCsv } from './csv';
import * as alerts from './alerts';
import { quoteSell } from './jupiter';
import { passesBacktest, passesBasics, pickCandidates, pickTokens, pumpBuyers, rulePicks, suggestStrategy, ScoutReport, ScoutResult } from './scout';

const PORT = Number(process.env.PORT || 4777);
const HOST = '127.0.0.1';
const UI_FILE = process.env.COPYBOT_UI || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
// The only files served besides the page: [path relative to ui/, content type].
const STATIC: Record<string, [string, string]> = {
  '/fonts/press-start-2p.woff2': ['fonts/press-start-2p.woff2', 'font/woff2'],
  '/guides.js': ['guides.js', 'text/javascript; charset=utf-8'],
};

// ---------- display preferences (light/dark). Kept apart from config.json so changing them never restarts the bot ----------
const MODES = ['system', 'light', 'dark'] as const;
type UiPrefs = { mode: (typeof MODES)[number]; setupDone: boolean };
function loadUiPrefs(): UiPrefs {
  // Existing installs (a config already there) skip the first-run setup.
  const setupDefault = fs.existsSync('config.json');
  try {
    const j = JSON.parse(fs.readFileSync('data/ui.json', 'utf8')); // older versions stored a "theme" instead of "mode"
    return { mode: MODES.includes(j.mode) ? j.mode : 'system', setupDone: typeof j.setupDone === 'boolean' ? j.setupDone : setupDefault };
  } catch {
    return { mode: 'system', setupDone: setupDefault };
  }
}
let uiPrefs = loadUiPrefs();
export const TOKEN = crypto.randomBytes(32).toString('base64url');

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https://coin-images.coingecko.com https://assets.geckoterminal.com https://cdn.dexscreener.com; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

// ---------- app updates (desktop app only; the Electron side drives these) ----------
type Updater = { check: () => unknown; install: () => Promise<void> };
const updater = (): Updater | null => (globalThis as any).__copybotUpdater ?? null;
let updateState: unknown = { state: process.env.COPYBOT_DESKTOP ? 'idle' : 'disabled' };

/** Detect that the desktop app was just updated, so the UI can confirm it. */
function detectVersionChange(): { from: string; to: string } | null {
  const current = process.env.COPYBOT_VERSION;
  if (!current) return null;
  const file = 'data/app.json';
  let previous: string | null = null;
  try {
    previous = JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null;
  } catch {
    // Versions before 0.3.1 didn't record themselves; an existing config means this is an update.
    if (fs.existsSync('config.json')) previous = 'an earlier version';
  }
  if (previous === current) return null;
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: current }));
  return previous ? { from: previous, to: current } : null;
}
const justUpdated = detectVersionChange();
export function setUpdateState(s: unknown) {
  updateState = s;
  broadcast('update', s);
}

encryptPlaintextKey(); // desktop app: move any plain-text key into OS-encrypted storage
export const engine = new BotEngine();

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set<http.ServerResponse>();
function broadcast(type: string, data: unknown) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
let statusTimer: NodeJS.Timeout | null = null;
engine.on('log', (e) => broadcast('log', e));
engine.on('trade', (t) => broadcast('trade', t));
engine.on('config', (c) => broadcast('config', c));

// ---------- phone alerts ----------
const alertQueue = new alerts.AlertQueue(async (text) => {
  const errs = await alerts.sendNow(text);
  if (errs.length) console.log('alert not sent:', errs.join('; '));
});
function alert(kind: alerts.AlertKind, text: string) {
  if (!engine.cfg.alerts[kind] || !alerts.alertsConfigured()) return;
  alertQueue.push(`${engine.cfg.mode === 'live' ? '' : '[paper] '}${text}`, kind);
}
const nameOf = (w: string) => engine.cfg.wallets.find((x) => x.address === w)?.label ?? `${w.slice(0, 4)}…${w.slice(-4)}`;
const mintShort = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
engine.on('trade', (t) => {
  if (t.side === 'buy') alert('trades', `🟢 BUY ${mintShort(t.mint)} for ${t.sol.toFixed(3)} SOL, copying ${nameOf(t.source ?? '')}${typeof t.gapPct === 'number' ? ` (${t.gapPct.toFixed(1)}% copy gap)` : ''}\nhttps://dexscreener.com/solana/${t.mint}`);
  else alert('trades', `${(t.pnl ?? 0) >= 0 ? '💰' : '🔻'} SELL ${mintShort(t.mint)} for ${t.sol.toFixed(3)} SOL, ${(t.pnl ?? 0) >= 0 ? '+' : ''}${(t.pnl ?? 0).toFixed(4)} SOL (${t.reason ?? ''})`);
});
engine.on('guard', (msg: string) => alert('guard', `⏸ ${msg}`));
engine.on('log', (e) => {
  if (e.level === 'error') alert('errors', `⚠️ ${e.msg}`);
  else if (e.level === 'warn' && /RPC/.test(e.msg)) alert('errors', `⚠️ ${e.msg}`);
});
ai.onDecision((d) => {
  if (d.kind === 'test' || (d.kind === 'buy' && d.outcomePct !== undefined)) return; // outcome updates aren't news
  const what = d.kind === 'buy' ? `${d.verdict === 'buy' ? 'buy' : 'skip'} ${d.symbol ?? (d.mint ? mintShort(d.mint) : '')}` : d.kind === 'review' ? `positions: ${d.verdict}` : d.kind === 'wallets' ? `wallets: ${d.verdict}` : `wallet scout: ${d.verdict}`;
  alert('autopilot', `🤖 Claude ${what}\n${d.reason}`);
});
ai.onDecision((d) => broadcast('ai', d));
onRpcSwitch(() => setTimeout(() => broadcast('connection', connectionInfo()), 0));
engine.on('status', () => {
  if (statusTimer) return; // coalesce bursts
  statusTimer = setTimeout(() => {
    statusTimer = null;
    broadcast('status', engine.snapshot());
  }, 150);
});

// ---------- background jobs (wallet analysis / discovery), run one at a time ----------
type Job = {
  id: number;
  kind: 'analyze' | 'discover' | 'scout' | 'backtest' | 'optimize' | 'compare' | 'health' | 'quickstart';
  status: 'queued' | 'running' | 'done' | 'error';
  progress: string;
  input: unknown;
  result?: unknown;
  error?: string;
  createdAt: number;
};
const jobs: Job[] = [];
// Finished backtests are kept across restarts (the other jobs are quick to re-run).
const BACKTESTS_FILE = 'data/backtests.json';
try {
  const saved = JSON.parse(fs.readFileSync(BACKTESTS_FILE, 'utf8'));
  if (Array.isArray(saved)) jobs.push(...saved.filter((j) => (j?.kind === 'backtest' || j?.kind === 'optimize' || j?.kind === 'compare') && j.status === 'done').slice(0, 12));
} catch {
  /* none yet */
}
function saveBacktests() {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(BACKTESTS_FILE, JSON.stringify(jobs.filter((j) => (j.kind === 'backtest' || j.kind === 'optimize' || j.kind === 'compare') && j.status === 'done').slice(0, 12)));
}
let jobSeq = jobs.reduce((a, j) => Math.max(a, j.id), 0);
let jobChain: Promise<void> = Promise.resolve();

function addJob(kind: Job['kind'], input: unknown, run: (progress: (p: string) => void) => Promise<unknown>) {
  if (jobs.filter((j) => j.status === 'queued' || j.status === 'running').length >= 5) throw new HttpError(429, 'Too many jobs waiting. Let the current ones finish first.');
  const job: Job = { id: ++jobSeq, kind, status: 'queued', progress: 'Waiting…', input, createdAt: Date.now() };
  jobs.unshift(job);
  // Keep the list short, but never drop a saved backtest just because other jobs ran.
  while (jobs.length > 20) jobs.splice(jobs.map((j) => j.kind === 'backtest' || j.kind === 'optimize' || j.kind === 'compare').lastIndexOf(false), 1);
  const progress = (p: string) => {
    job.progress = p;
    broadcast('job', job);
  };
  broadcast('job', job);
  jobChain = jobChain.then(async () => {
    job.status = 'running';
    progress('Starting…');
    try {
      job.result = await run(progress);
      job.status = 'done';
      if (job.kind === 'backtest' || job.kind === 'optimize' || job.kind === 'compare') saveBacktests();
      progress('Done');
    } catch (e) {
      job.status = 'error';
      job.error = (e as Error).message;
      progress('Failed');
    }
  });
  return job;
}

// ---------- helpers ----------
class HttpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

function readTrades(limit = 500) {
  try {
    const lines = fs.readFileSync('data/trades.jsonl', 'utf8').trim().split('\n');
    return lines.slice(-limit).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    }).reverse();
  } catch {
    return [];
  }
}

function connectionInfo() {
  return {
    rpcUrl: rpcUrl(),
    backupRpcUrl: backupRpcUrl(),
    activeRpc: failover.state.active,
    usingPublicRpc: rpcUrl().includes('api.mainnet-beta.solana.com'),
    jupiterUrl: jupUrl(),
    hasJupiterKey: !!jupKey(),
    hasPrivateKey: !!engine.kp,
    keyEncrypted: keyIsEncrypted(),
    canEncrypt: canEncryptKey(),
    desktop: !!process.env.COPYBOT_DESKTOP,
    keyError: engine.keyError,
    walletAddress: engine.kp?.publicKey.toBase58() ?? null,
    hasDexcheckKey: hasSecret('DEXCHECK_API_KEY'),
    dexcheckEncrypted: secretIsEncrypted('DEXCHECK_API_KEY'),
    hasSolscanKey: hasSecret('SOLSCAN_API_KEY'),
    hasTelegram: hasSecret('TELEGRAM_BOT_TOKEN'),
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || null,
    hasDiscord: hasSecret('DISCORD_WEBHOOK_URL'),
    solscanEncrypted: secretIsEncrypted('SOLSCAN_API_KEY'),
    hasAnthropicKey: hasSecret('ANTHROPIC_API_KEY'),
    anthropicEncrypted: secretIsEncrypted('ANTHROPIC_API_KEY'),
  };
}

// ---------- autopilot: wallet reviews ----------
const WALLET_REVIEW_FILE = 'data/ai-wallet-review.json';
let lastWalletReview = (() => {
  try {
    return Number(JSON.parse(fs.readFileSync(WALLET_REVIEW_FILE, 'utf8')).at) || 0;
  } catch {
    return 0;
  }
})();
let walletReviewBusy = false;

const scoutView = (r: ScoutReport): ai.CandidateView => ({
  address: r.wallet,
  source: 'scout',
  stats: { swaps: r.swaps, days: r.days, tradesPerDay: r.tradesPerDay, closedTokens: r.closedTokens, winRate: r.winRate, realizedPnlSol: r.realizedPnlSol, roiPct: r.roiPct, medianBuySol: r.medianBuySol, medianHoldMin: r.medianHoldMin, earlyOnPumpedTokens: r.earlyOn, caughtRecentPumpOn: r.pumpOn ?? [], topTraderOn: r.topTraderOn, backtestCopyingItWithOurSettings: r.bt ?? null, notes: r.notes },
});

/** Wallets the AI may add: the ones the user analyzed or discovered, plus the latest scout results. */
function aiCandidates(): ai.CandidateView[] {
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

async function runWalletReview(): Promise<{ changes: ai.WalletChange[]; summary: string }> {
  if (walletReviewBusy) throw new HttpError(409, 'Claude is already reviewing your wallets.');
  const cfg = engine.cfg;
  if (!cfg.wallets.length && !aiCandidates().length) throw new HttpError(400, 'Add some wallets, or analyze a few candidates on the Find wallets page first.');
  walletReviewBusy = true;
  lastWalletReview = Date.now();
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(WALLET_REVIEW_FILE, JSON.stringify({ at: lastWalletReview }));
  try {
    const recs = walletRecords(engine.readTrades(), cfg.mode);
    const view: ai.WalletView[] = cfg.wallets.map((w) => ({ address: w.address, label: w.label, enabled: w.enabled, sizeMultiplier: w.sizeMultiplier, budgetSol: w.maxExposureSol, ourRecord: recs[w.address] ?? { trades: 0, closed: 0, wins: 0, pnlSol: 0 } }));
    engine.log('Claude is reviewing your wallets…', 'ai');
    const r = await ai.reviewWallets(cfg, view, aiCandidates());
    if (!r) throw new HttpError(502, ai.aiStatus(cfg).lastError ?? 'Claude did not answer.');
    if (!r.changes.length) {
      engine.log(`Claude: no wallet changes. ${r.summary}`, 'ai');
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
      for (const ch of applied) engine.log(`Claude: ${ch.action} ${ch.address.slice(0, 4)}…${ch.address.slice(-4)}${ch.action === 'pause' ? '' : ` (size ×${ch.sizeMultiplier}${ch.budgetSol ? `, budget ${ch.budgetSol} SOL` : ''})`}: ${ch.reason}`, 'ai');
    }
    return { changes: applied, summary: r.summary };
  } finally {
    walletReviewBusy = false;
  }
}

// ---------- wallet scout ----------
const SCOUT_FILE = 'data/scout.json';
let lastScout: ScoutResult | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(SCOUT_FILE, 'utf8'));
  } catch {
    return null;
  }
})();
let scoutRunning = false;

/** The user's median copy gap (%) in the current mode, once there are 5+ measured trades. */
function measuredCopyGap(): number | null {
  const g = engine.readTrades().filter((t: any) => t.mode === engine.cfg.mode && typeof t.gapPct === 'number').map((t: any) => t.gapPct as number);
  return g.length >= 5 ? Math.max(0, median(g)!) : null;
}

/** What copying one wallet over its fetched history would have made with the user's settings. */
async function quickBacktest(wallet: string, swaps: import('./decode').Swap[], delayPct: number): Promise<import('./scout').ScoutBacktest> {
  const cfg = structuredClone(engine.cfg);
  if (!cfg.wallets.some((w) => w.address === wallet)) cfg.wallets.push({ address: wallet, label: wallet.slice(0, 4), enabled: true, sizeMultiplier: 1, maxExposureSol: 0 });
  const opts = { delayPct, feeSol: 0.0002 };
  const first = runBacktest(swaps, cfg, opts);
  const marks = new Map<string, number | null>();
  for (const o of first.open.slice(0, 8)) {
    const raw = BigInt(Math.max(1, Math.floor(o.tokensRaw)));
    const q = await quoteSell(o.mint, raw, cfg.safety.slippageBps).catch(() => null);
    marks.set(o.mint, q ? Number(q.outAmount) / 1e9 / Number(raw) : null);
  }
  const r = runBacktest(swaps, cfg, opts, marks);
  return { totalSol: r.totalSol, roiPct: r.roiPct, closed: r.closed, wins: r.wins, delayPct };
}

// Tokens scanned by recent searches go to the back of the line next time, so searches vary.
const SCOUT_HISTORY = 'data/scout-history.json';
function recentScoutMints(): Set<string> {
  try {
    const l = JSON.parse(fs.readFileSync(SCOUT_HISTORY, 'utf8'));
    return new Set(Array.isArray(l) ? l.filter((m) => typeof m === 'string') : []);
  } catch {
    return new Set();
  }
}
function rememberScoutMints(mints: string[]) {
  const l = [...mints, ...recentScoutMints()].filter((m, i, a) => a.indexOf(m) === i).slice(0, 18);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(SCOUT_HISTORY, JSON.stringify(l));
}

function startScout(auto: boolean) {
  if (scoutRunning || jobs.some((j) => j.kind === 'scout' && (j.status === 'queued' || j.status === 'running'))) throw new HttpError(409, 'The wallet scout is already running.');
  scoutRunning = true;
  return addJob('scout', { auto }, async (progress) => {
    try {
      return await runScout(progress);
    } finally {
      scoutRunning = false;
    }
  });
}

async function runScout(progress: (p: string) => void): Promise<ScoutResult> {
  const notes: string[] = [];
  const at = Date.now();
  progress('Looking for tokens that are moving: trending, new launches and top volume…');
  const rows = await markets.scoutPools();
  const tokens = pickTokens(rows, at, 6, recentScoutMints());
  if (!tokens.length) throw new Error('No suitable tokens right now (none up 30%+ in 6 or 24 hours with real liquidity, 1 hour to 14 days old). Try again later.');
  const symbols = new Map(tokens.map((t) => [t.mint, t.symbol]));

  // 1. "Caught the pump": recent big buyers now well in profit (every token, fast).
  const pump = new Map<string, string[]>();
  for (const [i, t] of tokens.entries()) {
    progress(`Token ${i + 1}/${tokens.length} (${t.symbol}): finding buyers who caught the move…`);
    const trades = await markets.poolTrades(t.pool, 300).catch(() => []);
    for (const w of pumpBuyers(trades, t.priceUsd, 40).keys()) pump.set(w, [...(pump.get(w) ?? []), t.symbol]);
  }
  // 2. True early buyers, for tokens quiet enough to read back to their launch.
  const conn = makeConnection();
  const perMint = new Map<string, Map<string, number>>();
  const quiet = tokens.filter((t) => t.quiet).slice(0, 3);
  for (const [i, t] of quiet.entries()) {
    progress(`Early buyers ${i + 1}/${quiet.length} (${t.symbol})…`);
    perMint.set(
      t.mint,
      await earlyBuyers(conn, t.mint, 120, 30, () => notes.push(`${t.symbol}: its "early buyers" are the earliest within its last 30,000 transactions, not its very first.`), (m) => progress(`Early buyers ${i + 1}/${quiet.length} (${t.symbol}): ${m}`)),
    );
  }
  const top = new Map<string, string[]>();
  if (hasSecret('DEXCHECK_API_KEY')) {
    progress('Adding DexCheck top traders…');
    for (const t of tokens) {
      const traders = await markets.topTraders(t.pool, '7d').catch(() => []);
      for (const tr of traders.filter((x: any) => (x.profitUsd ?? 0) > 0).slice(0, 10)) top.set(tr.wallet, [...(top.get(tr.wallet) ?? []), t.symbol]);
    }
  }
  const mine = new Set(engine.cfg.wallets.map((w) => w.address));
  const cands = pickCandidates(rankCandidates(perMint), top, symbols, mine, 15, pump);
  if (!cands.length) throw new Error('Found no wallets worth analyzing this time. Try again later.');

  const reports: ScoutReport[] = [];
  const history = new Map<string, import('./decode').Swap[]>();
  for (const [i, c] of cands.entries()) {
    const swaps = await fetchSwaps(conn, c.wallet, 500, (n, t) => {
      if (n % 25 === 0 || n === t) progress(`Checking wallet ${i + 1}/${cands.length}: transaction ${n} of ${t}`);
    }).catch(() => null);
    if (swaps) {
      history.set(c.wallet, swaps);
      reports.push({ ...score(c.wallet, swaps), earlyOn: c.earlyOn, topTraderOn: c.topTraderOn, pumpOn: c.pumpOn });
    }
  }
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
  const autoAdd = cfg.ai.enabled && cfg.ai.manageWallets;
  const free = Math.max(0, cfg.ai.maxWallets - cfg.wallets.filter((w) => w.enabled).length);
  const max = autoAdd ? Math.min(cfg.ai.scoutMaxPicks, free) : cfg.ai.scoutMaxPicks;
  if (autoAdd && !free) notes.push(`You already copy ${cfg.ai.maxWallets} wallets (the autopilot's maximum), so nothing new was added.`);
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
  if (max > 0 && eligible.length && hasSecret('ANTHROPIC_API_KEY')) {
    progress('Claude is choosing…');
    const recs = walletRecords(engine.readTrades(), cfg.mode);
    const current = cfg.wallets.map((w) => ({ address: w.address, label: w.label, enabled: w.enabled, sizeMultiplier: w.sizeMultiplier, budgetSol: w.maxExposureSol, ourRecord: recs[w.address] ?? { trades: 0, closed: 0, wins: 0, pnlSol: 0 } }));
    const r = await ai.pickWallets(cfg, current, eligible.map(scoutView), max);
    if (r) {
      picks = r.picks;
      pickedBy = 'claude';
      summary = r.summary;
    } else notes.push(`Claude wasn't available (${ai.aiStatus(cfg).lastError ?? 'no answer'}), so the picks are rule-based.`);
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
    for (const p of picks) {
      if (next.wallets.some((w) => w.address === p.address) || next.wallets.filter((w) => w.enabled).length >= cfg.ai.maxWallets) continue;
      next.wallets.push({ address: p.address, label: `scout-${p.address.slice(0, 4)}`, enabled: true, sizeMultiplier: p.sizeMultiplier, maxExposureSol: p.budgetSol, ...(p.strategy && p.strategy !== 'balanced' ? { strategy: p.strategy } : {}) });
      added.push(p.address);
    }
    if (added.length) {
      const clean = sanitizeConfig(next, false);
      trialAndResume(clean);
      await applyChange(() => saveConfig(clean));
      for (const a of added) engine.log(`Wallet scout: now copying ${a.slice(0, 4)}…${a.slice(-4)}: ${picks.find((p) => p.address === a)!.reason}`, 'ai');
    }
  }
  const result: ScoutResult = { at, tokens, reports, picks, pickedBy, summary, added, notes };
  rememberScoutMints(tokens.map((t) => t.mint));
  lastScout = result;
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(SCOUT_FILE, JSON.stringify(result));
  broadcast('scout', result);
  return result;
}

// Automatic scouting while the bot is running with the autopilot managing wallets.
setInterval(() => {
  const a = engine.cfg.ai;
  if (!engine.running || !a.enabled || !a.manageWallets || !a.scoutEveryHours || scoutRunning) return;
  if (Date.now() - (lastScout?.at ?? 0) < a.scoutEveryHours * 3_600_000) return;
  try {
    startScout(true);
    engine.log('Wallet scout: searching for new wallets to copy…', 'ai');
  } catch {
    /* already running */
  }
}, 10 * 60_000).unref();

// Automatic wallet reviews while the bot is running.
setInterval(() => {
  const a = engine.cfg.ai;
  if (!engine.running || !a.enabled || !a.manageWallets || walletReviewBusy) return;
  if (Date.now() - lastWalletReview < a.walletReviewHours * 3_600_000) return;
  runWalletReview().catch((e) => engine.log(`Claude wallet review: ${(e as Error).message}`, 'warn'));
}, 10 * 60_000).unref();

// ---------- watchlist ----------
const WATCHLIST = 'data/watchlist.json';
function readWatchlist(): string[] {
  try {
    const l = JSON.parse(fs.readFileSync(WATCHLIST, 'utf8'));
    return Array.isArray(l) ? l.filter(isAddress).slice(0, 30) : [];
  } catch {
    return [];
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new HttpError(413, 'Request too large');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function send(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const addressList = (v: unknown, max: number, what: string): string[] => {
  const list = (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) throw new HttpError(400, `Enter at least one ${what}`);
  if (list.length > max) throw new HttpError(400, `At most ${max} at a time`);
  const bad = list.find((s) => !isAddress(s)) as string | undefined;
  if (bad) throw new HttpError(400, `Not a valid ${what}: ${bad.slice(0, 50)}`);
  return [...new Set(list)];
};

function tokenOk(given: string | undefined | null) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Restart the bot in the background after a settings change, if it was running. */
async function applyChange(change: () => void) {
  const wasRunning = engine.running;
  if (wasRunning) await engine.stop();
  change();
  engine.reload();
  if (wasRunning) engine.start().catch((e) => engine.log(`Could not restart: ${e.message}`, 'error'));
  broadcast('config', engine.cfg);
  broadcast('status', engine.snapshot());
  return wasRunning;
}

/**
 * Wallets new to the list start on trial (quarter size). Wallets turned back on after a pause
 * start counting afresh. Applies to wallets added from the UI, the scout or the autopilot.
 */
function trialAndResume(next: import('./config').Config) {
  const prev = new Map(engine.cfg.wallets.map((w) => [w.address, w]));
  for (const w of next.wallets) {
    const before = prev.get(w.address);
    if (!before) {
      if (next.trial.enabled && w.trialStage === undefined) w.trialStage = 0;
      w.since = Date.now();
    } else if (!before.enabled && w.enabled) {
      w.since = Date.now();
      delete w.pausedReason;
    }
  }
}

// ---------- wallet health check ----------
const HEALTH_FILE = 'data/health.json';
type HealthRow = { address: string; label: string; verdict: import('./rules').HealthVerdict; totalSol: number; roiPct: number | null; closed: number; wins: number; copied: number; unreadable: number; coveredFrom: number | null };
let lastHealth: { at: number; period: { from: number; to: number }; delayPct: number; wallets: HealthRow[] } | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  } catch {
    return null;
  }
})();

// ---------- backtest data (shared by Backtest and "Find my best settings") ----------
type BacktestSpec = { wallets: string[]; delayPct: number; replayExits: boolean; range: { from: number; to: number } | null; txs: number; endAt?: number; strategy: string | null; input: Record<string, unknown> };

function backtestSpec(b: any): BacktestSpec {
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
async function loadBacktestData(spec: BacktestSpec, progress: (p: string) => void, wantCandles: boolean, widestOpen = false) {
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
    ? { ...structuredClone(cfg), buy: { ...cfg.buy, minTargetBuySol: 0 }, exits: { recoverCostAtPct: 0, tp1AtPct: 0, tp1SellPct: 50, tp2AtPct: 0, tp2SellPct: 50, trailingAfterPct: 0, trailingStopPct: 0 }, risk: { ...cfg.risk, stopLossPct: 100, takeProfitPct: 0 } }
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
    const h = await markets.priceHistory(mint, from, to).catch(() => null);
    if (h) prices.set(mint, h);
  }
  // A period that ends now: price what would still be held at today's prices.
  const marks = new Map<string, number | null>();
  if (!spec.endAt) {
    const open = (needCandles.length ? runBacktest(swaps, probeCfg, opts, new Map(), prices) : probe).open.slice(0, 25);
    for (const [i, o] of open.entries()) {
      progress(`Pricing open positions (${i + 1}/${open.length})…`);
      const raw = BigInt(Math.max(1, Math.floor(o.tokensRaw)));
      const q = await quoteSell(o.mint, raw, cfg.safety.slippageBps).catch(() => null);
      marks.set(o.mint, q ? Number(q.outAmount) / 1e9 / Number(raw) : null);
    }
  }
  return { swaps, cfg, opts, prices, marks, stats, truncated, bought: bought.length };
}

// ---------- routes ----------
async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(UI_FILE));
  }
  const asset = req.method === 'GET' ? STATIC[url.pathname] : undefined;
  if (asset) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset[1], 'cache-control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(path.dirname(UI_FILE), asset[0])));
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  // Everything under /api needs the session token. EventSource can't send headers, so
  // the event stream takes it as a query parameter.
  const given = url.pathname === '/api/events' ? url.searchParams.get('token') : (req.headers['x-copybot-token'] as string | undefined);
  if (!tokenOk(given)) return send(res, 401, { error: 'unauthorized' });

  if (route === 'GET /api/events') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clients.delete(res);
      clearInterval(ping);
    });
    return;
  }

  if (route === 'GET /api/trades.csv') {
    const mode = url.searchParams.get('mode');
    const labels = new Map(engine.cfg.wallets.map((w) => [w.address, w.label]));
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/csv; charset=utf-8' });
    return res.end(tradesCsv(readTrades(1e9).reverse().filter((t: any) => mode !== 'paper' && mode !== 'live' ? true : t.mode === mode), labels));
  }

  if (route === 'GET /api/state') {
    return send(res, 200, {
      status: engine.snapshot(),
      config: engine.cfg,
      logs: engine.logs,
      trades: readTrades(),
      connection: connectionInfo(),
      jobs,
      scout: lastScout,
      strategies: STRATEGIES,
      health: lastHealth,
      app: { version: process.env.COPYBOT_VERSION ?? null, update: updateState, justUpdated },
      ui: uiPrefs,
    });
  }

  if (route === 'POST /api/jobs/quickstart') {
    if (engine.cfg.mode !== 'paper') throw new HttpError(400, 'Quick experiments only run in paper mode.');
    if (engine.running) throw new HttpError(409, 'The bot is already running.');
    if (jobs.some((j) => j.kind === 'quickstart' && (j.status === 'queued' || j.status === 'running'))) throw new HttpError(409, 'Already setting up an experiment.');
    const job = addJob('quickstart', {}, async (progress) => {
      progress('Looking at tokens that are moving right now…');
      const tokens = pickTokens(await markets.scoutPools(), Date.now(), 6, new Set());
      if (!tokens.length) throw new Error('No tokens are moving enough right now. Try again in a while, or add wallets yourself.');
      const caught = new Map<string, { tokens: string[]; bestGainPct: number }>();
      for (const [i, t] of tokens.entries()) {
        progress(`Finding traders who caught ${t.symbol}'s move (${i + 1}/${tokens.length})…`);
        const trades = await markets.poolTrades(t.pool, 300).catch(() => []);
        for (const [w, gain] of pumpBuyers(trades, t.priceUsd, 40)) {
          const c = caught.get(w) ?? { tokens: [], bestGainPct: 0 };
          c.tokens.push(t.symbol);
          c.bestGainPct = Math.max(c.bestGainPct, gain);
          caught.set(w, c);
        }
      }
      const picks = experimentPicks(caught, new Set(engine.cfg.wallets.map((w) => w.address)), 3);
      if (!picks.length) throw new Error("Couldn't find active traders right now. Try again in a while, or use Find wallets.");
      if (engine.cfg.mode !== 'paper') throw new Error('Switched to live mode, so the experiment was cancelled.');
      progress('Starting the bot in paper mode…');
      const next = structuredClone(engine.cfg);
      for (const p of picks) next.wallets.push({ address: p.wallet, label: `experiment-${p.wallet.slice(0, 4)}`, enabled: true, sizeMultiplier: 1, maxExposureSol: 0 });
      const clean = sanitizeConfig(next, false);
      trialAndResume(clean);
      await applyChange(() => saveConfig(clean));
      if (!engine.running) await engine.start();
      engine.log(`Paper experiment started: copying ${picks.length} trader${picks.length > 1 ? 's' : ''} who caught recent moves (${picks.map((p) => p.tokens.join('/')).join(', ')}).`, 'system');
      return { added: picks };
    });
    return send(res, 200, job);
  }

  if (route === 'POST /api/paper/reset') {
    if (engine.cfg.mode !== 'paper') throw new HttpError(400, 'Switch to paper mode to reset paper results.');
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
    engine.log(`Paper results reset: the paper wallet is back to ${engine.cfg.paper.startSol} SOL. The old results were kept in the data folder.`, 'system');
    broadcast('trades-reset', {});
    return send(res, 200, { ok: true, status: engine.snapshot() });
  }

  if (route === 'POST /api/start') {
    await engine.start().catch((e) => {
      throw new HttpError(400, e.message);
    });
    return send(res, 200, engine.snapshot());
  }

  if (route === 'POST /api/stop') {
    await engine.stop();
    return send(res, 200, engine.snapshot());
  }

  if (route === 'PUT /api/config') {
    let cfg;
    try {
      cfg = sanitizeConfig(await readBody(req), true);
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message);
    }
    trialAndResume(cfg);
    const restarted = await applyChange(() => saveConfig(cfg));
    return send(res, 200, { ok: true, restarted, config: engine.cfg });
  }

  if (route === 'PUT /api/connection') {
    const b = await readBody(req);
    for (const k of ['rpcUrl', 'backupRpcUrl', 'jupiterKey', 'privateKey', 'dexcheckKey', 'anthropicKey', 'solscanKey']) {
      if (b[k] !== undefined && (typeof b[k] !== 'string' || /[\u0000-\u001f\u007f]/.test(b[k].trim()))) throw new HttpError(400, `Invalid ${k}`);
    }
    const env: Record<string, string> = {};
    if (typeof b.rpcUrl === 'string' && b.rpcUrl.trim()) {
      if (!isHttpsUrl(b.rpcUrl.trim())) throw new HttpError(400, 'RPC URL must be a valid https:// address');
      env.RPC_URL = b.rpcUrl.trim();
      env.WS_URL = '';
    }
    if (typeof b.backupRpcUrl === 'string') {
      const u = b.backupRpcUrl.trim();
      if (u && !isHttpsUrl(u)) throw new HttpError(400, 'Backup RPC URL must be a valid https:// address');
      if (u && u === (env.RPC_URL ?? rpcUrl())) throw new HttpError(400, 'The backup RPC should be a different one from your main RPC');
      env.RPC_URL_BACKUP = u;
    }
    if (typeof b.jupiterKey === 'string') env.JUPITER_API_KEY = b.jupiterKey.trim();
    let newKey: string | null = null;
    if (typeof b.privateKey === 'string') {
      newKey = b.privateKey.trim();
      if (newKey) {
        try {
          parseKeypair(newKey);
        } catch {
          throw new HttpError(400, 'That private key is not valid (expected base58 or a [..] byte array).');
        }
      }
    }
    try {
      // Data-source keys don't affect trading, so saving one never restarts the bot.
      if (typeof b.dexcheckKey === 'string') saveSecret('DEXCHECK_API_KEY', b.dexcheckKey);
      if (typeof b.solscanKey === 'string') saveSecret('SOLSCAN_API_KEY', b.solscanKey);
      if (typeof b.anthropicKey === 'string') {
        if (b.anthropicKey.trim() && !/^sk-ant-[\w-]{20,}$/.test(b.anthropicKey.trim())) throw new Error('That doesn’t look like an Anthropic API key (it starts with sk-ant-).');
        saveSecret('ANTHROPIC_API_KEY', b.anthropicKey);
      }
      if (Object.keys(env).length || newKey !== null) {
        await applyChange(() => {
          if (Object.keys(env).length) updateEnv(env);
          if (newKey !== null) savePrivateKey(newKey);
        });
      }
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    await engine.refreshBalance();
    return send(res, 200, connectionInfo());
  }

  if (route === 'POST /api/connection/test') {
    try {
      const t = Date.now();
      const slot = await makeConnection().getSlot();
      const rpcMs = Date.now() - t;
      const t2 = Date.now();
      const q = await fetch(`${jupUrl()}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=50`, {
        headers: jupKey() ? { 'x-api-key': jupKey() } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const jupMs = Date.now() - t2;
      const j = q.ok ? ((await q.json()) as { outAmount: string }) : null;
      let backup: { ok: boolean; ms?: number; error?: string } | null = null;
      const bu = backupRpcUrl();
      if (bu) {
        const t3 = Date.now();
        backup = await new Connection(bu, { commitment: 'confirmed', disableRetryOnRateLimit: true }).getSlot().then(() => ({ ok: true, ms: Date.now() - t3 }), (e) => ({ ok: false, error: (e as Error).message.slice(0, 120) }));
      }
      let solscan: { ok: boolean; error?: string } | null = null;
      if (hasSecret('SOLSCAN_API_KEY')) {
        // BONK: an established token with many holders.
        solscan = await getHolderStats('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', null).then(() => ({ ok: true }), (e) => ({ ok: false, error: (e as Error).message.slice(0, 160) }));
      }
      return send(res, 200, { ok: true, slot, rpcMs, jupiterOk: !!j, jupMs, solPrice: j ? Number(j.outAmount) / 1e6 / 0.1 : null, solscan, backup });
    } catch (e) {
      return send(res, 200, { ok: false, error: (e as Error).message.slice(0, 200) });
    }
  }

  if (route === 'POST /api/sell') {
    const b = await readBody(req);
    if (!isAddress(b.mint) || !engine.state.positions[b.mint]) throw new HttpError(400, 'No open position for that token');
    const fraction = Math.min(1, Math.max(0.01, Number(b.fraction) || 1));
    if (engine.cfg.mode === 'live' && !engine.kp) throw new HttpError(400, 'No trading wallet configured');
    await engine.manualSell(b.mint, fraction);
    return send(res, 200, engine.snapshot());
  }

  // ---------- Markets hub ----------
  if (url.pathname.startsWith('/api/markets/')) {
    const q = url.searchParams;
    const reply = async (fn: () => Promise<unknown>) => {
      try {
        return send(res, 200, { data: await fn() });
      } catch (e: any) {
        return send(res, e.needsKey ? 200 : 502, { error: e.message ?? 'Market data is unavailable right now.', needsKey: !!e.needsKey });
      }
    };
    switch (route) {
      case 'GET /api/markets/overview':
        return reply(() => markets.overview());
      case 'GET /api/markets/pools': {
        const kind = q.get('kind') === 'new' ? 'new' : 'trending';
        return reply(() => markets.pools(kind));
      }
      case 'GET /api/markets/token': {
        const mint = q.get('mint');
        if (!isAddress(mint)) throw new HttpError(400, 'Not a valid token address');
        return reply(async () => {
          const t = await markets.token(mint);
          if (!t) return null;
          // Would Copybot's own token filters let it buy this right now?
          const solUsd = await getSolUsd().catch(() => null);
          const verdict = marketSkipReason(
            { liquidityUsd: t.totalLiquidityUsd, marketCapUsd: t.marketCapUsd, createdAt: t.oldestPoolAt },
            engine.cfg.filters,
            solUsd ? engine.cfg.buy.fixedSol * solUsd : null,
            Date.now(),
          );
          return { ...t, filterVerdict: verdict, watched: readWatchlist().includes(mint) };
        });
      }
      case 'GET /api/markets/chart': {
        const pool = q.get('pool'), tf = q.get('tf') ?? '1h';
        if (!isAddress(pool) || !markets.isTimeframe(tf)) throw new HttpError(400, 'Invalid chart request');
        return reply(() => markets.chart(pool, tf));
      }
      case 'GET /api/markets/search':
        return reply(() => markets.search(String(q.get('q') ?? '')));
      case 'GET /api/markets/news':
        return reply(() => markets.news());
      case 'GET /api/markets/whales':
        return reply(() => markets.whales(Math.min(1e7, Math.max(1000, Number(q.get('min')) || 10_000))));
      case 'GET /api/markets/top-traders': {
        const pool = q.get('pool'), duration = q.get('duration') ?? '7d';
        if (!isAddress(pool) || !(markets.DURATIONS as readonly string[]).includes(duration)) throw new HttpError(400, 'Invalid request');
        return reply(() => markets.topTraders(pool, duration as (typeof markets.DURATIONS)[number]));
      }
      case 'GET /api/markets/watchlist':
        return reply(() => markets.tokens(readWatchlist()));
      case 'PUT /api/markets/watchlist': {
        const b = await readBody(req);
        if (!isAddress(b.mint)) throw new HttpError(400, 'Not a valid token address');
        const list = readWatchlist().filter((m) => m !== b.mint);
        if (b.watch) list.unshift(b.mint);
        fs.mkdirSync('data', { recursive: true });
        fs.writeFileSync(WATCHLIST, JSON.stringify(list.slice(0, 30)));
        return send(res, 200, { watched: !!b.watch });
      }
    }
  }

  if (route === 'PUT /api/ui') {
    const b = await readBody(req);
    if (b.mode !== undefined && !MODES.includes(b.mode)) throw new HttpError(400, 'Unknown appearance');
    if (b.setupDone !== undefined && typeof b.setupDone !== 'boolean') throw new HttpError(400, 'Invalid setupDone');
    uiPrefs = { mode: b.mode ?? uiPrefs.mode, setupDone: b.setupDone ?? uiPrefs.setupDone };
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync('data/ui.json', JSON.stringify(uiPrefs));
    broadcast('ui', uiPrefs);
    return send(res, 200, uiPrefs);
  }

  if (route === 'POST /api/update/check') {
    if (!updater()) throw new HttpError(400, 'Updates are only available in the desktop app.');
    updater()!.check();
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/update/install') {
    if (!updater()) throw new HttpError(400, 'Updates are only available in the desktop app.');
    try {
      await updater()!.install();
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/ai') {
    return send(res, 200, { ...ai.aiStatus(engine.cfg), lastWalletReview, walletReviewBusy, reviewBusy: engine.aiBusy, candidates: aiCandidates().length });
  }

  if (route === 'POST /api/ai/test') {
    return send(res, 200, await ai.testAi(engine.cfg));
  }

  if (route === 'POST /api/ai/review-positions') {
    try {
      await engine.reviewPositionsNow();
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/ai/review-wallets') {
    return send(res, 200, await runWalletReview());
  }

  if (route === 'PUT /api/alerts') {
    const b = await readBody(req);
    for (const k of ['telegramToken', 'telegramChatId', 'discordWebhook']) {
      if (b[k] !== undefined && (typeof b[k] !== 'string' || /[\u0000-\u001f\u007f]/.test(b[k].trim()))) throw new HttpError(400, `Invalid ${k}`);
    }
    const tok = typeof b.telegramToken === 'string' ? b.telegramToken.trim() : undefined;
    const chat = typeof b.telegramChatId === 'string' ? b.telegramChatId.trim() : undefined;
    const hook = typeof b.discordWebhook === 'string' ? b.discordWebhook.trim() : undefined;
    if (tok && !alerts.isTelegramToken(tok)) throw new HttpError(400, 'That doesn’t look like a Telegram bot token (it looks like 123456789:ABC…, from @BotFather).');
    if (chat && !alerts.isChatId(chat)) throw new HttpError(400, 'The Telegram chat ID should be a number (press Find my chat ID).');
    if (hook && !alerts.isDiscordWebhook(hook)) throw new HttpError(400, 'That isn’t a Discord webhook link (it starts with https://discord.com/api/webhooks/).');
    if (tok !== undefined) saveSecret('TELEGRAM_BOT_TOKEN', tok);
    if (chat !== undefined) updateEnv({ TELEGRAM_CHAT_ID: chat });
    if (hook !== undefined) saveSecret('DISCORD_WEBHOOK_URL', hook);
    return send(res, 200, connectionInfo());
  }

  if (route === 'POST /api/alerts/detect-telegram') {
    const b = await readBody(req);
    let token = typeof b.telegramToken === 'string' && b.telegramToken.trim() ? b.telegramToken.trim() : null;
    if (!token) token = readSecret('TELEGRAM_BOT_TOKEN', 'Telegram bot token');
    if (!token || !alerts.isTelegramToken(token)) throw new HttpError(400, 'Paste your Telegram bot token first.');
    const found = await alerts.detectTelegramChat(token).catch((e) => {
      throw new HttpError(400, (e as Error).message);
    });
    if (!found) throw new HttpError(404, 'No messages yet. Open your bot in Telegram, press Start (or send it any message), then try again.');
    return send(res, 200, found);
  }

  if (route === 'POST /api/alerts/test') {
    if (!alerts.alertsConfigured()) throw new HttpError(400, 'Set up Telegram or Discord first, then save.');
    const errs = await alerts.sendNow('✅ Copybot alerts are working. You’ll get trades, problems and autopilot actions here.');
    if (errs.length) throw new HttpError(502, errs.join(' · '));
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/guard/resume') {
    engine.resumeBuying();
    return send(res, 200, engine.snapshot());
  }

  if (route === 'POST /api/positions/refresh') {
    await engine.valuePositions();
    return send(res, 200, engine.snapshot());
  }

  if (route === 'POST /api/jobs/analyze') {
    const b = await readBody(req);
    const wallets = addressList(b.wallets, 20, 'wallet address');
    const txs = Math.min(2000, Math.max(50, Number(b.txs) || 300));
    const job = addJob('analyze', { wallets, txs }, async (progress) => {
      const conn = makeConnection();
      const reports = [];
      for (const [i, w] of wallets.entries()) {
        const swaps = await fetchSwaps(conn, w, txs, (n, t) => {
          if (n % 10 === 0 || n === t) progress(`Wallet ${i + 1}/${wallets.length}: reading transaction ${n} of ${t}`);
        });
        reports.push(score(w, swaps));
      }
      return reports.sort((a, b) => b.realizedPnlSol - a.realizedPnlSol);
    });
    return send(res, 200, job);
  }

  if (route === 'POST /api/jobs/backtest') {
    const spec = backtestSpec(await readBody(req));
    const job = addJob('backtest', spec.input, async (progress) => {
      const d = await loadBacktestData(spec, progress, spec.replayExits);
      return {
        ...runBacktest(d.swaps, d.cfg, d.opts, d.marks, d.prices),
        unreadable: d.stats.failed,
        read: d.stats.read,
        period: spec.range ? { from: spec.range.from, to: spec.range.to, valuedAtEnd: !!d.opts.endAt } : null,
        truncated: d.truncated,
        settings: { delayPct: spec.delayPct, txs: spec.range ? null : spec.txs, sizing: d.cfg.buy.sizing, fixedSol: d.cfg.buy.fixedSol, percentOfTarget: d.cfg.buy.percentOfTarget, copySells: d.cfg.sell.copySells },
      };
    });
    return send(res, 200, job);
  }

  if (route === 'POST /api/jobs/optimize') {
    const spec = backtestSpec(await readBody(req));
    const job = addJob('optimize', spec.input, async (progress) => {
      const d = await loadBacktestData(spec, progress, true, true);
      progress('Comparing exit settings…');
      const o = optimizeExits(d.swaps, d.cfg, d.opts, d.marks, d.prices);
      return { ...o, unreadable: d.stats.failed, read: d.stats.read, period: spec.range, truncated: d.truncated, priced: { tokens: d.bought, withPrices: d.prices.size }, delayPct: spec.delayPct };
    });
    return send(res, 200, job);
  }

  if (route === 'POST /api/strategy') {
    const s = strategyById((await readBody(req)).id);
    if (!s) throw new HttpError(400, 'Unknown strategy');
    const next = applyStrategy(engine.cfg, s);
    next.strategy = s.id;
    let clean;
    try {
      clean = sanitizeConfig(next, true);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const restarted = await applyChange(() => saveConfig(clean));
    engine.log(`Strategy changed to ${s.name}.`, 'system');
    return send(res, 200, { ok: true, restarted, config: engine.cfg });
  }

  if (route === 'POST /api/jobs/health') {
    const b = await readBody(req);
    const wallets = engine.cfg.wallets.slice(0, 15);
    if (!wallets.length) throw new HttpError(400, 'Add wallets to copy first.');
    if (jobs.some((j) => j.kind === 'health' && (j.status === 'queued' || j.status === 'running'))) throw new HttpError(409, 'A wallet check is already running.');
    const delayPct = Number.isFinite(Number(b.delayPct)) ? Math.min(50, Math.max(0, Number(b.delayPct))) : measuredCopyGap() ?? 5;
    const base = backtestSpec({ wallets: [wallets[0].address], from: b.from ?? Date.now() - 7 * 86_400_000, to: b.to ?? Date.now(), delayPct });
    const job = addJob('health', { wallets: wallets.map((w) => w.address), from: base.range!.from, to: base.range!.to, delayPct }, async (progress) => {
      const rows: HealthRow[] = [];
      for (const [i, w] of wallets.entries()) {
        // A quick check: the latest 1,500 transactions in the period are plenty to judge a wallet.
        const spec = { ...base, wallets: [w.address], txs: 1500, input: {} };
        const d = await loadBacktestData(spec, (p) => progress(`Wallet ${i + 1}/${wallets.length} (${w.label}): ${p.replace(/^Wallet 1\/1: /, '')}`), true);
        // The wallet's own settings, as it trades today (its strategy, exits and size).
        d.cfg.wallets = d.cfg.wallets.map((x) => (x.address === w.address ? { ...x, enabled: true } : x));
        const r = runBacktest(d.swaps, d.cfg, d.opts, d.marks, d.prices);
        const copied = r.trades.filter((t) => t.side === 'buy').length;
        rows.push({ address: w.address, label: w.label, verdict: healthVerdict({ copied, closed: r.closed, totalSol: r.totalSol, read: d.stats.read, unreadable: d.stats.failed }), totalSol: r.totalSol, roiPct: r.roiPct, closed: r.closed, wins: r.wins, copied, unreadable: d.stats.failed, coveredFrom: d.truncated[0]?.oldestMs ?? null });
      }
      lastHealth = { at: Date.now(), period: base.range!, delayPct, wallets: rows };
      fs.mkdirSync('data', { recursive: true });
      fs.writeFileSync(HEALTH_FILE, JSON.stringify(lastHealth));
      broadcast('health', lastHealth);
      return lastHealth;
    });
    return send(res, 200, job);
  }

  if (route === 'POST /api/jobs/compare') {
    const spec = backtestSpec({ ...(await readBody(req)), strategy: null });
    const job = addJob('compare', spec.input, async (progress) => {
      const d = await loadBacktestData(spec, progress, true, true);
      progress('Comparing strategies…');
      const c = compareStrategies(d.swaps, d.cfg, d.opts, d.marks, d.prices);
      return { ...c, unreadable: d.stats.failed, read: d.stats.read, period: spec.range, truncated: d.truncated, priced: { tokens: d.bought, withPrices: d.prices.size }, delayPct: spec.delayPct };
    });
    return send(res, 200, job);
  }

  if (route === 'POST /api/apply-exits') {
    const b = await readBody(req);
    const job = jobs.find((j) => j.id === Number(b.jobId) && j.kind === 'optimize' && j.status === 'done');
    if (!job) throw new HttpError(404, 'That comparison is no longer available. Run it again.');
    const pick = (job.result as any).results.find((r: any) => r.setup.id === b.setupId);
    if (!pick) throw new HttpError(400, 'Unknown setting');
    const next = structuredClone(engine.cfg);
    next.risk.stopLossPct = pick.setup.stopLossPct;
    next.risk.takeProfitPct = pick.setup.takeProfitPct;
    next.exits = { ...pick.setup.exits };
    const clean = sanitizeConfig(next, true);
    const restarted = await applyChange(() => saveConfig(clean));
    engine.log(`Exit settings changed to: ${pick.setup.name}`, 'system');
    return send(res, 200, { ok: true, restarted, config: engine.cfg });
  }

  if (route === 'POST /api/jobs/scout') {
    return send(res, 200, startScout(false));
  }

  if (route === 'POST /api/jobs/discover') {
    const b = await readBody(req);
    const mints = addressList(b.mints, 10, 'token address');
    const early = Math.min(500, Math.max(20, Number(b.early) || 150));
    const job = addJob('discover', { mints }, async (progress) => {
      const conn = makeConnection();
      const perMint = new Map<string, Map<string, number>>();
      const warnings: string[] = [];
      for (const [i, m] of mints.entries()) {
        progress(`Token ${i + 1}/${mints.length}: scanning early buyers…`);
        perMint.set(m, await earlyBuyers(conn, m, early, 10, (w) => warnings.push(`${m.slice(0, 6)}…: ${w.replace(/^⚠\s*/, '')}`)));
      }
      return { tokens: mints.length, candidates: rankCandidates(perMint).slice(0, 40), warnings };
    });
    return send(res, 200, job);
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  // Only answer to localhost names (blocks DNS-rebinding attacks from websites).
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (host !== 'localhost' && host !== '127.0.0.1') {
    res.writeHead(403);
    return res.end();
  }
  try {
    await handle(req, res);
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof HttpError) send(res, e.code, { error: e.message });
    else {
      engine.log(`Internal error: ${(e as Error).message}`, 'error');
      send(res, 500, { error: 'Something went wrong. See the activity log.' });
    }
  }
});

/** Start the server. port 0 = any free port. Resolves with the actual port. */
export function startServer(port = PORT, openBrowser = true): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      const actual = (server.address() as { port: number }).port;
      const url = `http://localhost:${actual}/?t=${TOKEN}`;
      if (!process.env.COPYBOT_DESKTOP) console.log(`\n  Copybot is running. If the browser didn't open, go to:\n  ${url}\n  (keep this window open; press Ctrl+C to quit)\n`);
      if (openBrowser) {
        const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
        exec(cmd, () => {});
      }
      resolve(actual);
    });
  });
}

// `npm run app` → start and open the browser. (The desktop app calls startServer itself.)
if (!process.env.COPYBOT_DESKTOP) {
  startServer(PORT, !process.env.NO_OPEN);
  process.on('SIGINT', async () => {
    await engine.stop();
    process.exit(0);
  });
}
