import fs from 'node:fs';
import { rpcUrl, rpcFetch } from './env';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

/** An error that retrying won't fix (bad request, unsupported tx, …). */
export class PermanentError extends Error {}

/** Retry transient failures (rate limits, network errors) with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 6, baseMs = 500): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PermanentError || i >= tries - 1) throw e;
      await sleep(baseMs * 2 ** i);
    }
  }
}

/** Minimal transaction shape the decoder needs (works for every tx version). */
export type RawTx = {
  signature: string;
  blockTime: number | null;
  accountKeys: string[];
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBal[];
    postTokenBalances?: TokenBal[];
  } | null;
};
export type TokenBal = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
};

/**
 * Fetch a confirmed transaction via raw JSON-RPC. (web3.js's getParsedTransaction
 * rejects newer transaction versions.) Right after confirmation the RPC can
 * briefly return null, so retry a few times.
 */
export async function getTx(sig: string, tries = 8): Promise<RawTx | null> {
  for (let i = 0; i < tries; i++) {
    const res = await withRetry(async () => {
      const r = await rpcFetch(rpcUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 255 }],
        }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`RPC ${r.status}`);
      const j = (await r.json()) as { result?: any; error?: { message: string } };
      if (j.error) throw new PermanentError(j.error.message);
      return j.result;
    }, 5);
    if (res) return toRawTx(res);
    await sleep(400);
  }
  return null;
}

const toRawTx = (res: any): RawTx => ({
  signature: res.transaction.signatures[0],
  blockTime: res.blockTime ?? null,
  accountKeys: res.transaction.message.accountKeys.map((k: any) => (typeof k === 'string' ? k : k.pubkey)),
  meta: res.meta,
});

/** The node refused a batched request: Copybot goes back to one transaction per request. */
export class BatchUnsupported extends PermanentError {} // no point retrying: fall back at once
let batching = true;
export const batchingOn = () => batching;
export const setBatching = (on: boolean) => {
  batching = on;
};

/**
 * Several transactions in one request (most nodes, Helius included, accept JSON-RPC batches).
 * For each: the transaction, null if the node doesn't know it, or undefined if it failed.
 */
export async function getTxBatch(sigs: string[]): Promise<(RawTx | null | undefined)[]> {
  const reply = await withRetry(async () => {
    const r = await rpcFetch(rpcUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sigs.map((sig, id) => ({ jsonrpc: '2.0', id, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 255 }] }))),
    });
    if (r.status === 429 || r.status >= 500) throw new Error(`RPC ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!Array.isArray(j)) throw new BatchUnsupported(`batch requests not accepted (HTTP ${r.status})`);
    return j as { id: number; result?: any; error?: { message: string } }[];
  }, 5);
  const byId = new Map(reply.map((x) => [x.id, x]));
  return sigs.map((_, i) => {
    const x = byId.get(i);
    if (!x || x.error) return undefined;
    return x.result ? toRawTx(x.result) : null;
  });
}

/** Save a file so a crash can never leave it half-written: write a temporary copy, then swap it in. */
export function writeAtomic(file: string, data: string, opts: { mode?: number } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, opts.mode ? { mode: opts.mode } : undefined);
  fs.renameSync(tmp, file);
}

/** Run async jobs with a concurrency cap. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function appendJsonl(path: string, obj: unknown) {
  fs.mkdirSync('data', { recursive: true });
  fs.appendFileSync(path, JSON.stringify(obj) + '\n');
}
