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
export type SwapOpts = { dynamicSlippage?: boolean; mevProtect?: boolean; onNote?: (m: string) => void };

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
      try {
        const conf = await conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
        if (conf.value.err) throw new Error(`Swap ${sig} failed on-chain: ${JSON.stringify(conf.value.err)}`);
        return sig;
      } catch (e) {
        const st = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
        if (st?.confirmationStatus && !st.err) return sig;
        if (st?.err) throw e;
        // Not landed through Jito in time: the blockhash has expired, so nothing can land twice.
        throw new Error("The private (Jito) send didn't land in time. Nothing was traded; it will be tried again on the next signal.");
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
  try {
    const conf = await conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) throw new Error(`Swap ${sig} failed on-chain: ${JSON.stringify(conf.value.err)}`);
  } catch (e) {
    // Confirmation can time out even though the swap landed; check before giving up,
    // otherwise we'd lose track of tokens we actually bought.
    const st = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (!st || st.err || !st.confirmationStatus) throw e;
  }
  return sig;
}
