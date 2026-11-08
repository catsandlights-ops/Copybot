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
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BotEngine } from './engine';
import { isAddress, sanitizeConfig, saveConfig } from './config';
import { canEncryptKey, encryptPlaintextKey, hasSecret, isHttpsUrl, saveSecret, secretIsEncrypted, jupKey, jupUrl, keyIsEncrypted, makeConnection, parseKeypair, rpcUrl, savePrivateKey, updateEnv } from './env';
import { fetchSwaps, score } from './analyze';
import { earlyBuyers, rankCandidates } from './discover';
import * as markets from './markets';
import { getSolUsd } from './market';
import { marketSkipReason, walletRecords } from './rules';
import * as ai from './ai';
import { pickCandidates, pickTokens, rulePicks, ScoutReport, ScoutResult } from './scout';

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
type UiPrefs = { mode: (typeof MODES)[number] };
function loadUiPrefs(): UiPrefs {
  try {
    const m = JSON.parse(fs.readFileSync('data/ui.json', 'utf8')).mode; // older versions stored a "theme" instead
    if (MODES.includes(m)) return { mode: m };
  } catch {
    /* defaults */
  }
  return { mode: 'system' };
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
ai.onDecision((d) => broadcast('ai', d));
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
  kind: 'analyze' | 'discover' | 'scout';
  status: 'queued' | 'running' | 'done' | 'error';
  progress: string;
  input: unknown;
  result?: unknown;
  error?: string;
  createdAt: number;
};
const jobs: Job[] = [];
let jobSeq = 0;
let jobChain: Promise<void> = Promise.resolve();

function addJob(kind: Job['kind'], input: unknown, run: (progress: (p: string) => void) => Promise<unknown>) {
  if (jobs.filter((j) => j.status === 'queued' || j.status === 'running').length >= 5) throw new HttpError(429, 'Too many jobs waiting. Let the current ones finish first.');
  const job: Job = { id: ++jobSeq, kind, status: 'queued', progress: 'Waiting…', input, createdAt: Date.now() };
  jobs.unshift(job);
  if (jobs.length > 20) jobs.pop();
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
  stats: { swaps: r.swaps, days: r.days, tradesPerDay: r.tradesPerDay, closedTokens: r.closedTokens, winRate: r.winRate, realizedPnlSol: r.realizedPnlSol, roiPct: r.roiPct, medianBuySol: r.medianBuySol, medianHoldMin: r.medianHoldMin, earlyOnPumpedTokens: r.earlyOn, topTraderOn: r.topTraderOn, notes: r.notes },
});

/** Wallets the AI may add: the ones the user analyzed or discovered, plus the latest scout results. */
function aiCandidates(): ai.CandidateView[] {
  const out = new Map<string, ai.CandidateView>();
  for (const r of lastScout?.reports ?? []) if (r.swaps > 0) out.set(r.wallet, scoutView(r));
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
  progress('Looking for tokens that pumped recently…');
  const rows = [...(await markets.pools('trending').catch(() => [])), ...(await markets.pools('new').catch(() => []))];
  const tokens = pickTokens(rows, at, 5);
  if (!tokens.length) throw new Error('No suitable tokens right now (none up 30%+ in 24h with real liquidity, 3h to 7 days old). Try again later.');
  const symbols = new Map(tokens.map((t) => [t.mint, t.symbol]));

  const conn = makeConnection();
  const perMint = new Map<string, Map<string, number>>();
  for (const [i, t] of tokens.entries()) {
    progress(`Token ${i + 1}/${tokens.length} (${t.symbol}): finding early buyers…`);
    perMint.set(
      t.mint,
      await earlyBuyers(conn, t.mint, 120, 25, (w) => notes.push(`${t.symbol}: ${w.replace(/^⚠\s*/, '').replace(/ Use --pages to go deeper\./, '')}`), (m) => progress(`Token ${i + 1}/${tokens.length} (${t.symbol}): ${m}`)),
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
  const cands = pickCandidates(rankCandidates(perMint), top, symbols, mine, 12);
  if (!cands.length) throw new Error('Found no wallets worth analyzing this time. Try again later.');

  const reports: ScoutReport[] = [];
  for (const [i, c] of cands.entries()) {
    const swaps = await fetchSwaps(conn, c.wallet, 300, (n, t) => {
      if (n % 25 === 0 || n === t) progress(`Checking wallet ${i + 1}/${cands.length}: transaction ${n} of ${t}`);
    }).catch(() => null);
    if (swaps) reports.push({ ...score(c.wallet, swaps), earlyOn: c.earlyOn, topTraderOn: c.topTraderOn });
  }
  reports.sort((a, b) => b.realizedPnlSol - a.realizedPnlSol);

  // Let Claude choose; fall back to the rule-based ranking.
  const cfg = engine.cfg;
  const autoAdd = cfg.ai.enabled && cfg.ai.manageWallets;
  const free = Math.max(0, cfg.ai.maxWallets - cfg.wallets.filter((w) => w.enabled).length);
  const max = autoAdd ? Math.min(cfg.ai.scoutMaxPicks, free) : cfg.ai.scoutMaxPicks;
  if (autoAdd && !free) notes.push(`You already copy ${cfg.ai.maxWallets} wallets (the autopilot's maximum), so nothing new was added.`);
  let picks = rulePicks(reports, max);
  let pickedBy: ScoutResult['pickedBy'] = 'rules';
  let summary = picks.length ? 'Ranked by win rate, return and number of trades.' : 'None of the wallets passed the basic checks (10+ closed trades, profitable, not a bot, not too fast).';
  if (max > 0 && hasSecret('ANTHROPIC_API_KEY')) {
    progress('Claude is choosing…');
    const recs = walletRecords(engine.readTrades(), cfg.mode);
    const current = cfg.wallets.map((w) => ({ address: w.address, label: w.label, enabled: w.enabled, sizeMultiplier: w.sizeMultiplier, budgetSol: w.maxExposureSol, ourRecord: recs[w.address] ?? { trades: 0, closed: 0, wins: 0, pnlSol: 0 } }));
    const r = await ai.pickWallets(cfg, current, reports.filter((x) => x.swaps > 0).map(scoutView), max);
    if (r) {
      picks = r.picks;
      pickedBy = 'claude';
      summary = r.summary;
    } else notes.push(`Claude wasn't available (${ai.aiStatus(cfg).lastError ?? 'no answer'}), so the picks are rule-based.`);
  }

  const added: string[] = [];
  if (autoAdd && picks.length) {
    const next = structuredClone(engine.cfg);
    for (const p of picks) {
      if (next.wallets.some((w) => w.address === p.address) || next.wallets.filter((w) => w.enabled).length >= cfg.ai.maxWallets) continue;
      next.wallets.push({ address: p.address, label: `scout-${p.address.slice(0, 4)}`, enabled: true, sizeMultiplier: p.sizeMultiplier, maxExposureSol: p.budgetSol });
      added.push(p.address);
    }
    if (added.length) {
      const clean = sanitizeConfig(next, false);
      await applyChange(() => saveConfig(clean));
      for (const a of added) engine.log(`Wallet scout: now copying ${a.slice(0, 4)}…${a.slice(-4)}: ${picks.find((p) => p.address === a)!.reason}`, 'ai');
    }
  }
  const result: ScoutResult = { at, tokens, reports, picks, pickedBy, summary, added, notes };
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

  if (route === 'GET /api/state') {
    return send(res, 200, {
      status: engine.snapshot(),
      config: engine.cfg,
      logs: engine.logs,
      trades: readTrades(),
      connection: connectionInfo(),
      jobs,
      scout: lastScout,
      app: { version: process.env.COPYBOT_VERSION ?? null, update: updateState, justUpdated },
      ui: uiPrefs,
    });
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
    const restarted = await applyChange(() => saveConfig(cfg));
    return send(res, 200, { ok: true, restarted, config: engine.cfg });
  }

  if (route === 'PUT /api/connection') {
    const b = await readBody(req);
    for (const k of ['rpcUrl', 'jupiterKey', 'privateKey', 'dexcheckKey', 'anthropicKey']) {
      if (b[k] !== undefined && (typeof b[k] !== 'string' || /[\u0000-\u001f\u007f]/.test(b[k].trim()))) throw new HttpError(400, `Invalid ${k}`);
    }
    const env: Record<string, string> = {};
    if (typeof b.rpcUrl === 'string' && b.rpcUrl.trim()) {
      if (!isHttpsUrl(b.rpcUrl.trim())) throw new HttpError(400, 'RPC URL must be a valid https:// address');
      env.RPC_URL = b.rpcUrl.trim();
      env.WS_URL = '';
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
      return send(res, 200, { ok: true, slot, rpcMs, jupiterOk: !!j, jupMs, solPrice: j ? Number(j.outAmount) / 1e6 / 0.1 : null });
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
    if (!MODES.includes(b.mode)) throw new HttpError(400, 'Unknown appearance');
    uiPrefs = { mode: b.mode };
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
