import fs from 'node:fs';
import { rpcUrl } from './env';

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
      const r = await fetch(rpcUrl(), {
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
    if (res) {
      return {
        signature: res.transaction.signatures[0],
        blockTime: res.blockTime ?? null,
        accountKeys: res.transaction.message.accountKeys.map((k: any) => (typeof k === 'string' ? k : k.pubkey)),
        meta: res.meta,
      };
    }
    await sleep(400);
  }
  return null;
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
