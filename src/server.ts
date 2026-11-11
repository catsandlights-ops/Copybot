import { writeAtomic } from './util';
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
import { isAddress, ORDER_SOURCE, sanitizeConfig, saveConfig, SCANNER_SOURCE } from './config';
import { coinSignals, entryRulesFor, exitVariants, replayExit, replaySignals, RULES, signalStats, type CoinSignal, type ExitReplay, type ScanExits } from './scanner';
import * as remote from './remote';
import QRCode from 'qrcode';
import { profitReport, taxCsv, taxRows, taxSummary, type Period } from './report';
import { describeOrder, makeOrder } from './orders';
import { chainOf } from './chains';
import { buildBackup, checkBackup, restoreBackup } from './backup';
import { liveChecklist, overallVerdict, sourceReport, plainSkip } from './readiness';
import { runChecks, summary as statusSummary, type Check, type CheckResult } from './status';
import { baseRpc } from './chains/base';
import { alchemyUrl, NEEDS_ALCHEMY } from './chains/base-history';
import { getChain as getChainAdapter, isChainId as isChainIdFn } from './chains';
import { getQuote } from './jupiter';
import { downsample, pushPoint, runningTotal, since, type Pt } from './series';
import { exitConfigFor } from './config';
import { PublicKey } from '@solana/web3.js';
import { backupRpcUrl, failover, onRpcSwitch } from './env';
import { readSecret } from './env';
import { canEncryptKey, encryptPlaintextKey, hasSecret, isHttpsUrl, saveSecret, secretIsEncrypted, jupKey, jupUrl, keyIsEncrypted, makeConnection, parseKeypair, rpcUrl, savePrivateKey, updateEnv } from './env';
import { fetchSwaps, score } from './analyze';
import { earlyBuyers, rankCandidates } from './discover';
import * as markets from './markets';
import { getSolUsd } from './market';
import { experimentPicks, healthVerdict, marketSkipReason, median, walletExposureSol, walletRecords } from './rules';
import * as ai from './ai';
import { getHolderStats } from './solscan';
import { runBacktest } from './backtest';
import { optimizeExits } from './optimize';
import { applyStrategy, compareStrategies, STRATEGIES, strategyById, pickWalletStrategy } from './strategies';
import { tradesCsv } from './csv';
import * as alerts from './alerts';
import { quoteSell } from './jupiter';
import { bucketStats, LEARN, learnLessons, updateLessons, type Lesson, type Outcome, type Retired } from './learn';
import { readTradeLog } from './tradelog';
import { restartShadow, SHADOW, shadowStats, shadowVerdict } from './shadow';
import { addSpotted, forgetSpotted, mergeCaught, spottedFor, type Spotted } from './spotter';
import { earlyVerdict, prescreen, readEnough, rejectReason, searchSummary } from './scout';
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
  writeAtomic(file, JSON.stringify({ version: current }));
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
  kind: 'analyze' | 'discover' | 'scout' | 'backtest' | 'optimize' | 'compare' | 'health' | 'quickstart' | 'scannertest';
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
  return readTradeLog().slice(-limit).reverse();
}

function connectionInfo() {
  return {
    rpcUrl: rpcUrl(),
    backupRpcUrl: backupRpcUrl(),
    baseRpcUrl: process.env.BASE_RPC_URL?.trim() || '',
    activeRpc: failover.state.active,
    usingPublicRpc: rpcUrl().includes('api.mainnet-beta.solana.com'),
    jupiterUrl: jupUrl(),
    hasJupiterKey: !!jupKey(),
    hasPrivateKey: !!engine.kp,
    hasBaseKey: hasSecret('BASE_PRIVATE_KEY'),
    baseKeyEncrypted: secretIsEncrypted('BASE_PRIVATE_KEY'),
    baseAddress: getChainAdapter('base').liveOwner?.() ?? null,
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
  writeAtomic(WALLET_REVIEW_FILE, JSON.stringify({ at: lastWalletReview }));
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
    marks.set(o.mint, await solPerUnit(o.mint, raw, cfg.safety.slippageBps));
  }
  const r = runBacktest(swaps, cfg, opts, marks);
  return { totalSol: r.totalSol, roiPct: r.roiPct, closed: r.closed, wins: r.wins, delayPct };
}

// Tokens scanned by recent searches go to the back of the line next time, so searches vary.
const SCOUT_HISTORY = 'data/scout-history.json';

// ---------- the spotter: traders who just caught a move, noted between full wallet searches ----------
const SPOT_FILE = 'data/spotted.json';
let spotPool: Spotted[] = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(SPOT_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
})();
const saveSpot = () => {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(SPOT_FILE + '.tmp', JSON.stringify(spotPool));
  fs.renameSync(SPOT_FILE + '.tmp', SPOT_FILE);
};
let lastSpotAt = 0;
let spotBusy = false;
const spotRecent = new Map<string, number>(); // pool -> when last spotted (rotate through coins)
/** One spotting round on a chain: what's moving now, and who bought it well (market data only, a few requests). */
async function spotOnce(chain: import('./chains').ChainId): Promise<number> {
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
const spottedCount = (chain?: import('./chains').ChainId) => spotPool.filter((s) => !chain || s.chain === chain).length;
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
  writeAtomic(SCOUT_HISTORY, JSON.stringify(l));
}

function startScout(auto: boolean, chain: import('./chains').ChainId = 'solana') {
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

async function runScout(progress: (p: string) => void, auto = false, chain: import('./chains').ChainId = 'solana'): Promise<ScoutResult> {
  const notes: string[] = [];
  const at = Date.now();
  const onBase = chain === 'base';
  progress(`Looking for coins that are moving${onBase ? ' on Base' : ''}: trending, new launches, top volume and older coins…`);
  const rows = await markets.scoutPools(chain);
  if (onBase) notes.push(`Base search: traders who caught recent moves (early-buyer and DexCheck searches are Solana-only).${engine.cfg.mode === 'live' && !engine.cfg.execution.baseLive ? ' In live mode, Base wallets are only copied once Live trading on Base is on (Settings → Trading wallet).' : ''}`);
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
  const quiet = onBase ? [] : tokens.filter((t) => t.quiet).slice(0, 3);
  for (const [i, t] of quiet.entries()) {
    progress(`Early buyers ${i + 1}/${quiet.length} (${t.symbol})…`);
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
let lastAutoScoutTry = 0;
let lastAutoChain: import('./chains').ChainId = 'base'; // so the first search is on Solana

// The spotter runs every few minutes (Settings → Market scanner) while traders are being looked for.
const spotEveryMs = () => engine.cfg.scanner.spotEveryMin * 60_000;
const nextWalletSearchAt = () => {
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

// ---------- market scanner: coins to trade ----------
type ScanState = { at: number; signals: CoinSignal[]; error: string | null; bought: { mint: string; symbol: string; at: number }[] };
let lastScan: ScanState = { at: 0, signals: [], error: null, bought: [] };
const scanTried = new Map<string, number>(); // mint -> when the scanner last tried it (6 h cooldown)
let scanBusy = false;

// Every signal is written down and checked later against real prices: "is the scanner any good?"
type SignalRec = { chain?: import('./chains').ChainId; mint: string; symbol: string; kind: 'new' | 'old'; at: number; priceUsd: number; why: string; bought: boolean; skipped?: string; exits: ScanExits; outcome?: ExitReplay; checks?: number };
const SIGNALS_FILE = 'data/signals.json';
let signalLog: SignalRec[] = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
})();
const saveSignals = () => {
  signalLog = signalLog.slice(-1000);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(SIGNALS_FILE + '.tmp', JSON.stringify(signalLog));
  fs.renameSync(SIGNALS_FILE + '.tmp', SIGNALS_FILE);
};
const scanExits = (): ScanExits => {
  const { stopLossPct, takeProfitPct, trailingAfterPct, trailingStopPct, maxHoldHours } = engine.cfg.scanner;
  return { stopLossPct, takeProfitPct, trailingAfterPct, trailingStopPct, maxHoldHours, lockAtPct: engine.cfg.exits.lockAtPct, lockFloorPct: engine.cfg.exits.lockFloorPct };
};
function noteSignal(s: CoinSignal, now: number) {
  // One entry per coin per 6 hours, like the scanner's own cooldown.
  if (!s.priceUsd || signalLog.some((r) => r.mint === s.mint && now - r.at < 6 * 3_600_000)) return null;
  const rec: SignalRec = { chain: s.chain ?? 'solana', mint: s.mint, symbol: s.symbol, kind: s.kind, at: now, priceUsd: s.priceUsd, why: s.why, bought: false, exits: scanExits() };
  signalLog.push(rec);
  return rec;
}

/** Check how past signals did: replay their exits on the price since. A few per round (rate limits). */
let checkingSignals = false;
async function checkSignals() {
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

function signalProof() {
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
const coinListAge = () => Math.max(20_000, engine.cfg.scanner.coinsEverySec * 1000 - 5_000);
let lastScanStart = 0;
async function scanCoins() {
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
const SCANTEST_FILE = 'data/scanner-test.json';
type ScanTestRow = { entry: 'normal' | 'strict' | 'loose'; exitId: string; name: string; exits: ScanExits; stats: ReturnType<typeof signalStats> };
type ScanTest = { at: number; days: number; coins: { symbol: string; kind: 'new' | 'old'; signals: number }[]; rows: ScanTestRow[]; trades: { symbol: string; kind: string; at: number; up1hPct: number; result: ExitReplay }[]; skippedCoins: number };
let lastScannerTest: ScanTest | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(SCANTEST_FILE, 'utf8'));
  } catch {
    return null;
  }
})();
const ENTRY_NAMES = { normal: 'Your rules', strict: 'Pickier rules', loose: 'Looser rules' } as const;

function scannerTestSummary(t: ScanTest) {
  const ranked = [...t.rows].sort((a, b) => b.stats.totalSol - a.stats.totalSol);
  const current = t.rows.find((r) => r.entry === 'normal' && r.exitId === 'current')!;
  const best = ranked[0];
  const verdict = current.stats.signals < 10 ? 'few' : best.stats.totalSol <= 0 ? 'all-lose' : current.stats.totalSol > 0 ? (best === current ? 'current-best' : 'works') : 'current-loses';
  return { at: t.at, days: t.days, coins: t.coins.length, coinsWithSignals: t.coins.filter((c) => c.signals).length, skippedCoins: t.skippedCoins, current, best, verdict, rows: ranked.map((r) => ({ ...r, entryName: ENTRY_NAMES[r.entry] })), trades: t.trades.slice(0, 60) };
}

async function runScannerTest(days: number, progress: (p: string) => void): Promise<ScanTest> {
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

function scannerView() {
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

// ---------- watchlist ----------
/** A Solana or Base token address. */
const isTokenAddress = (a: unknown): a is string => isAddress(a) || (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a));
const WATCHLIST = 'data/watchlist.json';
function readWatchlist(): string[] {
  try {
    const l = JSON.parse(fs.readFileSync(WATCHLIST, 'utf8'));
    return Array.isArray(l) ? l.filter(isTokenAddress).slice(0, 30) : [];
  } catch {
    return [];
  }
}

async function readBody(req: http.IncomingMessage, limit = 200_000): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, 'Request too large');
  }
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  // Every endpoint takes an object: "null", a list or a bare value is refused here, not deep inside.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body;
}

function send(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const addressList = (v: unknown, max: number, what: string): string[] => {
  // Wallets may be Solana or Base (0x…, lowercased); tokens for "discover" are Solana only.
  const evm = what === 'wallet address';
  const list = (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean).map((s) => (evm && /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : s));
  if (!list.length) throw new HttpError(400, `Enter at least one ${what}`);
  if (list.length > max) throw new HttpError(400, `At most ${max} at a time`);
  const bad = list.find((s) => !isAddress(s) && !(evm && /^0x[0-9a-f]{40}$/.test(s))) as string | undefined;
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
  // The scanner's losing streak counts afresh when it's turned back on.
  if (next.scanner.tradeCoins && !engine.cfg.scanner.tradeCoins) engine.scannerSince = Date.now();
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
async function resetPaper() {
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
}

// ---------- learning: lessons from your own results, and exits re-tuned as markets change ----------
type JournalEntry = { at: number; kind: 'lesson' | 'retired' | 'exits' | 'strategy' | 'undo'; text: string; setup?: string; undo?: { stopLossPct: number; takeProfitPct: number; exits: import('./config').Config['exits'] }; undoStrategy?: { wallet: string; strategy: string | null } };
type Learning = { lessons: Lesson[]; retired: Retired[]; journal: JournalEntry[]; lastAt: number; vetoed?: { setup: string; until: number }[] };
const learnFile = (mode: string) => `data/learning-${mode}.json`;
function loadLearning(mode: string): Learning {
  try {
    const j = JSON.parse(fs.readFileSync(learnFile(mode), 'utf8'));
    return { lessons: j.lessons ?? [], retired: j.retired ?? [], journal: j.journal ?? [], lastAt: j.lastAt ?? 0, vetoed: j.vetoed ?? [] };
  } catch {
    return { lessons: [], retired: [], journal: [], lastAt: 0 };
  }
}
let learning = loadLearning(engine.cfg.mode);
let learningMode = engine.cfg.mode;
const currentLearning = () => {
  if (learningMode !== engine.cfg.mode) {
    learning = loadLearning(engine.cfg.mode);
    learningMode = engine.cfg.mode;
  }
  engine.lessons = learning.lessons;
  return learning;
};
function saveLearning() {
  learning.journal = learning.journal.slice(-200);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(learnFile(learningMode) + '.tmp', JSON.stringify(learning));
  fs.renameSync(learnFile(learningMode) + '.tmp', learnFile(learningMode));
  engine.lessons = learning.lessons;
  broadcast('learning', learningView());
}
const journal = (e: JournalEntry) => {
  learning.journal.push(e);
  engine.log(`Learning: ${e.text}`, 'ai');
};
/** Results of finished sales, with the conditions each position was bought in. */
function outcomesNow(): Outcome[] {
  return (engine.readTrades() as any[])
    .filter((t) => t.mode === engine.cfg.mode && t.side === 'sell' && typeof t.pnl === 'number' && t.entry && t.sol - t.pnl > 0)
    .map((t) => ({ at: t.t, entry: t.entry, pnl: t.pnl, cost: t.sol - t.pnl }));
}
function learnRound() {
  const L = currentLearning();
  const now = Date.now();
  const upd = updateLessons(L.lessons, L.retired, learnLessons(outcomesNow(), now, L.retired), now);
  L.lessons = upd.lessons;
  L.retired = upd.retired;
  L.lastAt = now;
  for (const l of upd.expired) journal({ at: now, kind: 'retired', text: `giving ${l.label} another chance after a week; new results will decide.` });
  for (const l of upd.added) journal({ at: now, kind: 'lesson', text: `${l.label} lost you ${Math.abs(l.avgPct).toFixed(0)}% on average over your last ${l.n} trades like it (${l.pnlSol.toFixed(3)} SOL), so Copybot avoids them for a week.` });
  saveLearning();
}
function learningView() {
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
async function applyExits(best: NonNullable<Tune['best']>, why: string) {
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
async function tuneWalletStrategies(d: Awaited<ReturnType<typeof loadBacktestData>>, auto: boolean, progress: (p: string) => void) {
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
    alert('autopilot', `🔧 ${changes.length} wallet${changes.length > 1 ? 's' : ''} would do better with another strategy. Open Copybot → Wallets.`);
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
async function checkShadows() {
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
type Tune = { at: number; status: 'better' | 'fine' | 'error'; message: string; best?: { name: string; stopLossPct: number; takeProfitPct: number; exits: import('./config').Config['exits']; totalSol: number }; currentSol?: number; dismissed?: boolean };
const TUNE_FILE = 'data/autotune.json';
let lastTune: Tune | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(TUNE_FILE, 'utf8'));
  } catch {
    return null;
  }
})();
function saveTune() {
  fs.mkdirSync('data', { recursive: true });
  writeAtomic(TUNE_FILE, JSON.stringify(lastTune));
  broadcast('autotune', lastTune);
}
/** Wallets whose history can be replayed: Solana always, Base when there's an Alchemy key to read it. */
const replayable = (w: { address: string; chain?: string }) => chainOf(w) === 'solana' || (chainOf(w) === 'base' && !!alchemyUrl());
function runAutoTune(manual = false) {
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
      } else if (better) alert('autopilot', `🔧 ${lastTune.message} Open Copybot to use them.`);
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
const chainForAddr = (a: string): import('./chains').ChainId => (/^0x[0-9a-fA-F]{40}$/.test(a) ? 'base' : 'solana');
/** What `raw` units of a token would sell for right now, in SOL per unit (any chain). */
async function solPerUnit(mint: string, raw: bigint, slippageBps: number): Promise<number | null> {
  const c = getChainAdapter(chainForAddr(mint));
  const q = await c.quoteSell(mint, raw, slippageBps).catch(() => null);
  if (!q) return null;
  const sol = await c.nativeToSol(Number(q.outAmount) / 10 ** c.meta.native.decimals).catch(() => null);
  return sol == null ? null : sol / Number(raw);
}

// ---------- connection status: is every outside service working? ----------
const usesBase = () => engine.cfg.wallets.some((w) => chainOf(w) === 'base');
const statusChecks = (): Check[] => [
  {
    id: 'solana-rpc', name: 'Solana node (RPC)', what: 'Sees your wallets\' trades and sends yours',
    run: async () => { const slot = await makeConnection().getSlot(); return rpcUrl().includes('api.mainnet-beta.solana.com') ? `slot ${slot} · free public node: it limits requests` : `slot ${slot}`; },
    fixes: { limited: 'Add a free Helius RPC in Settings → Connection.', down: 'Check your internet, and the RPC URL in Settings → Connection.', slow: 'A private RPC (Helius) is faster.' },
  },
  {
    id: 'solana-backup', name: 'Backup Solana node', what: 'Takes over if the main one fails',
    enabled: () => !!backupRpcUrl(),
    run: async () => { await new Connection(backupRpcUrl()!, 'confirmed').getSlot(); },
    fixes: { down: 'Check the backup RPC URL in Settings → Connection.' },
  },
  {
    id: 'jupiter', name: 'Jupiter (Solana prices and swaps)', what: 'Prices every Solana buy and sell',
    run: async () => { const q = await getQuote('So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1_000_000_000n, 50); if (!q) throw new Error('no quote'); return `1 SOL = $${(Number(q.outAmount) / 1e6).toFixed(2)}`; },
    fixes: { limited: 'Jupiter limits free use. A Jupiter API key (Settings → Connection) raises the limit.', down: 'Jupiter may be having problems; Copybot keeps retrying.' },
  },
  {
    id: 'base-rpc', name: 'Base node (RPC)', what: 'Watches your Base wallets',
    enabled: usesBase,
    run: async () => {
      const head = await baseRpc.blockNumber();
      await baseRpc.call('eth_getLogs', [{ fromBlock: '0x' + (head - 5).toString(16), toBlock: '0x' + head.toString(16), topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] , address: '0x4200000000000000000000000000000000000006' }]);
      return `block ${head}${process.env.BASE_RPC_URL ? '' : ' · free public nodes: they limit requests'}`;
    },
    fixes: { limited: 'Add a free Base RPC from Alchemy or QuickNode in Settings → Connection.', down: 'Check the Base RPC URL in Settings → Connection, or remove it to use the public nodes.' },
  },
  {
    id: 'kyber', name: 'KyberSwap (Base prices)', what: 'Prices every Base buy and sell',
    enabled: usesBase,
    run: async () => { const p = await getChainAdapter('base').nativeUsd(); if (!p) throw new Error('no quote'); return `1 ETH = $${p.toFixed(0)}`; },
    fixes: { limited: 'KyberSwap is limiting requests; Copybot retries automatically.', down: 'KyberSwap may be having problems; Base buys pause until it answers.' },
  },
  {
    id: 'goplus', name: 'GoPlus (Base token safety)', what: 'Checks Base tokens for honeypots and taxes',
    enabled: usesBase,
    run: async () => { const r = await fetch('https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', { signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); },
    fixes: { limited: 'GoPlus is limiting requests; Base buys wait for it.', down: "GoPlus isn't answering: Base buys go ahead on the buy-then-sell test alone, unless \"Skip tokens with no market data\" is on." },
  },
  {
    id: 'dexscreener', name: 'Dexscreener (market data)', what: 'Liquidity, market cap and token age filters',
    run: async () => { const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); },
    fixes: { limited: 'Dexscreener is limiting requests; filters may be skipped briefly.', down: 'Dexscreener is down: buys continue without the market filters unless "Skip tokens with no market data" is on.' },
  },
  {
    id: 'gecko', name: 'GeckoTerminal (charts and scanner)', what: 'Charts, the market scanner and backtests',
    run: async () => { const r = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/dexes?page=1', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); },
    fixes: { limited: 'GeckoTerminal allows about 30 requests a minute; scans and charts slow down briefly.', down: 'GeckoTerminal is down: charts, the scanner and backtests wait for it.' },
  },
];
type StatusSnap = { at: number; results: CheckResult[]; summary: ReturnType<typeof statusSummary> };
let lastStatus: StatusSnap | null = null;
let statusBusy: Promise<StatusSnap> | null = null;
async function checkStatus() {
  statusBusy ??= runChecks(statusChecks())
    .then((results) => {
      const snap: StatusSnap = { at: Date.now(), results, summary: statusSummary(results) };
      lastStatus = snap;
      broadcast('netstatus', snap);
      if (snap.summary.level !== 'ok') engine.log(`Connection check: ${snap.summary.text}. See Settings → Connection status.`, 'warn');
      return snap;
    })
    .finally(() => (statusBusy = null));
  return statusBusy;
}
setInterval(() => { if (engine.running) checkStatus().catch(() => {}); }, 15 * 60_000).unref();

// ---------- live portfolio value (sampled every 30 s, kept for 24 hours, per mode) ----------
const SERIES_FILE = (mode: string) => `data/series-${mode}.json`;
const portfolio = new Map<string, Pt[]>();
function portfolioSeries(mode: string): Pt[] {
  if (!portfolio.has(mode)) {
    let pts: Pt[] = [];
    try {
      const j = JSON.parse(fs.readFileSync(SERIES_FILE(mode), 'utf8'));
      if (Array.isArray(j)) pts = j.filter((p) => Array.isArray(p) && p.length === 2 && p.every((x: unknown) => typeof x === 'number'));
    } catch {
      /* nothing saved yet */
    }
    portfolio.set(mode, pts);
  }
  return portfolio.get(mode)!;
}
/** What everything is worth now: paper wallet (start + closed + open), or live balance + open positions. */
function portfolioValue(): number | null {
  const s = engine.snapshot();
  const open = s.positions.reduce((a: number, p: any) => a + (p.valueSol ?? p.costSol), 0);
  if (s.paper) return s.paper.startSol + s.realizedPnlSol + s.unrealizedPnlSol;
  return s.wallet?.balance == null ? null : s.wallet.balance + open;
}
let seriesSaved = 0;
setInterval(() => {
  if (!engine.running && !Object.keys(engine.state.positions).length) return;
  const v = portfolioValue();
  if (v == null) return;
  const mode = engine.cfg.mode;
  const now = Date.now();
  const pts = portfolioSeries(mode);
  pushPoint(pts, [now, Math.round(v * 1e6) / 1e6], 3000);
  while (pts.length && pts[0][0] < now - 86_400_000) pts.shift();
  broadcast('point', { mode, p: pts[pts.length - 1] });
  if (now - seriesSaved > 120_000) {
    seriesSaved = now;
    fs.mkdirSync('data', { recursive: true });
    writeAtomic(SERIES_FILE(mode), JSON.stringify(pts));
  }
}, 30_000).unref();

// Price lines for the scanner's top coins (6 hours of 5-minute closes), refreshed at most every 5 minutes.
const sparkCache = new Map<string, { at: number; pts: Pt[] }>();
async function refreshSparks(coins: { mint: string; chain?: import('./chains').ChainId }[]) {
  for (const { mint: m, chain } of coins.slice(0, 5)) {
    const hit = sparkCache.get(m);
    if (hit && Date.now() - hit.at < 5 * 60_000) continue;
    const h = await markets.priceHistory(m, Date.now() - 6 * 3_600_000, Date.now(), chain ?? 'solana').catch(() => null);
    sparkCache.set(m, { at: Date.now(), pts: h ? h.candles.map((k) => [k.t, k.c] as Pt) : [] });
  }
  while (sparkCache.size > 60) sparkCache.delete(sparkCache.keys().next().value!);
}
const orderCandles = new Map<string, { at: number; pts: Pt[] }>();

// ---------- phone access (a separate door; see remote.ts) ----------
let remoteCfg = remote.loadRemote();
const pairing = new remote.Pairing();
let remoteServer: http.Server | null = null;
let remoteError: string | null = null;
const PHONE_FILE = () => path.join(path.dirname(UI_FILE), 'phone.html');
const PHONE_HEADERS = {
  ...SECURITY_HEADERS,
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: 'self'; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const PHONE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#7c3aed"/><path d="M18 40c8-20 22-22 30-24-2 8-4 22-24 30-3 1-6-2-6-6z" fill="#a8e07a"/><path d="M22 44l14-14" stroke="#3f7a3a" stroke-width="4" stroke-linecap="round"/></svg>`;
const PHONE_MANIFEST = JSON.stringify({ name: 'Copybot', short_name: 'Copybot', start_url: '/', display: 'standalone', background_color: '#0f0b1e', theme_color: '#7c3aed', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] });

function remoteView() {
  return {
    enabled: remoteCfg.enabled,
    port: remoteCfg.port,
    tailscaleOnly: remoteCfg.tailscaleOnly,
    listening: !!remoteServer?.listening,
    error: remoteError,
    addresses: remote.localAddresses(),
    devices: remoteCfg.devices.map(({ hash: _h, ...d }) => d),
  };
}

/** Open or close the phone door to match the settings. */
async function applyRemote() {
  if (remoteServer) {
    const s = remoteServer;
    remoteServer = null;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  remoteError = null;
  if (!remoteCfg.enabled) return;
  const s = http.createServer((req, res) => handleRemoteSafe(req, res));
  s.requestTimeout = 30_000;
  await new Promise<void>((resolve) => {
    s.once('error', (e: any) => {
      remoteError = e.code === 'EADDRINUSE' ? `Port ${remoteCfg.port} is already in use by another program. Pick another port.` : `Couldn't open phone access: ${e.message}`;
      engine.log(remoteError, 'warn');
      resolve();
    });
    s.listen(remoteCfg.port, '0.0.0.0', () => {
      remoteServer = s;
      engine.log(`Phone access is on (port ${remoteCfg.port}${remoteCfg.tailscaleOnly ? ', Tailscale only' : ''}).`, 'system');
      resolve();
    });
  });
}

let lastSeenSave = 0;
async function handleRemoteSafe(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    // Only the home network and Tailscale: never a public internet address.
    if (!remote.peerAllowed(req.socket.remoteAddress, remoteCfg.tailscaleOnly)) {
      res.writeHead(403);
      return res.end();
    }
    await handleRemote(req, res);
  } catch (e) {
    if (res.headersSent) return;
    send(res, e instanceof HttpError ? e.code : 500, { error: e instanceof HttpError ? e.message : 'Something went wrong.' });
  }
}

async function handleRemote(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', 'http://phone');
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /') {
    res.writeHead(200, { ...PHONE_HEADERS, 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(PHONE_FILE()));
  }
  if (route === 'GET /icon.svg') {
    res.writeHead(200, { ...PHONE_HEADERS, 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
    return res.end(PHONE_ICON);
  }
  if (route === 'GET /manifest.webmanifest') {
    res.writeHead(200, { ...PHONE_HEADERS, 'content-type': 'application/manifest+json' });
    return res.end(PHONE_MANIFEST);
  }
  if (route === 'POST /r/pair') {
    const b = await readBody(req);
    const r = pairing.redeem(b.code, Date.now());
    if (r === 'locked') throw new HttpError(429, 'Too many wrong codes. Wait a minute and scan a new QR code.');
    if (r === 'bad') throw new HttpError(400, 'This pairing code is wrong or has expired. Make a new QR code on the computer.');
    let added;
    try {
      added = remote.addDevice(remoteCfg, b.name, Date.now());
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    remote.saveRemote(remoteCfg);
    engine.log(`Phone paired: ${added.device.name}.`, 'system');
    broadcast('remote', { ...remoteView(), paired: added.device.name });
    return send(res, 200, { key: added.key, name: added.device.name });
  }
  if (!url.pathname.startsWith('/r/')) return send(res, 404, { error: 'not found' });

  const device = remote.findDevice(remoteCfg, req.headers['x-copybot-device'] as string | undefined);
  if (!device) return send(res, 401, { error: 'This phone is not paired (or was removed). Pair it again from Copybot on your computer: Settings → Phone access.' });
  device.lastSeen = Date.now();
  if (Date.now() - lastSeenSave > 5 * 60_000) {
    lastSeenSave = Date.now();
    remote.saveRemote(remoteCfg);
  }
  const from = (what: string) => engine.log(`From ${device.name}: ${what}`, 'system');

  if (route === 'GET /r/state') return send(res, 200, phoneState());
  if (route === 'POST /r/start') {
    await engine.start().catch((e) => {
      throw new HttpError(400, e.message);
    });
    from(`started the bot (${engine.cfg.mode} mode)`);
    return send(res, 200, phoneState());
  }
  if (route === 'POST /r/stop') {
    await engine.stop();
    from('stopped the bot');
    return send(res, 200, phoneState());
  }
  if (route === 'POST /r/sell') {
    const b = await readBody(req);
    if (typeof b.mint !== 'string' || !Object.hasOwn(engine.state.positions, b.mint)) throw new HttpError(400, 'No open position for that token');
    const fraction = b.fraction === 0.5 ? 0.5 : 1;
    if (engine.cfg.mode === 'live' && !engine.kp && chainOf(engine.state.positions[b.mint]) === 'solana') throw new HttpError(400, 'No trading wallet configured');
    from(`sold ${fraction === 1 ? 'all' : 'half'} of ${b.mint.slice(0, 4)}…${b.mint.slice(-4)}`);
    await engine.manualSell(b.mint, fraction);
    return send(res, 200, phoneState());
  }
  if (route === 'POST /r/panic') {
    from('pressed Sell everything & stop');
    const r = await engine.panic(`${device.name} pressed Sell everything`).catch((e) => {
      throw new HttpError(409, e.message);
    });
    return send(res, 200, { ...phoneState(), panic: r });
  }
  if (route === 'POST /r/orders/cancel') {
    const b = await readBody(req);
    const o = engine.orders.find((x) => x.id === b.id && x.status === 'active');
    if (!o || !engine.cancelOrder(o.id)) throw new HttpError(404, 'That order is no longer open.');
    from(`cancelled an order (${describeOrder(o)})`);
    return send(res, 200, phoneState());
  }
  if (route === 'POST /r/resume') {
    engine.resumeBuying();
    from('resumed buying for today');
    return send(res, 200, phoneState());
  }
  if (route === 'POST /r/scanner') {
    const b = await readBody(req);
    const next = structuredClone(engine.cfg);
    for (const k of ['findTraders', 'tradeCoins'] as const) if (typeof b[k] === 'boolean') next.scanner[k] = b[k];
    trialAndResume(next);
    await applyChange(() => saveConfig(next));
    from(`market scanner: find traders ${next.scanner.findTraders ? 'on' : 'off'}, trade coins ${next.scanner.tradeCoins ? 'on' : 'off'}`);
    return send(res, 200, phoneState());
  }
  if (route === 'POST /r/unpair') {
    remoteCfg.devices = remoteCfg.devices.filter((d) => d.id !== device.id);
    remote.saveRemote(remoteCfg);
    engine.log(`${device.name} unpaired itself.`, 'system');
    broadcast('remote', remoteView());
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

/** What the phone sees: no keys, no wallet addresses, no settings beyond the scanner switches. */
function phoneState() {
  const s = engine.snapshot();
  const sc = engine.cfg.scanner;
  const scan = scannerView();
  return {
    version: process.env.COPYBOT_VERSION ?? null,
    running: s.running,
    startedAt: s.startedAt,
    mode: s.mode,
    realizedPnlSol: s.realizedPnlSol,
    unrealizedPnlSol: s.unrealizedPnlSol,
    exposureSol: s.exposureSol,
    maxExposureSol: engine.cfg.risk.maxTotalExposureSol,
    paper: s.paper,
    balance: s.wallet?.balance ?? null,
    guard: s.guard,
    panicking: s.panicking,
    orders: engine.orders.filter((o) => o.status === 'active').map((o) => ({ id: o.id, text: describeOrder(o), note: o.note ?? null })),
    wallets: engine.cfg.wallets.filter((w) => w.enabled).length,
    positions: s.positions.map((p: any) => ({ mint: p.mint, from: p.label, costSol: p.costSol, valueSol: p.valueSol ?? null, pnlPct: p.pnlPct ?? null, openedAt: p.openedAt, trail: downsample(p.trail ?? [], 30) })),
    series: downsample(since(portfolioSeries(s.mode), Date.now() - 86_400_000), 120),
    logs: engine.logs.slice(-40).map((l) => ({ t: l.t, level: l.level, msg: l.msg })),
    trades: readTrades()
      .filter((t: any) => t.mode === s.mode)
      .slice(0, 20)
      .map((t: any) => ({ t: t.t, side: t.side, mint: t.mint, sol: t.sol, pnl: t.pnl ?? null, reason: t.reason ?? null })),
    scanner: { findTraders: sc.findTraders, tradeCoins: sc.tradeCoins, record: scan.record, signals: scan.signals.slice(0, 3).map((x) => ({ symbol: x.symbol, why: x.why })) },
  };
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

  if (route === 'GET /api/report') {
    const by = (['day', 'week', 'month'] as Period[]).find((p) => p === url.searchParams.get('by')) ?? 'day';
    const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'paper';
    const r = profitReport(readTrades(1e9), mode, by);
    const labels = new Map<string, string>([[SCANNER_SOURCE, 'Market scanner'], ...engine.cfg.wallets.map((w) => [w.address, w.label] as [string, string])]);
    const name = (s: string) => labels.get(s) ?? (s === 'unknown' || s === 'manual' ? s : `${s.slice(0, 4)}…${s.slice(-4)}`);
    const curve = downsample(runningTotal(readTrades(1e9).filter((t: any) => t.mode === mode && t.side === 'sell' && typeof t.pnl === 'number').map((t: any) => ({ t: t.t, v: t.pnl }))), 400);
    return send(res, 200, { ...r, mode, curve, bySource: r.bySource.map((x) => ({ ...x, name: name(x.source) })) });
  }

  if (route === 'GET /api/tax') {
    // ?year=2026&mode=live[&csv=1]
    const year = Number(url.searchParams.get('year'));
    if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new HttpError(400, 'Pick a year');
    const mode = url.searchParams.get('mode') === 'paper' ? 'paper' : 'live';
    const all = readTrades(1e9).reverse();
    const mints = [...new Set(all.filter((t: any) => t.mode === mode).map((t: any) => t.mint as string))].filter(isAddress);
    const prices = await markets.solUsdDaily().catch((e) => {
      throw new HttpError(502, (e as Error).message);
    });
    const days = [...prices.keys()].sort((a, b) => a - b);
    const solUsdAt = (t: number) => {
      const day = Math.floor(t / 86_400_000) * 86_400_000;
      if (prices.has(day)) return prices.get(day)!;
      // Today's candle may not be closed yet: use the latest day before.
      const before = days.filter((d) => d <= day).pop();
      return before != null && day - before <= 3 * 86_400_000 ? prices.get(before)! : null;
    };
    // Token decimals from the chain (100 per request) and symbols from Dexscreener (30 per request).
    const decimals = new Map<string, number>();
    const conn = makeConnection();
    for (let i = 0; i < mints.length; i += 100) {
      const infos = await conn.getMultipleParsedAccounts(mints.slice(i, i + 100).map((m) => new PublicKey(m))).catch(() => null);
      infos?.value.forEach((a, j) => {
        const d = (a?.data as any)?.parsed?.info?.decimals;
        if (typeof d === 'number') decimals.set(mints[i + j], d);
      });
    }
    const symbols = new Map<string, string>();
    for (let i = 0; i < mints.length; i += 30) {
      const list = await markets.tokens(mints.slice(i, i + 30)).catch(() => []);
      for (const t of list as any[]) if (t?.mint && t?.symbol && t.symbol !== '?') symbols.set(t.mint, t.symbol);
    }
    const rows = taxRows(all, mode, solUsdAt, decimals, symbols).filter((r) => new Date(r.t).getUTCFullYear() === year);
    if (url.searchParams.get('csv')) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/csv; charset=utf-8' });
      return res.end(taxCsv(rows));
    }
    return send(res, 200, { year, mode, ...taxSummary(rows), missingDecimals: mints.length - decimals.size });
  }

  if (route === 'GET /api/series') {
    const hours = { '1h': 1, '6h': 6, '24h': 24 }[url.searchParams.get('range') ?? '6h'] ?? 6;
    const mode = engine.cfg.mode;
    return send(res, 200, { mode, points: downsample(since(portfolioSeries(mode), Date.now() - hours * 3_600_000), 400) });
  }

  if (route === 'GET /api/position-chart') {
    const mint = url.searchParams.get('mint');
    const p = mint ? engine.state.positions[mint] : null;
    if (!p) throw new HttpError(404, 'That position is closed.');
    const trades = readTrades(2000)
      .filter((t: any) => t.mint === mint && t.mode === engine.cfg.mode && t.t >= p.openedAt - 60_000)
      .map((t: any) => ({ t: t.t, side: t.side, sol: t.sol, pnl: t.pnl ?? null, reason: t.reason ?? null }))
      .reverse();
    const ex = exitConfigFor(engine.cfg, p.sources);
    return send(res, 200, { mint, openedAt: p.openedAt, costSol: p.costSol, trail: p.trail ?? [], peakMultiple: p.peakMultiple ?? 1, steps: p.steps ?? [], trades, exits: { stopLossPct: ex.risk.stopLossPct, takeProfitPct: ex.risk.takeProfitPct, ...ex.exits } });
  }

  if (route === 'GET /api/orders/chart') {
    const mint = url.searchParams.get('mint');
    if (!isAddress(mint)) throw new HttpError(400, 'Not a valid token address');
    let c = orderCandles.get(mint);
    if (!c || Date.now() - c.at > 5 * 60_000) {
      const h = await markets.priceHistory(mint, Date.now() - 86_400_000, Date.now()).catch(() => null);
      c = { at: Date.now(), pts: h ? h.candles.map((k) => [k.t, k.c] as Pt) : [] };
      orderCandles.set(mint, c);
      while (orderCandles.size > 40) orderCandles.delete(orderCandles.keys().next().value!);
    }
    // Market candles for context, then the live prices Copybot has seen since (every 15 s).
    const live = engine.orderPrices.get(mint) ?? [];
    const lastCandle = c.pts[c.pts.length - 1]?.[0] ?? 0;
    return send(res, 200, { points: [...downsample(c.pts, 200), ...live.filter((p) => p[0] > lastCandle)] });
  }

  if (route === 'POST /api/wallets/base-check') {
    const a = String((await readBody(req)).address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new HttpError(400, 'Not a Base address');
    const k = await baseRpc.accountKind(a).catch(() => null);
    if (!k) return send(res, 200, { level: 'unknown', text: "Couldn't check this address right now; it was added anyway." });
    if (k.contract) return send(res, 200, { level: 'info', text: 'This is a smart-contract wallet. Copybot copies the tokens moving in and out of it, which works.' });
    if (k.sent === 0) return send(res, 200, { level: 'warn', text: "This address has never sent a transaction itself. If it's a trader's wallet, double-check it on Basescan: you may want the address that actually trades." });
    return send(res, 200, { level: 'ok', text: `A regular wallet with ${k.sent.toLocaleString()} transactions sent.` });
  }

  if (route === 'POST /api/status/check') return send(res, 200, await checkStatus());

  if (route === 'GET /api/readiness') {
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
    return send(res, 200, { at: now, sources, checklist, overall: overallVerdict(sources, checklist) });
  }

  // ---------- backup and restore (secrets are never included) ----------
  if (route === 'GET /api/backup') {
    const b = buildBackup(process.env.COPYBOT_VERSION ?? null);
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
    return res.end(JSON.stringify(b));
  }
  if (route === 'POST /api/backup/restore') {
    if (engine.running) throw new HttpError(409, 'Stop the bot first, then restore.');
    const c = checkBackup(await readBody(req, 64_000_000));
    if ('error' in c) throw new HttpError(400, c.error);
    const safety = restoreBackup(c.files, process.env.COPYBOT_VERSION ?? null);
    engine.reload();
    engine.log(`Restored a backup (${Object.keys(c.files).length} files). Your data from before is kept in ${safety}.`, 'system');
    return send(res, 200, { files: Object.keys(c.files).length, safety, restartNeeded: true });
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
      scanner: scannerView(),
      tune: lastTune,
      learning: learningView(),
      netstatus: lastStatus,
      strategies: STRATEGIES,
      health: lastHealth,
      app: { version: process.env.COPYBOT_VERSION ?? null, update: updateState, justUpdated },
      chain: { id: engine.chain.meta.id, name: engine.chain.meta.name, symbol: engine.chain.meta.native.symbol, usd: await engine.chain.nativeUsd().catch(() => null) },
      ui: uiPrefs,
    });
  }

  if (route === 'POST /api/jobs/quickstart') {
    if (engine.cfg.mode !== 'paper') throw new HttpError(400, 'Quick experiments only run in paper mode.');
    if (engine.running) throw new HttpError(409, 'The bot is already running.');
    if (jobs.some((j) => j.kind === 'quickstart' && (j.status === 'queued' || j.status === 'running'))) throw new HttpError(409, 'Already setting up an experiment.');
    const job = addJob('quickstart', {}, async (progress) => {
      progress('Looking at tokens that are moving right now…');
      const pools = await markets.scoutPools();
      const tokens = pickTokens(pools, Date.now(), 8, new Set());
      if (!tokens.length) throw new Error('No tokens are moving enough right now. Try again in a while, or add wallets yourself.');
      const mine = new Set(engine.cfg.wallets.map((w) => w.address));
      // Recent big trades for each token (kept so the gain bar can be lowered without fetching again).
      const tradesBy: { t: (typeof tokens)[number]; trades: Awaited<ReturnType<typeof markets.poolTrades>> }[] = [];
      let failed = 0;
      for (const [i, t] of tokens.entries()) {
        progress(`Finding traders who caught ${t.symbol}'s move (${i + 1}/${tokens.length})…`);
        try {
          tradesBy.push({ t, trades: await markets.poolTrades(t.pool, 300) });
        } catch (e) {
          failed++;
          engine.log(`Experiment: couldn't load ${t.symbol}'s trades (${(e as Error).message})`, 'warn');
        }
      }
      if (!tradesBy.length) throw new Error(`The market data service (GeckoTerminal) isn't answering right now (${failed} requests failed). Wait a minute and try again.`);
      const collect = (minGain: number) => {
        const caught = new Map<string, { tokens: string[]; bestGainPct: number }>();
        for (const { t, trades } of tradesBy) {
          for (const [w, gain] of pumpBuyers(trades, t.priceUsd, minGain)) {
            const c = caught.get(w) ?? { tokens: [], bestGainPct: 0 };
            c.tokens.push(t.symbol);
            c.bestGainPct = Math.max(c.bestGainPct, gain);
            caught.set(w, c);
          }
        }
        return experimentPicks(caught, mine, 3);
      };
      // Prefer traders up 40%+; if the market has cooled off, accept 15%+.
      let picks = collect(40);
      if (picks.length < 3) picks = [...picks, ...collect(15).filter((p) => !picks.some((x) => x.wallet === p.wallet))].slice(0, 3);
      // Still nobody: fall back to the last wallet-scout search.
      if (!picks.length) {
        picks = (lastScout?.reports ?? [])
          .filter((r) => !mine.has(r.wallet) && r.swaps > 0)
          .slice(0, 3)
          .map((r) => ({ wallet: r.wallet, tokens: [...(r.pumpOn ?? []), ...r.earlyOn].slice(0, 2), bestGainPct: 0 }));
      }
      if (!picks.length) throw new Error(`No trader on today's ${tradesBy.length} trending tokens is in profit right now (prices have fallen back). Try again in a while, or use Find wallets.`);
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
    await resetPaper();
    return send(res, 200, { ok: true, status: engine.snapshot() });
  }
  if (route === 'POST /api/paper/amount') {
    // How much pretend SOL paper trading has; optionally start a fresh experiment with it.
    const b = await readBody(req);
    const sol = Number(b.sol);
    if (!Number.isFinite(sol) || sol < 0.1 || sol > 100_000) throw new HttpError(400, 'The paper amount must be between 0.1 and 100,000 SOL.');
    if (b.fresh && engine.cfg.mode !== 'paper') throw new HttpError(400, 'Switch to paper mode to start a fresh paper experiment.');
    const next = structuredClone(engine.cfg);
    next.paper.startSol = Math.round(sol * 1e6) / 1e6;
    const clean = sanitizeConfig(next, true);
    await applyChange(() => saveConfig(clean));
    if (b.fresh) await resetPaper();
    else engine.log(`Paper wallet amount changed to ${clean.paper.startSol} SOL (results so far kept).`, 'system');
    return send(res, 200, { ok: true, config: engine.cfg, status: engine.snapshot() });
  }

  // ---------- phone access (desktop side) ----------
  if (route === 'GET /api/remote') return send(res, 200, remoteView());
  if (route === 'PUT /api/remote') {
    const b = await readBody(req);
    if (b.port !== undefined && !remote.validPort(b.port)) throw new HttpError(400, 'Port must be a whole number between 1024 and 65535');
    const before = JSON.stringify([remoteCfg.enabled, remoteCfg.port, remoteCfg.tailscaleOnly]);
    if (typeof b.enabled === 'boolean') remoteCfg.enabled = b.enabled;
    if (typeof b.tailscaleOnly === 'boolean') remoteCfg.tailscaleOnly = b.tailscaleOnly;
    if (b.port !== undefined) remoteCfg.port = b.port;
    remote.saveRemote(remoteCfg);
    if (JSON.stringify([remoteCfg.enabled, remoteCfg.port, remoteCfg.tailscaleOnly]) !== before) {
      if (!remoteCfg.enabled) pairing.cancelAll();
      await applyRemote();
      if (!remoteCfg.enabled) engine.log('Phone access is off.', 'system');
    }
    return send(res, 200, remoteView());
  }
  if (route === 'POST /api/remote/pair') {
    if (!remoteServer?.listening) throw new HttpError(400, 'Turn phone access on first.');
    if (remoteCfg.devices.length >= remote.MAX_DEVICES) throw new HttpError(400, `At most ${remote.MAX_DEVICES} paired devices. Remove one first.`);
    const { code, expiresAt } = pairing.create(Date.now());
    const a = remote.localAddresses();
    const hosts = [...a.tailscale.map((h) => ({ via: 'tailscale', h })), ...(remoteCfg.tailscaleOnly ? [] : a.lan.map((h) => ({ via: 'wifi', h })))];
    if (!hosts.length) throw new HttpError(400, remoteCfg.tailscaleOnly ? "Tailscale isn't running on this computer. Open Tailscale and sign in, then try again." : "This computer isn't on a network. Connect to Wi-Fi (or start Tailscale) and try again.");
    const links = await Promise.all(
      hosts.slice(0, 4).map(async ({ via, h }) => {
        const link = `http://${h}:${remoteCfg.port}/#pair=${code}`;
        return { via, host: h, url: link, qr: await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
      }),
    );
    return send(res, 200, { links, expiresAt });
  }
  if (route === 'DELETE /api/remote/device') {
    const id = url.searchParams.get('id');
    const d = remoteCfg.devices.find((x) => x.id === id);
    if (!d) throw new HttpError(404, 'No such device');
    remoteCfg.devices = remoteCfg.devices.filter((x) => x.id !== id);
    remote.saveRemote(remoteCfg);
    engine.log(`Removed ${d.name} from phone access.`, 'system');
    return send(res, 200, remoteView());
  }

  if (route === 'POST /api/start') {
    await engine.start().catch((e) => {
      throw new HttpError(400, e.message);
    });
    return send(res, 200, engine.snapshot());
  }

  if (route === 'POST /api/orders') {
    const b = await readBody(req);
    const o = makeOrder(b, Date.now(), crypto.randomBytes(6).toString('hex'));
    if (typeof o === 'string') throw new HttpError(400, o);
    if (engine.cfg.mode === 'live' && o.chain === 'base' && !getChainAdapter('base').liveTrading) throw new HttpError(400, 'Live trading on Base is off: turn it on in Settings → Trading wallet to place Base orders in live mode.');
    if (engine.cfg.mode === 'live' && o.chain !== 'base' && !engine.kp) throw new HttpError(400, 'Live mode needs a trading wallet first (Settings → Trading wallet).');
    if (!o.symbol) {
      const info = await markets.tokensAnyChain([o.mint]).catch(() => []);
      const sym = (info as any[])[0]?.symbol;
      if (sym && sym !== '?') o.symbol = sym;
    }
    try {
      engine.addOrder(o);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return send(res, 200, engine.snapshot());
  }

  if (route === 'DELETE /api/orders') {
    if (!engine.cancelOrder(url.searchParams.get('id') ?? '')) throw new HttpError(404, 'That order is no longer open.');
    return send(res, 200, engine.snapshot());
  }

  if (route === 'POST /api/panic') {
    if (engine.cfg.mode === 'live' && !engine.kp && Object.values(engine.state.positions).some((p) => chainOf(p) === 'solana')) throw new HttpError(400, 'No trading wallet configured');
    const r = await engine.panic('you pressed Sell everything').catch((e) => {
      throw new HttpError(409, e.message);
    });
    return send(res, 200, { ...r, status: engine.snapshot() });
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
    for (const k of ['rpcUrl', 'backupRpcUrl', 'baseRpcUrl', 'jupiterKey', 'privateKey', 'dexcheckKey', 'anthropicKey', 'solscanKey']) {
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
    if (typeof b.baseRpcUrl === 'string') {
      const u = b.baseRpcUrl.trim();
      if (u && !isHttpsUrl(u)) throw new HttpError(400, 'Base RPC URL must be a valid https:// address');
      env.BASE_RPC_URL = u;
    }
    if (typeof b.jupiterKey === 'string') env.JUPITER_API_KEY = b.jupiterKey.trim();
    let newKey: string | null = null;
    let newBaseKey: string | null = null;
    if (typeof b.baseKey === 'string') {
      newBaseKey = b.baseKey.trim();
      if (newBaseKey) {
        try {
          const { baseAccount } = await import('./chains/base-live');
          baseAccount(newBaseKey);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
    }
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
      if (Object.keys(env).length || newKey !== null || newBaseKey !== null) {
        await applyChange(() => {
          if (Object.keys(env).length) updateEnv(env);
          if (newKey !== null) savePrivateKey(newKey);
          if (newBaseKey !== null) saveSecret('BASE_PRIVATE_KEY', newBaseKey);
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
    if (typeof b.mint !== 'string' || !Object.hasOwn(engine.state.positions, b.mint)) throw new HttpError(400, 'No open position for that token');
    const fraction = Math.min(1, Math.max(0.01, Number(b.fraction) || 1));
    if (engine.cfg.mode === 'live' && !engine.kp && chainOf(engine.state.positions[b.mint]) === 'solana') throw new HttpError(400, 'No trading wallet configured');
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
    const mch: import('./chains').ChainId = isChainIdFn(q.get('chain')) ? (q.get('chain') as import('./chains').ChainId) : 'solana';
    switch (route) {
      // Which chain the Markets page is looking at (Solana unless it says Base).
      case 'GET /api/markets/overview':
        return reply(() => markets.overview());
      case 'GET /api/markets/pools': {
        const kind = q.get('kind') === 'new' ? 'new' : 'trending';
        return reply(() => markets.pools(kind, mch));
      }
      case 'GET /api/markets/token': {
        const mint = q.get('mint');
        if (!getChainAdapter(mch).meta.isAddress(mint)) throw new HttpError(400, 'Not a valid token address');
        return reply(async () => {
          const t = await markets.token(mint, mch);
          if (!t) return null;
          // Would Copybot's own token filters let it buy this right now?
          const solUsd = await getSolUsd().catch(() => null);
          const verdict = marketSkipReason(
            { liquidityUsd: t.totalLiquidityUsd, marketCapUsd: t.marketCapUsd, createdAt: t.oldestPoolAt },
            engine.cfg.filters,
            solUsd ? engine.cfg.buy.fixedSol * solUsd : null,
            Date.now(),
          );
          return { ...t, filterVerdict: verdict, watched: readWatchlist().includes(mch === 'base' ? mint.toLowerCase() : mint) };
        });
      }
      case 'GET /api/markets/chart': {
        const pool = q.get('pool'), tf = q.get('tf') ?? '1h';
        if (!getChainAdapter(mch).meta.isAddress(pool) || !markets.isTimeframe(tf)) throw new HttpError(400, 'Invalid chart request');
        return reply(() => markets.chart(pool, tf, mch));
      }
      case 'GET /api/markets/search':
        return reply(() => markets.search(String(q.get('q') ?? ''), mch));
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
        return reply(() => markets.tokensAnyChain(readWatchlist()));
      case 'PUT /api/markets/watchlist': {
        const b = await readBody(req);
        if (!isTokenAddress(b.mint)) throw new HttpError(400, 'Not a valid token address');
        const mint = isAddress(b.mint) ? b.mint : b.mint.toLowerCase();
        const list = readWatchlist().filter((m) => m !== mint);
        if (b.watch) list.unshift(mint);
        fs.mkdirSync('data', { recursive: true });
        writeAtomic(WATCHLIST, JSON.stringify(list.slice(0, 30)));
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
    writeAtomic('data/ui.json', JSON.stringify(uiPrefs));
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

  if (route === 'POST /api/jobs/scannertest') {
    const days = Math.min(3, Math.max(1, Math.round(Number((await readBody(req)).days) || 3)));
    if (jobs.some((j) => j.kind === 'scannertest' && (j.status === 'queued' || j.status === 'running'))) throw new HttpError(409, 'The scanner test is already running.');
    const job = addJob('scannertest', { days }, async (progress) => {
      const t = await runScannerTest(days, progress);
      broadcast('scanner', scannerView());
      return scannerTestSummary(t);
    });
    return send(res, 200, job);
  }

  if (route === 'POST /api/scanner/use-test') {
    const b = await readBody(req);
    const v = lastScannerTest?.rows.find((r) => r.exitId === b.exitId && r.entry === b.entry);
    if (!v) throw new HttpError(400, 'Run "Test on the past" first.');
    const next = structuredClone(engine.cfg);
    next.scanner = { ...next.scanner, ...v.exits, rules: v.entry };
    let clean;
    try {
      clean = sanitizeConfig(next, true);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    await applyChange(() => saveConfig(clean));
    engine.log(`Scanner now uses ${ENTRY_NAMES[v.entry].toLowerCase()} with "${v.name}" exits (from the test on the past).`, 'system');
    return send(res, 200, { config: engine.cfg });
  }

  if (route === 'POST /api/autotune/run') return send(res, 200, runAutoTune(true));
  if (route === 'POST /api/wallets/shadow') {
    // From the Wallets page: shadow a wallet, stop shadowing it, or promote it now.
    const b = await readBody(req);
    const next = structuredClone(engine.cfg);
    const w = next.wallets.find((x) => x.address === b.address);
    if (!w) throw new HttpError(404, "That wallet isn't in your list.");
    if (b.action === 'start') {
      if (next.wallets.filter((x) => x.shadow).length >= SHADOW.max) throw new HttpError(400, `At most ${SHADOW.max} wallets in shadow at once.`);
      Object.assign(w, { enabled: false, shadow: true });
      restartShadow(engine.shadow, w.address, Date.now());
      engine.saveShadow(true);
    } else if (b.action === 'stop') {
      delete w.shadow;
    } else if (b.action === 'promote') {
      Object.assign(w, { enabled: true, pausedReason: undefined, since: Date.now(), ...(next.trial.enabled ? { trialStage: 0 as const } : {}) });
      delete w.shadow;
    } else throw new HttpError(400, 'Unknown action.');
    await applyChange(() => saveConfig(sanitizeConfig(next, true)));
    engine.log(b.action === 'start' ? `Shadow: copying ${w.label} virtually until it proves itself.` : b.action === 'promote' ? `Shadow: ${w.label} promoted by you; now copying for real.` : `Shadow: stopped shadowing ${w.label}.`, 'system');
    return send(res, 200, { config: engine.cfg, status: engine.snapshot() });
  }
  if (route === 'POST /api/learning/now') {
    learnRound();
    return send(res, 200, learningView());
  }
  if (route === 'POST /api/learning/forget') {
    const b = await readBody(req);
    const L = currentLearning();
    const l = L.lessons.find((x) => x.feature === b.feature && x.bucket === b.bucket);
    if (!l) throw new HttpError(404, 'That lesson is gone already.');
    L.lessons = L.lessons.filter((x) => x !== l);
    L.retired.push({ feature: l.feature, bucket: l.bucket, label: l.label, retiredAt: Date.now() });
    journal({ at: Date.now(), kind: 'retired', text: `you asked to forget "${l.label}"; new results will decide.` });
    saveLearning();
    return send(res, 200, learningView());
  }
  if (route === 'POST /api/learning/undo') {
    const b = await readBody(req);
    const L = currentLearning();
    const st = L.journal.find((x) => x.at === b.at && x.kind === 'strategy' && x.undoStrategy);
    if (st?.undoStrategy) {
      const next = structuredClone(engine.cfg);
      const w = next.wallets.find((x) => x.address === st.undoStrategy!.wallet);
      if (!w) throw new HttpError(404, "That wallet isn't in your list anymore.");
      if (st.undoStrategy.strategy) w.strategy = st.undoStrategy.strategy;
      else delete w.strategy;
      w.strategyBy = 'you';
      w.strategyAt = Date.now();
      await applyChange(() => saveConfig(sanitizeConfig(next, true)));
      if (st.setup) L.vetoed = [...(L.vetoed ?? []).filter((v) => v.until > Date.now()), { setup: st.setup, until: Date.now() + 7 * 86_400_000 }]; // don't switch right back
      delete st.undoStrategy;
      journal({ at: Date.now(), kind: 'undo', text: `you undid a strategy change for ${w.label}; its previous strategy is back.` });
      saveLearning();
      return send(res, 200, { config: engine.cfg, learning: learningView() });
    }
    const e = L.journal.find((x) => x.at === b.at && x.kind === 'exits' && x.undo);
    if (!e?.undo) throw new HttpError(404, 'Nothing to undo there.');
    const next = structuredClone(engine.cfg);
    next.risk.stopLossPct = e.undo.stopLossPct;
    next.risk.takeProfitPct = e.undo.takeProfitPct;
    next.exits = e.undo.exits;
    const clean = sanitizeConfig(next, true);
    await applyChange(() => saveConfig(clean));
    delete e.undo;
    if (e.setup) L.vetoed = [...(L.vetoed ?? []).filter((v) => v.until > Date.now()), { setup: e.setup, until: Date.now() + 7 * 86_400_000 }]; // don't switch right back
    journal({ at: Date.now(), kind: 'undo', text: 'you undid an exit change; your previous exit settings are back.' });
    saveLearning();
    return send(res, 200, { config: engine.cfg, learning: learningView() });
  }
  if (route === 'POST /api/autotune/apply') {
    const best = lastTune?.best;
    if (!best || lastTune?.status !== 'better') throw new HttpError(400, 'There is no suggestion to apply.');
    await applyExits(best, 'you chose the settings check\'s suggestion');
    lastTune = { ...lastTune!, status: 'fine', message: `You switched to "${best.name}". The next check is in a week.`, dismissed: true };
    saveTune();
    return send(res, 200, { config: engine.cfg, tune: lastTune });
  }
  if (route === 'POST /api/autotune/dismiss') {
    if (lastTune) lastTune.dismissed = true;
    saveTune();
    return send(res, 200, { tune: lastTune });
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
    // Base wallets are checked too when an Alchemy key is set (their history comes from Alchemy).
    const wallets = engine.cfg.wallets.filter((w) => chainOf(w) === 'solana' || alchemyUrl()).slice(0, 15);
    if (!wallets.length) throw new HttpError(400, 'The check-up reads Solana history: add Solana wallets to check.');
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
      writeAtomic(HEALTH_FILE, JSON.stringify(lastHealth));
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
    next.exits = { lockAtPct: next.exits.lockAtPct, lockFloorPct: next.exits.lockFloorPct, ...pick.setup.exits };
    const clean = sanitizeConfig(next, true);
    const restarted = await applyChange(() => saveConfig(clean));
    engine.log(`Exit settings changed to: ${pick.setup.name}`, 'system');
    return send(res, 200, { ok: true, restarted, config: engine.cfg });
  }

  if (route === 'POST /api/jobs/scout') {
    return send(res, 200, startScout(false, (await readBody(req)).chain === 'base' ? 'base' : 'solana'));
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
      applyRemote().catch(() => {});
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
