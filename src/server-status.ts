/** Connection status of every outside service, and the live portfolio value series. */
import { writeAtomic } from './util';
import { Connection } from '@solana/web3.js';
import fs from 'node:fs';
import { chainOf } from './chains';
import { runChecks, summary as statusSummary, type Check, type CheckResult } from './status';
import { baseRpc } from './chains/base';
import { getChain as getChainAdapter } from './chains';
import { getQuote } from './jupiter';
import { pushPoint, type Pt } from './series';
import { backupRpcUrl } from './env';
import { makeConnection, rpcUrl } from './env';
import * as markets from './markets';
import { engine, broadcast } from './server-core';

// ---------- connection status: is every outside service working? ----------
export const usesBase = () => engine.cfg.wallets.some((w) => chainOf(w) === 'base');
export const statusChecks = (): Check[] => [
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
export type StatusSnap = { at: number; results: CheckResult[]; summary: ReturnType<typeof statusSummary> };
export let lastStatus: StatusSnap | null = null;
export let statusBusy: Promise<StatusSnap> | null = null;
export async function checkStatus() {
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
export const SERIES_FILE = (mode: string) => `data/series-${mode}.json`;
export const portfolio = new Map<string, Pt[]>();
export function portfolioSeries(mode: string): Pt[] {
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
export function portfolioValue(): number | null {
  const s = engine.snapshot();
  const open = s.positions.reduce((a: number, p: any) => a + (p.valueSol ?? p.costSol), 0);
  if (s.paper) return s.paper.startSol + s.realizedPnlSol + s.unrealizedPnlSol;
  return s.wallet?.balance == null ? null : s.wallet.balance + open;
}
export let seriesSaved = 0;
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
export const sparkCache = new Map<string, { at: number; pts: Pt[] }>();
export async function refreshSparks(coins: { mint: string; chain?: import('./chains').ChainId }[]) {
  for (const { mint: m, chain } of coins.slice(0, 5)) {
    const hit = sparkCache.get(m);
    if (hit && Date.now() - hit.at < 5 * 60_000) continue;
    const h = await markets.priceHistory(m, Date.now() - 6 * 3_600_000, Date.now(), chain ?? 'solana').catch(() => null);
    sparkCache.set(m, { at: Date.now(), pts: h ? h.candles.map((k) => [k.t, k.c] as Pt) : [] });
  }
  while (sparkCache.size > 60) sparkCache.delete(sparkCache.keys().next().value!);
}
export const orderCandles = new Map<string, { at: number; pts: Pt[] }>();
