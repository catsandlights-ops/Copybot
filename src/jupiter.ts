import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { jupKey, jupUrl } from './env';
import { WSOL } from './decode';
import { verifySwapTransaction } from './txguard';
import bs58 from 'bs58';

const bs58encode = (b: Uint8Array) => bs58.encode(b);

export type Quote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  [k: string]: unknown;
};

const headers = (): Record<string, string> => ({
  'content-type': 'application/json',
  ...(jupKey() ? { 'x-api-key': jupKey() } : {}),
});

/** USD prices for many Solana tokens in one request (Jupiter's price service). Missing ones are left out. */
export async function getPrices(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const base = jupUrl().replace(/\/swap\/v\d+$/, '/price/v3');
  for (let i = 0; i < mints.length; i += 50) {
    const ids = [...new Set(mints.slice(i, i + 50))].join(',');
    const res = await fetch(`${base}?ids=${ids}`, { headers: headers(), signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(res.status === 429 ? 'Jupiter is busy (HTTP 429); try again in a moment' : `Jupiter prices: HTTP ${res.status}`);
    const j = (await res.json()) as Record<string, { usdPrice?: number } | null>;
    for (const [m, v] of Object.entries(j)) if (v && typeof v.usdPrice === 'number' && v.usdPrice > 0) out.set(m, v.usdPrice);
  }
  return out;
}

export async function getQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote | null> {
  const url = new URL(`${jupUrl()}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('restrictIntermediateTokens', 'true');
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(10_000) });
  // Busy or down is not the same as "no route": say so, instead of calling a good token a honeypot.
  if (res.status === 429 || res.status >= 500) throw new Error(`Jupiter is busy (HTTP ${res.status}); try again in a moment`);
  if (!res.ok) return null; // usually "no route found"
  const q = (await res.json()) as Quote;
  // Only accept a quote for exactly what we asked for.
  const matches =
    q?.inputMint === inputMint &&
    q.outputMint === outputMint &&
    q.inAmount === amount.toString() &&
    q.swapMode === 'ExactIn' &&
    Number(q.slippageBps) <= slippageBps &&
    /^\d+$/.test(q.outAmount ?? '');
  return matches ? q : null;
}

export const quoteBuy = (mint: string, lamports: bigint, slip: number) => getQuote(WSOL, mint, lamports, slip);
export const quoteSell = (mint: string, raw: bigint, slip: number) => getQuote(mint, WSOL, raw, slip);

/** Build, verify, sign, send and confirm a swap. Returns the transaction signature. */
const JITO_SEND = 'https://mainnet.block-engine.jito.wtf/api/v1/transactions';

/**
 * Build, verify, sign, send and confirm a swap. Returns the transaction signature.
 * With a Jito tip, the swap pays that tip instead of a priority fee and is sent to Jito's block
 * engine as well as your RPC (same signature, so it can only land once).
 */
export type SwapOpts = { dynamicSlippage?: boolean; mevProtect?: boolean; onNote?: (m: string) => void; onSent?: (sig: string) => void };

/** Sent, but the node was too busy to tell whether it landed before it expired; followed up later (see trader). */
export class SolPendingError extends Error {
  constructor(readonly pendingHash: string) {
    super(`Solana transaction ${pendingHash} was sent, but the network was too busy to confirm it. Remora keeps checking and adds it to your books if it went through.`);
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a sent transaction lands or provably expires. While waiting, the same signed
 * transaction is re-sent every 2 s (it can only execute once), which helps it land on a busy
 * network. Node errors on the way don't count as a failure: only an on-chain error, or the
 * blockhash expiring without it landing, does. If the node can't tell us at all, it's followed up later.
 */
export async function landOrExpire(conn: Connection, sig: string, lastValidBlockHeight: number, resend: (() => Promise<unknown>) | null, timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let height: number | null = null;
  while (Date.now() < until) {
    const st = await conn.getSignatureStatuses([sig]).then((r) => r.value[0], () => undefined);
    if (st?.err) throw new Error(`Swap ${sig} failed on-chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return;
    height = await conn.getBlockHeight('confirmed').catch(() => height);
    if (height != null && height > lastValidBlockHeight) {
      // Expired: one last look in history (it may have landed just before), then it's final.
      const last = await conn.getSignatureStatus(sig, { searchTransactionHistory: true }).then((r) => r.value, () => undefined);
      if (last && !last.err && last.confirmationStatus) return;
      if (last?.err) throw new Error(`Swap ${sig} failed on-chain: ${JSON.stringify(last.err)}`);
      if (last === null) throw new Error("The trade didn't land before it expired (the network was busy), so nothing was traded. It's tried again on the next signal.");
      break; // the node can't answer: follow it up later
    }
    if (resend) await resend().catch(() => null);
    await pause(2_000);
  }
  throw new SolPendingError(sig);
}

/** A trade that couldn't be confirmed in time: true once it's seen landed, false once it certainly can't. */
export async function solLateReceipt(conn: Connection, sig: string, maxMs = 5 * 60_000, everyMs = 10_000): Promise<boolean> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true }).then((r) => r.value, () => undefined);
    if (st?.err) return false;
    if (st?.confirmationStatus) return true;
    await pause(everyMs);
  }
  return false; // well past its expiry and still unknown: it never landed
}

export async function executeSwap(conn: Connection, kp: Keypair, quote: Quote, priorityLevel: string, maxPriorityLamports: number, jitoTipLamports = 0, opts: SwapOpts = {}): Promise<string> {
  const res = await fetch(`${jupUrl()}/swap`, {
    method: 'POST',
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // Slippage worked out per trade by Jupiter, never above the maximum in the quote.
      ...(opts.dynamicSlippage ? { dynamicSlippage: true } : {}),
      prioritizationFeeLamports: jitoTipLamports > 0 ? { jitoTipLamports } : { priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel } },
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap request failed (${res.status})`);
  const { swapTransaction, lastValidBlockHeight } = (await res.json()) as { swapTransaction: string; lastValidBlockHeight: number };
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));

  // Never sign a transaction we haven't verified.
  await verifySwapTransaction(conn, tx, {
    wallet: kp.publicKey,
    inputMint: quote.inputMint,
    inAmount: BigInt(quote.inAmount),
    maxPriorityLamports,
    maxTipLamports: jitoTipLamports,
  });

  tx.sign([kp]);
  const raw = tx.serialize();
  // Front-running protection: send only to Jito as a one-transaction bundle, so the swap never
  // sits where bots can see it. If Jito won't take it, fall back to the normal send.
  if (opts.mevProtect && jitoTipLamports > 0) {
    const ok = await fetch(`${JITO_SEND}?bundleOnly=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [Buffer.from(raw).toString('base64'), { encoding: 'base64' }] }),
      signal: AbortSignal.timeout(5_000),
    })
      .then(async (r) => r.ok && !(await r.json().catch(() => ({})))?.error)
      .catch(() => false);
    if (ok) {
      const sig = bs58encode(tx.signatures[0]);
      opts.onSent?.(sig);
      try {
        await landOrExpire(conn, sig, lastValidBlockHeight, null);
        return sig;
      } catch (e) {
        if (/didn't land before it expired/.test((e as Error).message)) throw new Error("The private (Jito) send didn't land in time. Nothing was traded; it will be tried again on the next signal.");
        throw e;
      }
    }
    opts.onNote?.("Jito didn't accept the private send; sent the normal way instead.");
  }
  if (jitoTipLamports > 0 && !opts.mevProtect) {
    await fetch(JITO_SEND, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [Buffer.from(raw).toString('base64'), { encoding: 'base64' }] }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null); // the RPC send below is the fallback
  }
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  opts.onSent?.(sig);
  await landOrExpire(conn, sig, lastValidBlockHeight, () => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }));
  return sig;
}
