import type { RawTx } from './util';

export const WSOL = 'So11111111111111111111111111111111111111112';
export const STABLES: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};
const MIN_SOL_MOVE = 0.0001; // ignore dust movements

export type Swap = {
  signature: string;
  wallet: string;
  blockTime: number | null;
  side: 'buy' | 'sell';
  mint: string;
  decimals: number;
  tokenAmount: bigint; // absolute raw amount bought/sold
  tokenPre: bigint; // wallet's raw balance of the token before the tx
  tokenPost: bigint;
  quote: 'SOL' | 'USDC' | 'USDT';
  quoteAmount: number; // UI amount of SOL / stable spent or received
};

/**
 * Work out whether `wallet` swapped in this transaction, by comparing its balances
 * before and after. This works for any DEX (Raydium, Orca, Meteora, pump.fun,
 * Jupiter routes...) without decoding each program's instructions.
 */
export function decodeSwap(tx: RawTx, wallet: string): Swap | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = tx.accountKeys;
  const idx = keys.indexOf(wallet);
  if (idx < 0) return null;

  // Native SOL change, excluding the network fee if this wallet paid it.
  let lamports = BigInt(meta.postBalances[idx] - meta.preBalances[idx]);
  if (idx === 0) lamports += BigInt(meta.fee);

  type Bal = { mint: string; decimals: number; pre: bigint; post: bigint };
  const byMint = new Map<string, Bal>();
  const pre = (meta.preTokenBalances ?? []).filter((b) => b.owner === wallet);
  const post = (meta.postTokenBalances ?? []).filter((b) => b.owner === wallet);
  const preIdx = new Set(pre.map((b) => b.accountIndex));
  const postIdx = new Set(post.map((b) => b.accountIndex));

  const touch = (mint: string, decimals: number) => {
    let b = byMint.get(mint);
    if (!b) byMint.set(mint, (b = { mint, decimals, pre: 0n, post: 0n }));
    return b;
  };
  for (const b of pre) touch(b.mint, b.uiTokenAmount.decimals).pre += BigInt(b.uiTokenAmount.amount);
  for (const b of post) touch(b.mint, b.uiTokenAmount.decimals).post += BigInt(b.uiTokenAmount.amount);

  // Token accounts opened/closed in this tx move rent lamports; undo that so it
  // doesn't look like SOL was spent/received on the trade.
  let rentAdj = 0n;
  for (const b of post) {
    if (!preIdx.has(b.accountIndex)) {
      const native = b.mint === WSOL ? BigInt(b.uiTokenAmount.amount) : 0n;
      rentAdj += BigInt(meta.postBalances[b.accountIndex]) - native;
    }
  }
  for (const b of pre) {
    if (!postIdx.has(b.accountIndex)) {
      const native = b.mint === WSOL ? BigInt(b.uiTokenAmount.amount) : 0n;
      rentAdj -= BigInt(meta.preBalances[b.accountIndex]) - native;
    }
  }

  const wsol = byMint.get(WSOL);
  const wsolDelta = wsol ? wsol.post - wsol.pre : 0n;
  const solDelta = Number(lamports + wsolDelta + rentAdj) / 1e9;

  const others = [...byMint.values()].filter((b) => b.mint !== WSOL && !STABLES[b.mint] && b.post !== b.pre);
  if (others.length !== 1) return null; // not a simple single-token swap
  const t = others[0];
  const delta = t.post - t.pre;

  const stable = [...byMint.values()].find((b) => STABLES[b.mint] && b.post !== b.pre);
  const stableDelta = stable ? Number(stable.post - stable.pre) / 10 ** stable.decimals : 0;

  let quote: Swap['quote'];
  let quoteAmount: number;
  if (delta > 0n) {
    if (solDelta < -MIN_SOL_MOVE) [quote, quoteAmount] = ['SOL', -solDelta];
    else if (stable && stableDelta < 0) [quote, quoteAmount] = [STABLES[stable.mint] as Swap['quote'], -stableDelta];
    else return null; // received tokens without paying: transfer/airdrop
  } else {
    if (solDelta > MIN_SOL_MOVE) [quote, quoteAmount] = ['SOL', solDelta];
    else if (stable && stableDelta > 0) [quote, quoteAmount] = [STABLES[stable.mint] as Swap['quote'], stableDelta];
    else return null; // sent tokens without receiving: transfer
  }

  return {
    signature: tx.signature,
    wallet,
    blockTime: tx.blockTime,
    side: delta > 0n ? 'buy' : 'sell',
    mint: t.mint,
    decimals: t.decimals,
    tokenAmount: delta > 0n ? delta : -delta,
    tokenPre: t.pre,
    tokenPost: t.post,
    quote,
    quoteAmount,
  };
}
