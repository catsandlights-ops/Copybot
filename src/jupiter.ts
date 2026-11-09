import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { jupKey, jupUrl } from './env';
import { WSOL } from './decode';
import { verifySwapTransaction } from './txguard';

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

export async function getQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote | null> {
  const url = new URL(`${jupUrl()}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('restrictIntermediateTokens', 'true');
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(10_000) });
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
export async function executeSwap(conn: Connection, kp: Keypair, quote: Quote, priorityLevel: string, maxPriorityLamports: number, jitoTipLamports = 0): Promise<string> {
  const res = await fetch(`${jupUrl()}/swap`, {
    method: 'POST',
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
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
  if (jitoTipLamports > 0) {
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
