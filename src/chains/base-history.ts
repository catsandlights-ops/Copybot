/**
 * A Base wallet's trading history, for Analyze, backtests, the wallet check-up and the wallet finder.
 *
 * The free public Base nodes only answer about the last ten minutes of history, so this uses
 * Alchemy's transfer history (free with an Alchemy key, set as the Base RPC URL in Settings).
 * Transfers are grouped by transaction and turned into buys and sells; the pure part is unit-tested.
 */
import type { Swap } from '../decode';

export type AlchemyTransfer = {
  hash: string;
  blockNum: string; // hex
  from: string;
  to: string | null;
  category: string; // external | internal | erc20 | ...
  rawContract: { address: string | null; value: string | null; decimal: string | null };
  metadata?: { blockTimestamp?: string };
};

export type HistSwap = {
  hash: string;
  side: 'buy' | 'sell';
  token: string;
  decimals: number;
  tokenRaw: bigint;
  tokenPre: bigint; // the wallet's balance before (rebuilt from the transfers seen)
  quote: 'native' | 'stable' | 'unknown'; // unknown = paid out in plain ETH we couldn't see
  quoteRaw: bigint;
  block: number;
  blockTime: number | null;
};

const big = (hex: string | null | undefined) => {
  try {
    return hex ? BigInt(hex) : 0n;
  } catch {
    return 0n;
  }
};

/** Turn a wallet's transfers into swaps, oldest first. Pure. */
export function swapsFromTransfers(transfers: AlchemyTransfer[], walletIn: string, weth: string, stables: Set<string>): HistSwap[] {
  const wallet = walletIn.toLowerCase();
  const wethL = weth.toLowerCase();
  const byTx = new Map<string, AlchemyTransfer[]>();
  const seen = new Set<string>();
  for (const t of transfers) {
    // The same transfer can come back from both the "from" and "to" queries.
    const key = `${t.hash}|${t.category}|${t.from}|${t.to}|${t.rawContract.address}|${t.rawContract.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byTx.set(t.hash, [...(byTx.get(t.hash) ?? []), t]);
  }
  const txs = [...byTx.entries()].map(([hash, ts]) => ({ hash, ts, block: Number(ts[0].blockNum) })).sort((a, b) => a.block - b.block);
  const balance = new Map<string, bigint>();
  const decimalsOf = new Map<string, number>();
  const out: HistSwap[] = [];
  for (const { hash, ts, block } of txs) {
    const net = new Map<string, bigint>();
    let ethIn = 0n;
    let ethOut = 0n;
    for (const t of ts) {
      const from = t.from?.toLowerCase();
      const to = t.to?.toLowerCase();
      const v = big(t.rawContract.value);
      if (t.category === 'external' || t.category === 'internal') {
        if (from === wallet) ethOut += v;
        if (to === wallet) ethIn += v;
        continue;
      }
      if (t.category !== 'erc20' || !t.rawContract.address) continue;
      const token = t.rawContract.address.toLowerCase();
      if (t.rawContract.decimal) decimalsOf.set(token, Number(big(t.rawContract.decimal)));
      const d = (to === wallet ? v : 0n) - (from === wallet ? v : 0n);
      if (d !== 0n) net.set(token, (net.get(token) ?? 0n) + d);
    }
    // Keep running balances for every token (so a later sell knows what share was sold).
    const pre = new Map<string, bigint>();
    for (const [tok, d] of net) {
      pre.set(tok, balance.get(tok) ?? 0n);
      balance.set(tok, (balance.get(tok) ?? 0n) + d);
    }
    const traded = [...net.entries()].filter(([t]) => t !== wethL && !stables.has(t));
    if (traded.length !== 1) continue;
    const [token, change] = traded[0];
    const wethNet = net.get(wethL) ?? 0n;
    const stable = [...net.entries()].find(([t, v]) => stables.has(t) && (change > 0n ? v < 0n : v > 0n));
    const ts0 = ts.find((t) => t.metadata?.blockTimestamp)?.metadata?.blockTimestamp;
    const base = { hash, token, decimals: decimalsOf.get(token) ?? 18, tokenRaw: change < 0n ? -change : change, block, blockTime: ts0 ? Math.floor(Date.parse(ts0) / 1000) : null };
    if (change > 0n) {
      const eth = ethOut + (wethNet < 0n ? -wethNet : 0n);
      if (eth > 0n) out.push({ ...base, side: 'buy', quote: 'native', quoteRaw: eth, tokenPre: pre.get(token) ?? 0n });
      else if (stable) out.push({ ...base, side: 'buy', quote: 'stable', quoteRaw: -stable[1], tokenPre: pre.get(token) ?? 0n });
    } else {
      const eth = ethIn + (wethNet > 0n ? wethNet : 0n);
      // A sell needs at least what it sold: if older buys fell outside the history read, assume it sold everything.
      const before = pre.get(token) ?? 0n;
      const tokenPre = before >= base.tokenRaw ? before : base.tokenRaw;
      if (eth > 0n) out.push({ ...base, side: 'sell', quote: 'native', quoteRaw: eth, tokenPre });
      else if (stable) out.push({ ...base, side: 'sell', quote: 'stable', quoteRaw: stable[1], tokenPre });
      else out.push({ ...base, side: 'sell', quote: 'unknown', quoteRaw: 0n, tokenPre });
    }
  }
  return out;
}

/** Copybot's usual swap shape (amounts converted to SOL at today's ETH price). */
export function toSwaps(hs: HistSwap[], wallet: string, solPerEth: number): Swap[] {
  return hs
    .filter((h) => h.quote !== 'unknown')
    .map((h) => {
      const eth = h.quote === 'native' ? Number(h.quoteRaw) / 1e18 : undefined;
      return {
        chain: 'base' as const,
        signature: h.hash,
        wallet: wallet.toLowerCase(),
        blockTime: h.blockTime,
        side: h.side,
        mint: h.token,
        decimals: h.decimals,
        tokenAmount: h.tokenRaw,
        tokenPre: h.tokenPre,
        tokenPost: h.side === 'sell' ? h.tokenPre - h.tokenRaw : h.tokenPre + h.tokenRaw,
        quote: h.quote === 'native' ? ('SOL' as const) : ('USDC' as const),
        quoteAmount: h.quote === 'native' ? eth! * solPerEth : Number(h.quoteRaw) / 1e6,
        nativeAmount: eth,
      };
    });
}

// ---------------- fetching (Alchemy) ----------------

export const alchemyUrl = () => {
  const u = process.env.BASE_RPC_URL?.trim();
  return u && /alchemy\.com/i.test(u) ? u : null;
};
export const NEEDS_ALCHEMY = 'Reading a Base wallet\'s history needs a free Alchemy key: create one at alchemy.com (pick the Base network) and paste its URL in Settings → Connection → Base RPC URL.';

async function alchemy(url: string, params: object): Promise<{ transfers: AlchemyTransfer[]; pageKey?: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }), signal: AbortSignal.timeout(20_000) });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const j = (await res.json().catch(() => ({}))) as { result?: { transfers: AlchemyTransfer[]; pageKey?: string }; error?: { message: string } };
    if (j.error) throw new Error(`Alchemy: ${j.error.message}`);
    if (!res.ok || !j.result) throw new Error(`Alchemy didn't answer (HTTP ${res.status})`);
    return j.result;
  }
}

/** All of a wallet's transfers (to and from it) back to `sinceBlock`, up to `maxTransfers` each way. */
export async function walletTransfers(wallet: string, sinceBlock: number, maxTransfers: number, onPage?: (n: number) => void): Promise<AlchemyTransfer[]> {
  const url = alchemyUrl();
  if (!url) throw new Error(NEEDS_ALCHEMY);
  let categories = ['external', 'internal', 'erc20'];
  const all: AlchemyTransfer[] = [];
  for (const dir of ['fromAddress', 'toAddress'] as const) {
    let pageKey: string | undefined;
    let n = 0;
    do {
      const params = { fromBlock: '0x' + Math.max(0, sinceBlock).toString(16), toBlock: 'latest', [dir]: wallet, category: categories, withMetadata: true, excludeZeroValue: true, maxCount: '0x3e8', order: 'desc', ...(pageKey ? { pageKey } : {}) };
      let r;
      try {
        r = await alchemy(url, params);
      } catch (e) {
        // Some networks don't offer "internal" transfers: ask again without them.
        if (categories.includes('internal') && /internal/i.test((e as Error).message)) {
          categories = ['external', 'erc20'];
          continue;
        }
        throw e;
      }
      all.push(...r.transfers);
      n += r.transfers.length;
      onPage?.(all.length);
      pageKey = r.pageKey;
    } while (pageKey && n < maxTransfers);
  }
  return all;
}

// ---------------- early buyers of a coin (for the wallet finder) ----------------

/**
 * The first wallets to buy a coin, from its earliest transfers: tokens leaving the pool are buys.
 * A router that receives them and passes them on in the same transaction is followed to the real buyer.
 * The value is how many early buys each wallet made. Pure.
 */
export function earlyBuyersFromTransfers(transfers: AlchemyTransfer[], pool: string, early: number): Map<string, number> {
  const p = pool.toLowerCase();
  const byHash = new Map<string, AlchemyTransfer[]>();
  for (const t of transfers) if (t.category === 'erc20') byHash.set(t.hash, [...(byHash.get(t.hash) ?? []), t]);
  const buyers = new Map<string, number>();
  const ZERO = '0x0000000000000000000000000000000000000000';
  for (const [, ts] of byHash) {
    for (const t of ts.filter((x) => x.from.toLowerCase() === p && x.to)) {
      let to = t.to!.toLowerCase();
      for (let hop = 0; hop < 3; hop++) {
        const next = ts.find((x) => x.from.toLowerCase() === to && x.to && x.to.toLowerCase() !== p);
        if (!next) break;
        to = next.to!.toLowerCase();
      }
      if (to === p || to === ZERO) continue;
      buyers.set(to, (buyers.get(to) ?? 0) + 1);
    }
    if (buyers.size >= early) break;
  }
  return buyers;
}

/** The first `early` buyers of a Base coin from its pool (reads its first 1,000 transfers). */
export async function baseEarlyBuyers(token: string, pool: string, early: number): Promise<Map<string, number>> {
  const url = alchemyUrl();
  if (!url) throw new Error(NEEDS_ALCHEMY);
  const r = await alchemy(url, { fromBlock: '0x0', toBlock: 'latest', contractAddresses: [token], category: ['erc20'], excludeZeroValue: true, maxCount: '0x3e8', order: 'asc' });
  return earlyBuyersFromTransfers(r.transfers, pool, early);
}
