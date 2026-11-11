/**
 * Base (Coinbase's Ethereum layer-2): the second chain adapter. Paper mode only for now.
 *
 *   watching:  polls Base for token transfers to or from your wallets, then decodes the swap
 *   prices:    KyberSwap's aggregator (no key needed)
 *   safety:    GoPlus token security (honeypot, taxes, pausable, blacklist, owner powers)
 *              plus the same buy-then-sell route test as Solana
 *   books:     ETH amounts are converted to SOL at the current price, so limits, profit,
 *              charts and reports work unchanged
 */
import type { Swap } from '../decode';
import { hasSecret, readSecret } from '../env';
import { privateKeyToAccount } from 'viem/accounts';

const baseAccountAddress = (k: string) => privateKeyToAccount((k.trim().startsWith('0x') ? k.trim() : `0x${k.trim()}`) as `0x${string}`).address.toLowerCase();
import type { Quote } from '../jupiter';
import { getSolUsd } from '../market';
import { swapsFromTransfers, toSwaps, walletTransfers } from './base-history';
import { addrTopic, decodeEvmSwap, EvmRpc, isEvmAddress, NATIVE_PLACEHOLDER, TRANSFER_TOPIC, type EvmSwap } from './evm';
import type { ChainAdapter, ChainMeta } from './types';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const STABLES: Record<string, string> = { [USDC]: 'USDC', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDC' /* USDbC */ };
const STABLE_DECIMALS = 6;

export const BASE_META: ChainMeta = {
  id: 'base',
  name: 'Base',
  native: { symbol: 'ETH', decimals: 18, wrapped: WETH },
  stable: { symbol: 'USDC', address: USDC },
  geckoNetwork: 'base',
  dexscreenerId: 'base',
  nativeUsdPool: '0x6c561b446416e1a00e8e93e221854d6ea4171372', // WETH/USDC 0.3%
  keySecret: 'BASE_PRIVATE_KEY',
  isAddress: isEvmAddress,
  explorer: {
    tx: (h) => `https://basescan.org/tx/${h}`,
    token: (a) => `https://basescan.org/token/${a}`,
    address: (a) => `https://basescan.org/address/${a}`,
  },
};

/** Your own Base RPC (Settings → Connection) first, then free public nodes. */
export const baseRpc = new EvmRpc(() => [process.env.BASE_RPC_URL?.trim(), 'https://base.drpc.org', 'https://mainnet.base.org'].filter((u): u is string => !!u));

// ---------------- prices (KyberSwap) ----------------
const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1/routes';

async function kyberQuote(tokenIn: string, tokenOut: string, amountIn: bigint, slippageBps: number): Promise<Quote | null> {
  if (amountIn <= 0n) return null;
  const url = `${KYBER}?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  const res = await fetch(url, { headers: { 'x-client-id': 'copybot', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 429 || res.status >= 500) throw new Error(`KyberSwap is busy (HTTP ${res.status}); try again in a moment`);
  if (!res.ok) return null; // no route
  const j = (await res.json()) as { code?: number; data?: { routeSummary?: { amountIn: string; amountOut: string } } };
  const r = j?.data?.routeSummary;
  if (j.code !== 0 || !r || !/^\d+$/.test(r.amountOut ?? '') || r.amountIn !== amountIn.toString()) return null;
  const side = (t: string) => (t.toLowerCase() === NATIVE_PLACEHOLDER ? WETH : t.toLowerCase());
  return { inputMint: side(tokenIn), outputMint: side(tokenOut), inAmount: r.amountIn, outAmount: r.amountOut, otherAmountThreshold: r.amountOut, swapMode: 'ExactIn', slippageBps, routeSummary: r };
}

let ethPrice: { at: number; usd: number } | null = null;
async function ethUsd(): Promise<number | null> {
  if (ethPrice && Date.now() - ethPrice.at < 60_000) return ethPrice.usd;
  const q = await kyberQuote(NATIVE_PLACEHOLDER, USDC, 10n ** 18n, 50).catch(() => null);
  if (!q) return ethPrice?.usd ?? null;
  ethPrice = { at: Date.now(), usd: Number(q.outAmount) / 10 ** STABLE_DECIMALS };
  return ethPrice.usd;
}

/** How many SOL one ETH is worth right now. */
async function solPerEth(): Promise<number> {
  const [e, s] = await Promise.all([ethUsd(), getSolUsd()]);
  if (!e || !s) throw new Error("couldn't get the ETH or SOL price to convert this Base trade");
  return e / s;
}

// ---------------- token safety (GoPlus) ----------------
type GoPlus = Record<string, string | undefined>;
const goplusCache = new Map<string, { at: number; v: GoPlus | null }>();
async function goplus(token: string): Promise<GoPlus | null> {
  const key = token.toLowerCase();
  const hit = goplusCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${key}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`token security check unavailable (${res.status})`);
  const j = (await res.json()) as { result?: Record<string, GoPlus> };
  const v = j?.result?.[key] ?? null;
  goplusCache.set(key, { at: Date.now(), v });
  if (goplusCache.size > 1000) goplusCache.delete(goplusCache.keys().next().value!);
  return v;
}

/** Why GoPlus's findings make a token unsafe to buy, or null. Pure (unit-tested). */
export function goplusSkipReason(g: GoPlus | null, rejectMintable: boolean, maxTaxPct = 10): string | null {
  if (!g) return null;
  const yes = (k: string) => g[k] === '1';
  if (yes('is_honeypot')) return 'honeypot: it can be bought but not sold (GoPlus)';
  if (yes('cannot_sell_all')) return "holders can't sell all their tokens (GoPlus)";
  const buyTax = Number(g.buy_tax || 0) * 100;
  const sellTax = Number(g.sell_tax || 0) * 100;
  if (sellTax > maxTaxPct || buyTax > maxTaxPct) return `trading tax too high: ${buyTax.toFixed(0)}% to buy, ${sellTax.toFixed(0)}% to sell (GoPlus)`;
  if (yes('transfer_pausable')) return 'its owner can pause transfers (GoPlus)';
  if (yes('is_blacklisted')) return 'its owner can block wallets from selling (GoPlus)';
  if (yes('owner_change_balance')) return 'its owner can change balances (GoPlus)';
  if (yes('hidden_owner')) return 'it has a hidden owner (GoPlus)';
  if (yes('slippage_modifiable')) return 'its owner can change the trading tax (GoPlus)';
  if (rejectMintable && yes('is_mintable')) return 'more can still be minted (GoPlus)';
  return null;
}

const decimalsCache = new Map<string, number>();
async function decimalsOf(token: string): Promise<number> {
  const k = token.toLowerCase();
  if (!decimalsCache.has(k)) decimalsCache.set(k, await baseRpc.decimals(k));
  return decimalsCache.get(k)!;
}

// ---------------- watching wallets ----------------

/** A decoded Base swap, in Copybot's usual shape (amounts converted to SOL). */
async function toSwap(s: EvmSwap): Promise<Swap> {
  const decimals = await decimalsOf(s.token).catch(() => 18);
  // Their balance after the swap (at that block), to work out what share they sold.
  const post = await baseRpc.balanceOf(s.token, s.wallet, s.blockNumber).catch(() => baseRpc.balanceOf(s.token, s.wallet).catch(() => 0n));
  const pre = s.side === 'sell' ? post + s.tokenRaw : post > s.tokenRaw ? post - s.tokenRaw : 0n;
  const nativeAmount = s.quote === 'native' ? Number(s.quoteRaw) / 1e18 : undefined;
  const quoteAmount = s.quote === 'native' ? nativeAmount! * (await solPerEth()) : Number(s.quoteRaw) / 10 ** STABLE_DECIMALS;
  return {
    chain: 'base',
    signature: s.hash,
    wallet: s.wallet,
    blockTime: s.blockTime,
    side: s.side,
    mint: s.token,
    decimals,
    tokenAmount: s.tokenRaw,
    tokenPre: pre,
    tokenPost: s.side === 'sell' ? post : post,
    quote: s.quote === 'native' ? 'SOL' : 'USDC',
    quoteAmount,
    nativeAmount,
  };
}

function watch(wallets: string[], onSwap: (s: Swap) => void, onError: (e: Error) => void) {
  let stopped = false;
  const watched = wallets.map((w) => w.toLowerCase());
  const topics = watched.map(addrTopic);
  const seen = new Set<string>();
  const blockTimes = new Map<number, number>();
  (async () => {
    let last = 0;
    let errors = 0;
    while (!stopped) {
      try {
        const head = await baseRpc.blockNumber();
        if (!last) last = head; // start from now: only new trades are copied
        else if (head > last) {
          const range = { fromBlock: '0x' + Math.max(last + 1, head - 30).toString(16), toBlock: '0x' + head.toString(16) };
          const [into, outOf] = await Promise.all([
            baseRpc.call<any[]>('eth_getLogs', [{ ...range, topics: [TRANSFER_TOPIC, null, topics] }]),
            baseRpc.call<any[]>('eth_getLogs', [{ ...range, topics: [TRANSFER_TOPIC, topics] }]),
          ]);
          const hashes = [...new Set([...into, ...outOf].map((l) => l.transactionHash as string))].filter((h) => !seen.has(h));
          for (const h of hashes) {
            if (stopped) return;
            seen.add(h);
            const tx = await baseRpc.fullTx(h, blockTimes);
            if (!tx) continue;
            for (const w of watched) {
              let s = decodeEvmSwap(tx, w, WETH, STABLES);
              // Paid or paid out in plain ETH (no log of it): check the wallet's ETH balance change.
              if (!s && tx.from.toLowerCase() === w) s = decodeEvmSwap(tx, w, WETH, STABLES, await baseRpc.nativeDelta(w, tx.blockNumber, tx.fee ?? 0n));
              if (s) onSwap(await toSwap(s));
            }
          }
          if (seen.size > 5000) for (const h of [...seen].slice(0, 2500)) seen.delete(h);
          last = head;
        }
        errors = 0;
      } catch (e) {
        errors++;
        onError(e as Error);
      }
      // Every 3 s; after errors (e.g. the public node rate-limiting), wait longer, up to 30 s.
      await new Promise((r) => setTimeout(r, Math.min(30_000, 3000 * 2 ** errors)));
    }
  })();
  return { stop: () => (stopped = true) };
}

// ---------------- a wallet's history (Analyze, backtests, the finder) ----------------

/**
 * A Base wallet's swaps from the last `maxTxs` trades (or since a date), via Alchemy. Sells paid
 * out in plain ETH that Alchemy doesn't list are worked out from the wallet's ETH balance change.
 */
export async function fetchBaseSwaps(wallet: string, maxTxs: number, opts: { since?: number; until?: number; stats?: { read: number; failed: number }; onProgress?: (n: number, t: number) => void } = {}): Promise<Swap[]> {
  const head = await baseRpc.blockNumber();
  const now = Date.now();
  // Base makes a block every 2 seconds: turn the start date into a block number (default: the last 30 days).
  const sinceBlock = head - Math.ceil(((now - (opts.since ?? now - 30 * 86_400_000)) / 1000) / 2);
  const transfers = await walletTransfers(wallet, sinceBlock, Math.max(1000, maxTxs * 4), (n) => opts.onProgress?.(n, n));
  let hs = swapsFromTransfers(transfers, wallet, WETH, new Set(Object.keys(STABLES)));
  if (opts.until) hs = hs.filter((h) => !h.blockTime || h.blockTime * 1000 <= opts.until!);
  hs = hs.slice(-maxTxs);
  // Proceeds paid in plain ETH: read the balance change (only for a limited number, to stay fast).
  let unknown = 0;
  for (const h of hs.filter((x) => x.quote === 'unknown').slice(-150)) {
    const rc = await baseRpc.call<any>('eth_getTransactionReceipt', [h.hash]).catch(() => null);
    const fee = rc ? BigInt(rc.gasUsed ?? 0) * BigInt(rc.effectiveGasPrice ?? 0) + BigInt(rc.l1Fee ?? 0) : 0n;
    const d = rc && rc.from?.toLowerCase() === wallet.toLowerCase() ? await baseRpc.nativeDelta(wallet, h.block, fee).catch(() => undefined) : undefined;
    if (d != null && d > 0n) {
      h.quote = 'native';
      h.quoteRaw = d;
    } else unknown++;
  }
  if (opts.stats) {
    opts.stats.read += hs.length;
    opts.stats.failed += unknown;
  }
  return toSwaps(hs, wallet, await solPerEth());
}

// ---------------- the adapter ----------------

/** Live trading on Base: only when turned on in Settings and a Base trading key is saved. */
let liveOn = false;
export const setBaseLive = (on: boolean) => (liveOn = on);
function baseKey(): string | null {
  return readSecret('BASE_PRIVATE_KEY', 'Base trading key');
}

export const base: ChainAdapter = {
  meta: BASE_META,
  get liveTrading() {
    return liveOn && hasSecret('BASE_PRIVATE_KEY');
  },
  liveOwner() {
    try {
      const k = baseKey();
      return k ? baseAccountAddress(k) : null;
    } catch {
      return null;
    }
  },
  async readFill(hash, owner) {
    const tx = await baseRpc.fullTx(hash, new Map());
    if (!tx) return null;
    let s = decodeEvmSwap(tx, owner, WETH, STABLES);
    if (!s) s = decodeEvmSwap(tx, owner, WETH, STABLES, await baseRpc.nativeDelta(owner, tx.blockNumber, tx.fee ?? 0n));
    return s && s.quote === 'native' ? { tokenRaw: s.tokenRaw, native: Number(s.quoteRaw) / 1e18 } : null;
  },
  async settleLate(hash) {
    const { lateReceipt } = await import('./base-live');
    return lateReceipt(hash);
  },
  tokenBalance: async (_ctx, owner, token) => BigInt(await baseRpc.balanceOf(token, owner)),
  decodeSwap: () => null, // Base swaps come from watch(), which reads receipts instead of Solana transactions
  quoteBuy: (token, wei, slip) => kyberQuote(NATIVE_PLACEHOLDER, token, wei, slip),
  quoteSell: (token, raw, slip) => kyberQuote(token, NATIVE_PLACEHOLDER, raw, slip),
  async executeSwap(ctx, quote, extras) {
    if (!this.liveTrading && !extras?.test) throw new Error('Live trading on Base is off (Settings → Trading wallet).');
    const key = baseKey();
    if (!key) throw new Error('No Base trading key saved (Settings → Trading wallet).');
    const { executeBaseSwap } = await import('./base-live');
    return executeBaseSwap(key, quote, ctx.cfg.safety.slippageBps, ctx.cfg.execution.baseMaxFeeEth, WETH, extras?.onSent);
  },
  async checkToken(ctx, token, wei) {
    const s = ctx.cfg.safety;
    if (s.blacklist.map((b) => b.toLowerCase()).includes(token.toLowerCase())) return { ok: false, reason: 'blacklisted' };
    const [g, decimals, buy] = await Promise.all([
      goplus(token).catch((e) => (ctx.cfg.filters.skipIfNoMarketData ? Promise.reject(e) : null)),
      decimalsOf(token),
      kyberQuote(NATIVE_PLACEHOLDER, token, wei, s.slippageBps),
    ]);
    const why = goplusSkipReason(g, s.rejectMintAuthority);
    if (why) return { ok: false, reason: why };
    if (!buy) return { ok: false, reason: 'no buy route' };
    const sell = await kyberQuote(token, NATIVE_PLACEHOLDER, BigInt(buy.outAmount), s.slippageBps);
    if (!sell) return { ok: false, reason: 'no sell route (possible honeypot)' };
    const lossPct = (1 - Number(sell.outAmount) / Number(wei)) * 100;
    if (lossPct > s.maxRoundTripLossPct) return { ok: false, reason: `round-trip loss ${lossPct.toFixed(1)}% > ${s.maxRoundTripLossPct}%` };
    return { ok: true, buyQuote: buy, decimals };
  },
  balance: async (_ctx, owner) => Number(await baseRpc.balance(owner)) / 1e18,
  nativeUsd: ethUsd,
  tokenCreator: async (_ctx, token) => {
    const g = await goplus(token);
    return g?.creator_address?.toLowerCase() || null;
  },
  nativeToSol: async (eth) => eth * (await solPerEth()),
  solToNativeRaw: async (sol) => BigInt(Math.round((sol / (await solPerEth())) * 1e18)),
  watch,
};
