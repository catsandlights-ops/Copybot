/**
 * Solana: the first chain adapter. A thin wrapper around Copybot's existing, tested Solana code
 * (transaction decoding, Jupiter quotes and swaps, the transaction guard, token safety checks).
 */
import { PublicKey } from '@solana/web3.js';
import { isAddress } from '../config';
import { decodeSwap, WSOL } from '../decode';
import { executeSwap, quoteBuy, quoteSell, solLateReceipt } from '../jupiter';
import { makeConnection } from '../env';
import { getSolUsd } from '../market';
import { checkToken, tokenCreator } from '../safety';
import type { ChainAdapter, ChainMeta } from './types';

export const SOLANA_META: ChainMeta = {
  id: 'solana',
  name: 'Solana',
  native: { symbol: 'SOL', decimals: 9, wrapped: WSOL },
  stable: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  geckoNetwork: 'solana',
  dexscreenerId: 'solana',
  nativeUsdPool: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', // Raydium SOL/USDC
  keySecret: 'PRIVATE_KEY', // kept as it always was, so existing installs keep their key
  isAddress,
  explorer: {
    tx: (sig) => `https://solscan.io/tx/${sig}`,
    token: (a) => `https://solscan.io/token/${a}`,
    address: (a) => `https://solscan.io/account/${a}`,
  },
};

export const solana: ChainAdapter = {
  meta: SOLANA_META,
  decodeSwap,
  quoteBuy,
  quoteSell,
  executeSwap: (ctx, quote, extras) => {
    if (!ctx.kp) throw new Error('Live mode needs a trading wallet (Settings → Trading wallet).');
    const x = ctx.cfg.execution;
    return executeSwap(ctx.conn, ctx.kp, quote, x.priorityLevel, x.priorityFeeMaxLamports, x.jitoTipLamports, extras);
  },
  checkToken: (ctx, token, nativeRaw) => checkToken(ctx.conn, ctx.cfg, token, nativeRaw),
  balance: async (ctx, owner) => (await ctx.conn.getBalance(new PublicKey(owner))) / 1e9,
  async tokenBalance(ctx, owner, mint) {
    const r = await ctx.conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
    return r.value.reduce((a, x) => a + BigInt(x.account.data.parsed?.info?.tokenAmount?.amount ?? '0'), 0n);
  },
  settleLate: (hash) => solLateReceipt(makeConnection(), hash),
  nativeUsd: () => getSolUsd(),
  tokenCreator: (ctx, token) => tokenCreator(ctx.conn, token),
  nativeToSol: async (x) => x,
  solToNativeRaw: async (sol) => BigInt(Math.round(sol * 1e9)),
  liveTrading: true,
};
