/**
 * Market data for the token filters: liquidity, market cap and pool age from Dexscreener
 * (free, no key), plus the SOL/USD price from Jupiter. Results are cached briefly.
 */
import type { MarketInfo } from './rules';
import { getQuote } from './jupiter';
import { WSOL } from './decode';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const cache = new Map<string, { at: number; info: MarketInfo | null }>();
const TTL = 30_000;

type Pair = {
  chainId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  volume?: { h24?: number };
  priceChange?: { h1?: number };
  txns?: { h1?: { buys?: number; sells?: number }; m5?: { buys?: number; sells?: number } };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
};

/** Combine every Solana pool for the token: total liquidity, market cap, oldest pool's creation time. */
export function summarizePairs(mint: string, pairs: Pair[]): MarketInfo | null {
  const mine = pairs.filter((p) => p.chainId === 'solana' && (p.baseToken?.address === mint || p.quoteToken?.address === mint));
  if (!mine.length) return null;
  const known = mine.filter((p) => typeof p.liquidity?.usd === 'number' && Number.isFinite(p.liquidity.usd));
  const liquidityUsd = known.length ? known.reduce((a, p) => a + Number(p.liquidity!.usd), 0) : null;
  const caps = mine.filter((p) => p.baseToken?.address === mint).map((p) => Number(p.marketCap ?? p.fdv)).filter((n) => Number.isFinite(n) && n > 0);
  const created = mine.map((p) => Number(p.pairCreatedAt)).filter((n) => Number.isFinite(n) && n > 0);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const top = [...mine].sort((a, b) => (num(b.liquidity?.usd) ?? -1) - (num(a.liquidity?.usd) ?? -1))[0];
  const side = top.baseToken?.address === mint ? top.baseToken : top.quoteToken;
  const vols = mine.map((p) => num(p.volume?.h24)).filter((n): n is number => n !== null);
  return {
    liquidityUsd,
    marketCapUsd: caps.length ? Math.max(...caps) : null,
    createdAt: created.length ? Math.min(...created) : null,
    symbol: side?.symbol ?? null,
    name: side?.name ?? null,
    volume24hUsd: vols.length ? vols.reduce((a, n) => a + n, 0) : null,
    change1hPct: num(top.priceChange?.h1),
    buys1h: num(top.txns?.h1?.buys),
    sells1h: num(top.txns?.h1?.sells),
    buys5m: num(top.txns?.m5?.buys),
    sells5m: num(top.txns?.m5?.sells),
  };
}

export async function getMarketInfo(mint: string): Promise<MarketInfo | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL) return hit.info;
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(6_000) });
  if (!res.ok) throw new Error(`market data unavailable (${res.status})`);
  const body = (await res.json()) as { pairs?: Pair[] | null };
  const info = summarizePairs(mint, Array.isArray(body.pairs) ? body.pairs : []);
  cache.set(mint, { at: Date.now(), info });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return info;
}

let solPrice: { at: number; usd: number } | null = null;

/** USD price of 1 SOL (from a Jupiter quote), cached for 5 minutes. */
export async function getSolUsd(): Promise<number | null> {
  if (solPrice && Date.now() - solPrice.at < 300_000) return solPrice.usd;
  const q = await getQuote(WSOL, USDC, 1_000_000_000n, 50).catch(() => null);
  if (!q) return solPrice?.usd ?? null;
  solPrice = { at: Date.now(), usd: Number(q.outAmount) / 1e6 };
  return solPrice.usd;
}
