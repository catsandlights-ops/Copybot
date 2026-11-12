/** Phone access: a separate, paired door into the app (see remote.ts). */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { saveConfig } from './config';
import * as remote from './remote';
import { describeOrder } from './orders';
import { chainOf } from './chains';
import { downsample, since } from './series';
import { UI_FILE, SECURITY_HEADERS, engine, broadcast, HttpError, readTrades, readBody, send, applyChange, trialAndResume } from './server-core';
import { scannerView } from './server-scanner';
import { lastStatus, portfolioSeries } from './server-status';
import { readGoLive } from './server-golive';
import { rampAdvice } from './golive';
import { walletRecords } from './rules';
import { localDayStart, phoneWalletId, phoneWallets, todayByChain } from './phone';
import * as markets from './markets';
import { getChain } from './chains';

// ---------- phone access (a separate door; see remote.ts) ----------
export let remoteCfg = remote.loadRemote();
export const pairing = new remote.Pairing();
export let remoteServer: http.Server | null = null;
export let remoteError: string | null = null;
export const PHONE_FILE = () => path.join(path.dirname(UI_FILE), 'phone.html');
export const PHONE_HEADERS = {
  ...SECURITY_HEADERS,
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: 'self'; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
export const PHONE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#7c3aed"/><path d="M18 40c8-20 22-22 30-24-2 8-4 22-24 30-3 1-6-2-6-6z" fill="#a8e07a"/><path d="M22 44l14-14" stroke="#3f7a3a" stroke-width="4" stroke-linecap="round"/></svg>`;
export const PHONE_MANIFEST = JSON.stringify({ name: 'Copybot', short_name: 'Copybot', start_url: '/', display: 'standalone', background_color: '#0f0b1e', theme_color: '#7c3aed', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] });

export function remoteView() {
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
export async function applyRemote() {
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

export let lastSeenSave = 0;
export async function handleRemoteSafe(req: http.IncomingMessage, res: http.ServerResponse) {
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

export async function handleRemote(req: http.IncomingMessage, res: http.ServerResponse) {
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
  if (route === 'POST /r/wallet/pause') {
    // Pausing only lowers risk, so the phone may do it; turning a wallet back on is done on the computer.
    const b = await readBody(req);
    const next = structuredClone(engine.cfg);
    const w = next.wallets.find((x) => x.enabled && phoneWalletId(x.address) === b.id);
    if (!w) throw new HttpError(404, 'That wallet is not being copied.');
    Object.assign(w, { enabled: false, pausedReason: `paused from ${device.name}` });
    await applyChange(() => saveConfig(next));
    from(`paused ${w.label}`);
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

// Coin names for the phone (looked up in the background, a few seconds behind at most).
const symbols = new Map<string, string>();
let symbolsAt = 0;
function coinNames(mints: string[]) {
  const missing = [...new Set(mints)].filter((m) => !symbols.has(m));
  if (missing.length && Date.now() - symbolsAt > 15_000) {
    symbolsAt = Date.now();
    markets
      .tokensAnyChain(missing.slice(0, 30))
      .then((list) => {
        for (const t of list as { mint: string; symbol?: string }[]) if (t?.mint) symbols.set(t.mint, t.symbol && t.symbol !== '?' ? t.symbol : '');
        if (symbols.size > 2000) symbols.clear();
      })
      .catch(() => {});
  }
  return (m: string) => symbols.get(m) || null;
}
// The Base trading wallet's ETH balance (live mode), refreshed at most once a minute.
let baseBal: { at: number; eth: number | null } = { at: 0, eth: null };
function baseBalance(): number | null {
  const c = getChain('base');
  const owner = engine.cfg.mode === 'live' && engine.cfg.execution.baseLive ? c.liveOwner?.() : null;
  if (!owner) return null;
  if (Date.now() - baseBal.at > 60_000) {
    baseBal.at = Date.now();
    c.balance({ conn: null as never, kp: null, cfg: engine.cfg }, owner).then((eth) => (baseBal = { at: Date.now(), eth })).catch(() => {});
  }
  return baseBal.eth;
}

/** What the phone sees: no keys, no wallet addresses, no settings beyond the scanner switches. */
export function phoneState() {
  const s = engine.snapshot();
  const sc = engine.cfg.scanner;
  const scan = scannerView();
  const all = readTrades(1e9);
  const name = coinNames([...s.positions.map((p: any) => p.mint), ...all.slice(0, 20).map((t: any) => t.mint)]);
  const rec = readGoLive();
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
    walletList: phoneWallets(engine.cfg.wallets, walletRecords(all, s.mode), s.shadow),
    today: todayByChain(all, s.mode, localDayStart(Date.now())),
    activity: s.activity,
    ramp: s.mode === 'live' ? rampAdvice(rec, all.filter((t: any) => t.mode === 'live' && t.side === 'sell'), Date.now()) : null,
    connection: lastStatus && lastStatus.summary.level !== 'ok' ? lastStatus.summary : null,
    baseBalance: baseBalance(),
    positions: s.positions.map((p: any) => ({ mint: p.mint, symbol: name(p.mint), chain: chainOf(p), from: p.label, costSol: p.costSol, valueSol: p.valueSol ?? null, pnlPct: p.pnlPct ?? null, openedAt: p.openedAt, trail: downsample(p.trail ?? [], 30) })),
    series: downsample(since(portfolioSeries(s.mode), Date.now() - 86_400_000), 120),
    logs: engine.logs.slice(-40).map((l) => ({ t: l.t, level: l.level, msg: l.msg })),
    trades: all
      .filter((t: any) => t.mode === s.mode)
      .slice(0, 20)
      .map((t: any) => ({ t: t.t, side: t.side, mint: t.mint, symbol: name(t.mint), chain: t.chain ?? (/^0x/.test(t.mint) ? 'base' : 'solana'), sol: t.sol, pnl: t.pnl ?? null, reason: t.reason ?? null })),
    scanner: { findTraders: sc.findTraders, tradeCoins: sc.tradeCoins, record: scan.record, signals: scan.signals.slice(0, 3).map((x) => ({ symbol: x.symbol, why: x.why })) },
  };
}
