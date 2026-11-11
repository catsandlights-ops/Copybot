/**
 * The common plug every blockchain fits into. Copybot's trading rules, strategies, exits, orders,
 * charts and reports don't care which chain they run on; everything that does lives behind this.
 *
 * Today there is one chain (Solana). Adding one (e.g. Base) means writing one more adapter that
 * fills in this interface, with its own transaction guard and token safety checks.
 */
import type { Connection, Keypair } from '@solana/web3.js';
import type { Config } from '../config';
import type { Swap } from '../decode';
import type { Quote } from '../jupiter';
import type { CheckResult } from '../safety';
import type { RawTx } from '../util';

/** Chains Copybot knows. New ones are added here as their adapters are written. */
export type ChainId = 'solana' | 'base';
export const DEFAULT_CHAIN: ChainId = 'solana';

/** Facts about a chain: names, units, where its data lives. No network calls. */
export type ChainMeta = {
  id: ChainId;
  name: string; // "Solana"
  native: { symbol: string; decimals: number; wrapped: string }; // SOL, 9, wSOL mint
  stable: { symbol: string; address: string }; // a USD stablecoin, for prices
  geckoNetwork: string; // GeckoTerminal network id
  dexscreenerId: string; // Dexscreener chainId
  nativeUsdPool: string; // the main native/USD pool on GeckoTerminal (price history and trend)
  keySecret: string; // the name the trading key is stored under
  isAddress: (s: unknown) => s is string; // valid wallet / token address on this chain
  explorer: { tx: (sig: string) => string; token: (address: string) => string; address: (address: string) => string };
};

/** Everything that talks to the chain itself. */
export type ChainContext = { conn: Connection; kp: Keypair | null; cfg: Config };
export type SwapExtras = { dynamicSlippage?: boolean; mevProtect?: boolean; onNote?: (m: string) => void };

export interface ChainAdapter {
  meta: ChainMeta;
  /** What a watched wallet did in a transaction: a buy or sell of a token, or nothing. */
  decodeSwap(tx: RawTx, wallet: string): Swap | null;
  /** Price a buy (native amount in its smallest unit) or a sell (token amount in its smallest unit). */
  quoteBuy(token: string, nativeRaw: bigint, slippageBps: number): Promise<Quote | null>;
  quoteSell(token: string, tokenRaw: bigint, slippageBps: number): Promise<Quote | null>;
  /** Build, check (transaction guard), sign, send and confirm a swap. Returns its transaction id. */
  executeSwap(ctx: ChainContext, quote: Quote, extras: SwapExtras): Promise<string>;
  /** The chain's token safety checks plus a buy-then-sell route test. */
  checkToken(ctx: ChainContext, token: string, nativeRaw: bigint): Promise<CheckResult>;
  /** Native balance of a wallet, in whole coins (e.g. SOL). */
  balance(ctx: ChainContext, owner: string): Promise<number>;
  /** One native coin in US dollars (null if unknown right now). */
  nativeUsd(): Promise<number | null>;
  /** Who created a token, for rug memory (optional: not every chain makes this cheap). */
  tokenCreator?(ctx: ChainContext, token: string): Promise<string | null>;
  /**
   * Copybot keeps its books in SOL. Amounts on other chains are converted at the current price
   * when they happen (identity on Solana).
   */
  nativeToSol(amount: number): Promise<number>;
  solToNativeRaw(sol: number): Promise<bigint>;
  /** Watch wallets for swaps (chains without Solana's log subscriptions poll). */
  watch?(wallets: string[], onSwap: (s: Swap) => void, onError: (e: Error) => void): { stop(): void };
  /** Can this chain place real trades right now? (false = paper mode only) */
  readonly liveTrading: boolean;
  /** The trading wallet's address on this chain, when it has its own key (not Solana's). */
  liveOwner?(): string | null;
  /** After a live swap: what was really bought or sold (from the confirmed transaction). */
  readFill?(hash: string, owner: string): Promise<{ tokenRaw: bigint; native: number } | null>;
  /** A trade sent but not confirmed in time: keep checking; true once it confirms, false if it failed or vanished. */
  settleLate?(hash: string): Promise<boolean>;
  /** How much of a token the wallet really holds (raw units), to sell what's there. */
  tokenBalance?(ctx: ChainContext, owner: string, token: string): Promise<bigint>;
}

/** Every chain id, for validating stored records (kept here so config can use it without import cycles). */
export const KNOWN_CHAINS: readonly ChainId[] = ['solana', 'base'];

/** Records written before chains existed have no chain: they are Solana. */
export const chainOf = (r: { chain?: string } | null | undefined): ChainId => ((KNOWN_CHAINS as readonly string[]).includes(r?.chain ?? '') ? (r!.chain as ChainId) : DEFAULT_CHAIN);
