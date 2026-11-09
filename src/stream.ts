/**
 * Fast trade detection with Helius Enhanced WebSockets (transactionSubscribe).
 * The normal path is: get notified of a signature, then fetch the transaction (an extra round
 * trip, sometimes retried). This stream delivers the full transaction straight away.
 * Optional: it only runs with a Helius RPC whose plan includes Enhanced WebSockets, and the normal
 * subscriptions and polling keep running as a backup either way.
 */
import { VersionedTransaction } from '@solana/web3.js';
import type { RawTx } from './util';

/** The Enhanced WebSocket address for a Helius RPC URL, or null if it isn't Helius. */
export function heliusWsUrl(rpc: string): string | null {
  try {
    const u = new URL(rpc);
    const key = u.searchParams.get('api-key');
    if (!/(^|\.)helius-rpc\.com$/.test(u.hostname) || !key) return null;
    const host = u.hostname.startsWith('devnet') ? 'devnet.helius-rpc.com' : 'mainnet.helius-rpc.com';
    return `wss://${host}/?api-key=${encodeURIComponent(key)}`;
  } catch {
    return null;
  }
}

/** Turn a transactionNotification result into the same shape getTx() returns. Handles jsonParsed and base64. */
export function parseNotification(result: any, now = Date.now()): RawTx | null {
  const sig = result?.signature;
  const t = result?.transaction;
  const meta = t?.meta;
  if (typeof sig !== 'string' || !meta) return null;
  let keys: string[] | null = null;
  const inner = t.transaction;
  if (Array.isArray(inner) && typeof inner[0] === 'string') {
    try {
      const vt = VersionedTransaction.deserialize(Buffer.from(inner[0], inner[1] === 'base58' ? 'base64' : 'base64'));
      const loaded = meta.loadedAddresses ?? { writable: [], readonly: [] };
      keys = [...vt.message.staticAccountKeys.map((k) => k.toBase58()), ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
    } catch {
      return null;
    }
  } else if (Array.isArray(inner?.message?.accountKeys)) {
    keys = inner.message.accountKeys.map((k: any) => (typeof k === 'string' ? k : k?.pubkey)).filter((k: unknown) => typeof k === 'string');
  }
  if (!keys?.length) return null;
  return {
    signature: sig,
    blockTime: typeof result.blockTime === 'number' ? result.blockTime : Math.floor(now / 1000),
    accountKeys: keys,
    meta: { err: meta.err ?? null, fee: meta.fee ?? 0, preBalances: meta.preBalances ?? [], postBalances: meta.postBalances ?? [], preTokenBalances: meta.preTokenBalances, postTokenBalances: meta.postTokenBalances },
  };
}

export type StreamStatus = 'connecting' | 'connected' | 'unavailable' | 'reconnecting' | 'off';

export class FastStream {
  status: StreamStatus = 'off';
  detail = '';
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private ping: NodeJS.Timeout | null = null;

  constructor(
    private url: string,
    private wallets: string[],
    private onTx: (tx: RawTx) => void,
    private onStatus: (s: StreamStatus, detail: string) => void,
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.set('off', '');
  }

  private set(s: StreamStatus, detail: string) {
    this.status = s;
    this.detail = detail;
    this.onStatus(s, detail);
  }

  private connect() {
    if (this.stopped) return;
    this.set(this.retry ? 'reconnecting' : 'connecting', '');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [{ accountInclude: this.wallets, failed: false, vote: false }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 1 }],
      }));
      if (this.ping) clearInterval(this.ping);
      // Keep the connection busy so idle timeouts don't drop it.
      this.ping = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getHealth' })), 20_000);
      this.ping.unref?.();
    };
    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.id === 1) {
        if (m.error) {
          // Usually: this plan doesn't include Enhanced WebSockets. Don't keep retrying.
          this.stopped = true;
          this.set('unavailable', String(m.error.message ?? 'subscription refused').slice(0, 120));
          ws.close();
        } else {
          this.retry = 0;
          this.set('connected', '');
        }
        return;
      }
      if (m.method === 'transactionNotification') {
        const tx = parseNotification(m.params?.result);
        if (tx) this.onTx(tx);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      if (this.stopped) return;
      this.retry++;
      setTimeout(() => this.connect(), Math.min(60_000, 2_000 * 2 ** Math.min(this.retry, 5))).unref?.();
      this.set('reconnecting', '');
    };
  }
}
