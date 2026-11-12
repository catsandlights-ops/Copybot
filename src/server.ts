/**
 * Local control panel for the bot.
 *   npm run app      → browser version on http://localhost:4777
 *   desktop app      → Electron imports this module and calls startServer()
 *
 * Security model: the server only listens on 127.0.0.1, and every API request must
 * carry a random per-session token. Other programs and websites can't use the API
 * because they don't have the token.
 */

import { writeAtomic } from './util';
import http from 'node:http';
import { Connection } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { isAddress, sanitizeConfig, saveConfig, SCANNER_SOURCE } from './config';
import * as remote from './remote';
import QRCode from 'qrcode';
import { profitReport, taxCsv, taxRows, taxSummary, type Period } from './report';
import { makeOrder } from './orders';
import { chainOf } from './chains';
import { buildBackup, checkBackup, restoreBackup } from './backup';
import { baseRpc } from './chains/base';
import { alchemyUrl } from './chains/base-history';
import { getChain as getChainAdapter, isChainId as isChainIdFn } from './chains';
import { downsample, runningTotal, since, type Pt } from './series';
import { exitConfigFor } from './config';
import { applyRoles, currentLimits, rampAdvice, roundTrip, withLimits, type GoLiveRecord, type WalletRole } from './golive';
import { PublicKey } from '@solana/web3.js';
import { backupRpcUrl } from './env';
import { readSecret } from './env';
import { hasSecret, isHttpsUrl, saveSecret, jupKey, jupUrl, makeConnection, parseKeypair, rpcUrl, savePrivateKey, updateEnv } from './env';
import { fetchSwaps, score } from './analyze';
import { earlyBuyers, rankCandidates } from './discover';
import * as markets from './markets';
import { getSolUsd } from './market';
import { experimentPicks, healthVerdict, marketSkipReason } from './rules';
import * as ai from './ai';
import { getHolderStats } from './solscan';
import { runBacktest } from './backtest';
import { optimizeExits } from './optimize';
import { applyStrategy, compareStrategies, STRATEGIES, strategyById } from './strategies';
import { tradesCsv } from './csv';
import * as alerts from './alerts';
import { restartShadow, SHADOW } from './shadow';
import { pickTokens, pumpBuyers } from './scout';
import { UI_FILE, STATIC, MODES, uiPrefs, TOKEN, SECURITY_HEADERS, updater, updateState, justUpdated, engine, clients, broadcast, jobs, addJob, HttpError, readTrades, connectionInfo, isTokenAddress, WATCHLIST, readWatchlist, readBody, send, addressList, tokenOk, applyChange, trialAndResume, setUiPrefs } from './server-core';
import { lastWalletReview, walletReviewBusy, aiCandidates, runWalletReview, lastScout, measuredCopyGap, startScout } from './server-scout';
import { lastScannerTest, ENTRY_NAMES, scannerTestSummary, runScannerTest, scannerView } from './server-scanner';
import { HEALTH_FILE, HealthRow, lastHealth, backtestSpec, loadBacktestData, resetPaper, learning, currentLearning, saveLearning, journal, learnRound, learningView, applyExits, lastTune, saveTune, runAutoTune, setLastTune, setLastHealth } from './server-learning';
import { GOLIVE_FILE, goLiveTesting, readGoLive, goLivePlan, readinessReport, setGoLiveTesting } from './server-golive';
import { lastStatus, checkStatus, portfolioSeries, orderCandles } from './server-status';
import { remoteCfg, pairing, remoteServer, remoteView, applyRemote } from './server-phone';
export { engine, setUpdateState, TOKEN } from './server-core';

const PORT = Number(process.env.PORT || 4777);
const HOST = '127.0.0.1';
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

  if (route === 'GET /api/readiness') return send(res, 200, readinessReport());

  // ---------- the go-live assistant ----------
  if (route === 'GET /api/golive') return send(res, 200, await goLivePlan());
  if (route === 'GET /api/golive/ramp') {
    const rec = readGoLive();
    return send(res, 200, { record: rec, ramp: rampAdvice(rec, readTrades(1e9).filter((t: any) => t.mode === 'live' && t.side === 'sell'), Date.now()) });
  }
  if (route === 'POST /api/golive/test') {
    // A real, tiny round trip (native → USDC → native) proving the trading wallet works.
    const b = await readBody(req);
    const chainId = b.chain === 'base' ? 'base' : 'solana';
    if (goLiveTesting) throw new HttpError(409, 'A test trade is already running.');
    const chain = getChainAdapter(chainId);
    const owner = chainId === 'solana' ? engine.kp?.publicKey.toBase58() : chain.liveOwner?.();
    if (!owner) throw new HttpError(400, chainId === 'solana' ? 'Add a Solana trading wallet first (Settings → Trading wallet).' : 'Add a Base trading key first (Settings → Trading wallet).');
    setGoLiveTesting(true);
    try {
      const amount = chainId === 'solana' ? 0.01 : 0.0005;
      engine.log(`Go-live test: swapping ${amount} ${chain.meta.native.symbol} to ${chain.meta.stable.symbol} and back, with real money, to check the ${chain.meta.name} trading wallet works.`, 'system');
      const r = await roundTrip(chain, engine.chainCtx(), owner, amount);
      if (r.ok) engine.log(`Go-live test on ${chain.meta.name} passed in ${r.seconds}s; it cost ${Number.isFinite(r.costNative) ? `${r.costNative.toFixed(6)} ${chain.meta.native.symbol}` : 'a few cents'} in fees.${r.note}`, 'system');
      else engine.log(`Go-live test on ${chain.meta.name} failed at the ${r.step} step: ${r.error}`, 'warn');
      return send(res, 200, r);
    } finally {
      setGoLiveTesting(false);
    }
  }
  if (route === 'POST /api/golive/apply') {
    // The switch: starter limits (optional), which wallets copy for real, Base on or off, then live.
    const b = await readBody(req);
    const plan = await goLivePlan();
    if (!plan.wallets.solana.hasKey && !(b.baseLive && plan.wallets.base.hasKey)) throw new HttpError(400, 'Add a trading wallet first (Settings → Trading wallet).');
    const roles: Record<string, WalletRole> = {};
    for (const [a, r] of Object.entries(b.roles ?? {})) if (engine.cfg.wallets.some((w) => w.address === a) && (r === 'live' || r === 'shadow' || r === 'off')) roles[a] = r;
    let next = applyRoles(engine.cfg, roles, Date.now());
    const before = currentLimits(engine.cfg);
    const starter = b.starter ? plan.starter.limits : null;
    if (starter) next = withLimits(next, starter);
    next.execution.baseLive = !!b.baseLive && plan.wallets.base.hasKey;
    next.mode = 'live';
    const cfg = sanitizeConfig(next, true);
    trialAndResume(cfg);
    const rec: GoLiveRecord = { at: Date.now(), before, starter };
    fs.mkdirSync('data', { recursive: true });
    writeAtomic(GOLIVE_FILE, JSON.stringify(rec));
    await applyChange(() => saveConfig(cfg));
    const live = Object.values(roles).filter((r) => r === 'live').length;
    engine.log(`Live mode on (go-live assistant): ${live} wallet${live === 1 ? '' : 's'} copied for real${Object.values(roles).some((r) => r === 'shadow') ? ', the others in shadow until they prove themselves' : ''}${starter ? `; starter limits: ${starter.fixedSol} SOL per trade, ${starter.maxOpenPositions} coins at once` : ''}${cfg.execution.baseLive ? '; Base live on' : ''}.`, 'system');
    return send(res, 200, { config: engine.cfg, status: engine.snapshot() });
  }
  if (route === 'POST /api/golive/restore') {
    const rec = readGoLive();
    if (!rec?.starter || rec.restoredAt) throw new HttpError(400, 'There are no starter limits to undo.');
    const cfg = sanitizeConfig(withLimits(engine.cfg, rec.before), true);
    writeAtomic(GOLIVE_FILE, JSON.stringify({ ...rec, restoredAt: Date.now() }));
    await applyChange(() => saveConfig(cfg));
    engine.log(`Normal limits are back: ${rec.before.fixedSol} SOL per trade, up to ${rec.before.maxOpenPositions} coins at once.`, 'system');
    return send(res, 200, { config: engine.cfg });
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

  if (route === 'POST /api/positions/writeoff') {
    // A dead (rugged) coin: close it in the books as a total loss, without selling, to free its slot.
    const b = await readBody(req);
    if (typeof b.mint !== 'string' || !Object.hasOwn(engine.state.positions, b.mint)) throw new HttpError(400, 'No open position for that token');
    await engine.writeOff(b.mint);
    return send(res, 200, engine.snapshot());
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
    setUiPrefs({ mode: b.mode ?? uiPrefs.mode, setupDone: b.setupDone ?? uiPrefs.setupDone });
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
    setLastTune({ ...lastTune!, status: 'fine', message: `You switched to "${best.name}". The next check is in a week.`, dismissed: true });
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
      setLastHealth({ at: Date.now(), period: base.range!, delayPct, wallets: rows });
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
