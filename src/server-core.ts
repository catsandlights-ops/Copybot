/** Shared by the control panel's parts: the engine, live updates to the page, background jobs, HTTP helpers. */
import { dailyBackup, ErrorBurst, readRunState, saveRunState, shouldResume, trimOldCopies } from './upkeep';
import { buildBackup } from './backup';
import { writeAtomic } from './util';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BotEngine } from './engine';
import { isAddress } from './config';
import { getChain as getChainAdapter } from './chains';
import { backupRpcUrl, failover, onRpcSwitch } from './env';
import { canEncryptKey, encryptPlaintextKey, hasSecret, secretIsEncrypted, jupKey, jupUrl, keyIsEncrypted, rpcUrl } from './env';
import * as ai from './ai';
import * as alerts from './alerts';
import { readTradeLog } from './tradelog';

export const UI_FILE = process.env.COPYBOT_UI || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
// The only files served besides the page: [path relative to ui/, content type].
export const STATIC: Record<string, [string, string]> = {
  '/fonts/press-start-2p.woff2': ['fonts/press-start-2p.woff2', 'font/woff2'],
  '/guides.js': ['guides.js', 'text/javascript; charset=utf-8'],
};

// ---------- display preferences (light/dark). Kept apart from config.json so changing them never restarts the bot ----------
export const MODES = ['system', 'light', 'dark'] as const;
/** resumeBot: start the bot again after an unexpected stop. startWithWindows: open Copybot when you log in (desktop app). */
export type UiPrefs = { mode: (typeof MODES)[number]; setupDone: boolean; resumeBot: boolean; startWithWindows: boolean };
export function loadUiPrefs(): UiPrefs {
  // Existing installs (a config already there) skip the first-run setup.
  const setupDefault = fs.existsSync('config.json');
  try {
    const j = JSON.parse(fs.readFileSync('data/ui.json', 'utf8')); // older versions stored a "theme" instead of "mode"
    return { mode: MODES.includes(j.mode) ? j.mode : 'system', setupDone: typeof j.setupDone === 'boolean' ? j.setupDone : setupDefault, resumeBot: j.resumeBot !== false, startWithWindows: j.startWithWindows === true };
  } catch {
    return { mode: 'system', setupDone: setupDefault, resumeBot: true, startWithWindows: false };
  }
}
export let uiPrefs = loadUiPrefs();
export const TOKEN = crypto.randomBytes(32).toString('base64url');

export const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https://coin-images.coingecko.com https://assets.geckoterminal.com https://cdn.dexscreener.com; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

// ---------- app updates (desktop app only; the Electron side drives these) ----------
export type Updater = { check: () => unknown; install: () => Promise<void> };
export const updater = (): Updater | null => (globalThis as any).__copybotUpdater ?? null;
export let updateState: unknown = { state: process.env.COPYBOT_DESKTOP ? 'idle' : 'disabled' };

/** Detect that the desktop app was just updated, so the UI can confirm it. */
export function detectVersionChange(): { from: string; to: string } | null {
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
export const justUpdated = detectVersionChange();
export function setUpdateState(s: unknown) {
  updateState = s;
  broadcast('update', s);
}

encryptPlaintextKey(); // desktop app: move any plain-text key into OS-encrypted storage
export const engine = new BotEngine();

// ---------- live updates (Server-Sent Events) ----------
export const clients = new Set<http.ServerResponse>();
export function broadcast(type: string, data: unknown) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
export let statusTimer: NodeJS.Timeout | null = null;
engine.on('log', (e) => broadcast('log', e));
engine.on('trade', (t) => broadcast('trade', t));
engine.on('config', (c) => broadcast('config', c));

// ---------- phone alerts ----------
export const alertQueue = new alerts.AlertQueue(async (text) => {
  const errs = await alerts.sendNow(text);
  if (errs.length) console.log('alert not sent:', errs.join('; '));
});
export function alert(kind: alerts.AlertKind, text: string) {
  if (!engine.cfg.alerts[kind] || !alerts.alertsConfigured()) return;
  alertQueue.push(`${engine.cfg.mode === 'live' ? '' : '[paper] '}${text}`, kind);
}
export const nameOf = (w: string) => engine.cfg.wallets.find((x) => x.address === w)?.label ?? `${w.slice(0, 4)}…${w.slice(-4)}`;
export const mintShort = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
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
export type Job = {
  id: number;
  kind: 'analyze' | 'discover' | 'scout' | 'backtest' | 'optimize' | 'compare' | 'health' | 'quickstart' | 'scannertest';
  status: 'queued' | 'running' | 'done' | 'error';
  progress: string;
  input: unknown;
  result?: unknown;
  error?: string;
  createdAt: number;
};
export const jobs: Job[] = [];
// Finished backtests are kept across restarts (the other jobs are quick to re-run).
export const BACKTESTS_FILE = 'data/backtests.json';
try {
  const saved = JSON.parse(fs.readFileSync(BACKTESTS_FILE, 'utf8'));
  if (Array.isArray(saved)) jobs.push(...saved.filter((j) => (j?.kind === 'backtest' || j?.kind === 'optimize' || j?.kind === 'compare') && j.status === 'done').slice(0, 12));
} catch {
  /* none yet */
}
export function saveBacktests() {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(BACKTESTS_FILE, JSON.stringify(jobs.filter((j) => (j.kind === 'backtest' || j.kind === 'optimize' || j.kind === 'compare') && j.status === 'done').slice(0, 12)));
}
export let jobSeq = jobs.reduce((a, j) => Math.max(a, j.id), 0);
export let jobChain: Promise<void> = Promise.resolve();

export function addJob(kind: Job['kind'], input: unknown, run: (progress: (p: string) => void) => Promise<unknown>) {
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
export class HttpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export function readTrades(limit = 500) {
  return readTradeLog().slice(-limit).reverse();
}

export function connectionInfo() {
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


// ---------- watchlist ----------
/** A Solana or Base token address. */
export const isTokenAddress = (a: unknown): a is string => isAddress(a) || (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a));
export const WATCHLIST = 'data/watchlist.json';
export function readWatchlist(): string[] {
  try {
    const l = JSON.parse(fs.readFileSync(WATCHLIST, 'utf8'));
    return Array.isArray(l) ? l.filter(isTokenAddress).slice(0, 30) : [];
  } catch {
    return [];
  }
}

export async function readBody(req: http.IncomingMessage, limit = 200_000): Promise<any> {
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

export function send(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

export const addressList = (v: unknown, max: number, what: string): string[] => {
  // Wallets may be Solana or Base (0x…, lowercased); tokens for "discover" are Solana only.
  const evm = what === 'wallet address';
  const list = (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean).map((s) => (evm && /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : s));
  if (!list.length) throw new HttpError(400, `Enter at least one ${what}`);
  if (list.length > max) throw new HttpError(400, `At most ${max} at a time`);
  const bad = list.find((s) => !isAddress(s) && !(evm && /^0x[0-9a-f]{40}$/.test(s))) as string | undefined;
  if (bad) throw new HttpError(400, `Not a valid ${what}: ${bad.slice(0, 50)}`);
  return [...new Set(list)];
};

export function tokenOk(given: string | undefined | null) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Restart the bot in the background after a settings change, if it was running. */
export async function applyChange(change: () => void) {
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
export function trialAndResume(next: import('./config').Config) {
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


export const chainForAddr = (a: string): import('./chains').ChainId => (/^0x[0-9a-fA-F]{40}$/.test(a) ? 'base' : 'solana');
/** What `raw` units of a token would sell for right now, in SOL per unit (any chain). */
export async function solPerUnit(mint: string, raw: bigint, slippageBps: number): Promise<number | null> {
  const c = getChainAdapter(chainForAddr(mint));
  const q = await c.quoteSell(mint, raw, slippageBps).catch(() => null);
  if (!q) return null;
  const sol = await c.nativeToSol(Number(q.outAmount) / 10 ** c.meta.native.decimals).catch(() => null);
  return sol == null ? null : sol / Number(raw);
}

/** For the routes: the module's own variables can only be changed from here. */
export const setUiPrefs = (v: typeof uiPrefs) => (uiPrefs = v);

// ---------- running all day: resume after unexpected stops, survive stray errors, daily backups ----------
/** The bot is running: remember it (and in which mode), so an unexpected stop can be recovered from. */
let savedRun = readRunState();
engine.on('status', () => {
  if (engine.running && (!savedRun?.running || savedRun.mode !== engine.cfg.mode)) {
    saveRunState(true, engine.cfg.mode);
    savedRun = readRunState();
  }
});
/** You stopped the bot (Stop, Sell everything, the phone, Stop and quit): it stays stopped next time too. */
export function userStopped() {
  saveRunState(false, engine.cfg.mode);
  savedRun = readRunState();
}
engine.on('guard', (msg: string) => {
  if (/Selling everything and stopping/.test(msg)) userStopped();
});
/** At startup: start the bot again if it was running when Copybot closed without you stopping it. */
export function resumeIfItWasRunning() {
  if (!shouldResume(readRunState(), engine.cfg.mode, uiPrefs.resumeBot)) return;
  engine.log(`Copybot closed while the bot was running (a crash, a restart or a power cut), so the bot is starting again (${engine.cfg.mode} mode). Turn this off in Settings → App.`, 'system');
  engine.start().catch((e) => engine.log(`Could not start the bot again: ${e.message}`, 'error'));
}

// One unexpected error shouldn't take the whole app down; a flood of them means something is badly wrong.
const burst = new ErrorBurst(20, 60_000);
let burstStopping = false;
function unexpected(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('unexpected error:', e);
  try {
    engine.log(`Unexpected error (Copybot kept running): ${msg}`, 'error');
  } catch {
    /* logging must never throw here */
  }
  if (burst.hit() && engine.running && !burstStopping) {
    burstStopping = true;
    engine.log('Too many unexpected errors in a minute: the bot is stopping to be safe. Open positions stay open; start it again when the problem is fixed.', 'error');
    engine
      .stop()
      .then(userStopped)
      .catch(() => {})
      .finally(() => (burstStopping = false));
  }
}
if (!process.listenerCount('uncaughtException')) process.on('uncaughtException', unexpected);
if (!process.listenerCount('unhandledRejection')) process.on('unhandledRejection', unexpected);

/** Once a day: a backup of settings, wallets and history (never keys), the last 7 kept; old copies trimmed. */
export function upkeep() {
  try {
    const wrote = dailyBackup(() => buildBackup(process.env.COPYBOT_VERSION ?? null));
    if (wrote) engine.log(`Daily backup saved (${wrote}). The last 7 are kept.`, 'system');
    trimOldCopies();
  } catch (e) {
    engine.log(`Daily backup failed: ${(e as Error).message}`, 'warn');
  }
}
setTimeout(upkeep, 60_000).unref();
setInterval(upkeep, 3_600_000).unref();
