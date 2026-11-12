/**
 * Markets hub data. Everything is fetched server-side (never from the page), cached,
 * and cleaned before it reaches the UI: only known fields, validated addresses, and
 * links/images restricted to known hosts.
 *
 * Sources: CoinGecko (BTC/ETH/SOL prices), GeckoTerminal (trending/new pools, charts),
 * Dexscreener (token details, search), RSS/Atom news feeds, and optionally DexCheck
 * (whale trades, top traders) with the user's API key.
 */
import { chainIds, DEFAULT_CHAIN, getChain, type ChainId } from './chains';
import { readSecret } from './env';
import { sleep } from './util';

const UA = 'Remora';

/** A chain's facts (network ids, native coin, main USD pool). */
const M = (chain: ChainId) => getChain(chain).meta;
/** EVM addresses are case-insensitive (Dexscreener mixes case, GeckoTerminal is lowercase); Solana's are not. */
const sameAddr = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && (a === b || (a.startsWith('0x') && a.toLowerCase() === b.toLowerCase()));

// ---------------- small cache with in-flight de-duplication ----------------
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const value = await fn();
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
      return value;
    } catch (e) {
      if (hit) return hit.value as T; // serve stale data rather than nothing
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 429) throw Object.assign(new Error('rate limited'), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// GeckoTerminal allows ~30 requests/minute: space calls out and retry once on 429.
let gtNext = 0;
async function gecko(path: string): Promise<any> {
  // Up to 3 tries: on a rate limit, a server error or a dropped connection, wait longer each time.
  for (let attempt = 0; ; attempt++) {
    const wait = gtNext - Date.now();
    gtNext = Math.max(Date.now(), gtNext) + 2_100;
    if (wait > 0) await sleep(wait);
    try {
      return await getJson(`https://api.geckoterminal.com/api/v2${path}`, { accept: 'application/json;version=20230302' });
    } catch (e: any) {
      const retryable = e.rateLimited || /HTTP 5\d\d/.test(e.message) || e.name === 'TimeoutError' || e.name === 'TypeError';
      if (!retryable || attempt >= 2) throw e;
      if (e.rateLimited) gtNext = Date.now() + 6_000 * (attempt + 1); // let every caller back off
      await sleep(4_000 * (attempt + 1));
    }
  }
}

// ---------------- helpers ----------------
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown, max = 80) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const IMAGE_HOSTS = new Set(['coin-images.coingecko.com', 'assets.geckoterminal.com', 'cdn.dexscreener.com']);
const image = (v: unknown): string | null => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' && IMAGE_HOSTS.has(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
};
// Any address format of a chain Remora knows (each chain's adapter defines its own).
const addr = (v: unknown): string | null => (chainIds().some((c) => getChain(c).meta.isAddress(v)) ? ((v as string).startsWith('0x') ? (v as string).toLowerCase() : (v as string)) : null);

// ---------------- overview: BTC / ETH / SOL ----------------
export function overview() {
  return cached('overview', 60_000, async () => {
    const d = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true');
    const coin = (id: string, symbol: string) => ({ symbol, priceUsd: num(d?.[id]?.usd), change24h: num(d?.[id]?.usd_24h_change) });
    return [coin('bitcoin', 'BTC'), coin('ethereum', 'ETH'), coin('solana', 'SOL')];
  });
}

// ---------------- pools: trending / new (GeckoTerminal) ----------------
export type PoolRow = {
  pool: string;
  mint: string;
  symbol: string;
  name: string;
  image: string | null;
  priceUsd: number | null;
  change: { m5?: number | null; h1: number | null; h6?: number | null; h24: number | null };
  volume24h: number | null;
  volume1h?: number | null;
  buys1h?: number | null;
  sells1h?: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  createdAt: number | null;
  buys24h: number | null;
  sells24h: number | null;
};

function mapPools(d: any): PoolRow[] {
  const tokens = new Map<string, any>((d?.included ?? []).map((t: any) => [t.id, t.attributes]));
  const out: PoolRow[] = [];
  for (const p of d?.data ?? []) {
    const a = p.attributes ?? {};
    const t = tokens.get(p.relationships?.base_token?.data?.id) ?? {};
    const pool = addr(a.address);
    const mint = addr(t.address);
    if (!pool || !mint) continue;
    out.push({
      pool,
      mint,
      symbol: text(t.symbol, 20),
      name: text(t.name, 60),
      image: image(t.image_url),
      priceUsd: num(a.base_token_price_usd),
      change: { m5: num(a.price_change_percentage?.m5), h1: num(a.price_change_percentage?.h1), h6: num(a.price_change_percentage?.h6), h24: num(a.price_change_percentage?.h24) },
      volume24h: num(a.volume_usd?.h24),
      volume1h: num(a.volume_usd?.h1),
      buys1h: num(a.transactions?.h1?.buys),
      sells1h: num(a.transactions?.h1?.sells),
      liquidityUsd: num(a.reserve_in_usd),
      marketCapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
      createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) || null : null,
      buys24h: num(a.transactions?.h24?.buys),
      sells24h: num(a.transactions?.h24?.sells),
    });
  }
  return out;
}

export function pools(kind: 'trending' | 'new', chain: ChainId = DEFAULT_CHAIN) {
  return cached(`pools:${chain}:${kind}`, 60_000, async () =>
    mapPools(await gecko(`/networks/${M(chain).geckoNetwork}/${kind === 'new' ? 'new_pools' : 'trending_pools'}?include=base_token&page=1`)),
  );
}

// ---------------- token details + search (Dexscreener) ----------------
type DsPair = any;
function pairSummary(p: DsPair) {
  return {
    pool: addr(p.pairAddress),
    dex: text(p.dexId, 30),
    mint: addr(p.baseToken?.address),
    symbol: text(p.baseToken?.symbol, 20),
    name: text(p.baseToken?.name, 60),
    image: image(p.info?.imageUrl),
    priceUsd: num(p.priceUsd),
    change: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
    volume: { h1: num(p.volume?.h1), h24: num(p.volume?.h24) },
    txns: {
      h1: { buys: num(p.txns?.h1?.buys), sells: num(p.txns?.h1?.sells) },
      h24: { buys: num(p.txns?.h24?.buys), sells: num(p.txns?.h24?.sells) },
    },
    liquidityUsd: typeof p.liquidity?.usd === 'number' ? p.liquidity.usd : null,
    marketCapUsd: num(p.marketCap) ?? num(p.fdv),
    createdAt: num(p.pairCreatedAt),
  };
}

/** Details for a token: its most liquid Solana pool, plus totals across pools. */
export function token(mint: string, chain: ChainId = DEFAULT_CHAIN) {
  return cached(`token:${mint}`, 30_000, async () => {
    const d = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pairs: DsPair[] = (d?.pairs ?? []).filter((p: DsPair) => p.chainId === M(chain).dexscreenerId && sameAddr(p.baseToken?.address, mint));
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0) || (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));
    const known = pairs.filter((p) => typeof p.liquidity?.usd === 'number');
    return {
      ...pairSummary(pairs[0]),
      pools: pairs.length,
      totalLiquidityUsd: known.length ? known.reduce((a, p) => a + p.liquidity.usd, 0) : null,
      oldestPoolAt: Math.min(...pairs.map((p) => num(p.pairCreatedAt) ?? Infinity)) || null,
    };
  });
}

/** Several tokens at once (Dexscreener accepts up to 30 addresses per call). Used for the watchlist. */
export function tokens(mints: string[], chain: ChainId = DEFAULT_CHAIN) {
  const list = [...new Set(mints)].filter(M(chain).isAddress).slice(0, 30);
  if (!list.length) return Promise.resolve([]);
  return cached(`tokens:${list.join(',')}`, 30_000, async () => {
    const d = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${list.join(',')}`);
    const best = new Map<string, DsPair>();
    for (const p of d?.pairs ?? []) {
      const key = list.find((m) => sameAddr(m, p.baseToken?.address));
      if (p.chainId !== M(chain).dexscreenerId || !key) continue;
      const cur = best.get(key);
      if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(key, p);
    }
    return list.map((m) => (best.has(m) ? pairSummary(best.get(m)) : { mint: m, symbol: '?', name: 'No market data', priceUsd: null }));
  });
}

/** Like tokens(), for a list that may mix Solana and Base coins (in the same order). */
export async function tokensAnyChain(mints: string[]) {
  const isBase = (m: string) => /^0x[0-9a-fA-F]{40}$/.test(m);
  const [sol, base] = await Promise.all([tokens(mints.filter((m) => !isBase(m)), 'solana'), tokens(mints.filter(isBase), 'base')]);
  const by = new Map<string, any>([...sol, ...base].map((t: any) => [t.mint, t]));
  return mints.map((m) => by.get(m)).filter(Boolean);
}

export function search(q: string, chain: ChainId = DEFAULT_CHAIN) {
  const query = q.replace(/[^\w\s.$-]/g, '').trim().slice(0, 60);
  if (query.length < 2) return Promise.resolve([]);
  return cached(`search:${chain}:${query.toLowerCase()}`, 30_000, async () => {
    const d = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
    const seen = new Set<string>();
    const out = [];
    for (const p of d?.pairs ?? []) {
      if (p.chainId !== M(chain).dexscreenerId || !M(chain).isAddress(p.baseToken?.address) || seen.has(p.baseToken.address)) continue;
      seen.add(p.baseToken.address);
      out.push(pairSummary(p));
      if (out.length >= 15) break;
    }
    return out;
  });
}

// ---------------- price chart (GeckoTerminal OHLCV) ----------------
const TIMEFRAMES = { '15m': ['minute', 15, 96], '1h': ['hour', 1, 72], '1d': ['day', 1, 90] } as const;
export type Timeframe = keyof typeof TIMEFRAMES;
export const isTimeframe = (v: unknown): v is Timeframe => typeof v === 'string' && v in TIMEFRAMES;

export function chart(pool: string, tf: Timeframe, chain: ChainId = DEFAULT_CHAIN) {
  const [unit, aggregate, limit] = TIMEFRAMES[tf];
  return cached(`chart:${pool}:${tf}`, 60_000, async () => {
    const d = await gecko(`/networks/${M(chain).geckoNetwork}/pools/${pool}/ohlcv/${unit}?aggregate=${aggregate}&limit=${limit}&currency=usd`);
    const rows: unknown[] = d?.data?.attributes?.ohlcv_list ?? [];
    return rows
      .map((r: any) => (Array.isArray(r) ? r.map(num) : []))
      .filter((r) => r.length >= 6 && r.slice(0, 5).every((v) => v !== null))
      .map(([t, o, h, l, c, v]) => ({ t: t! * 1000, o: o!, h: h!, l: l!, c: c!, v: v ?? 0 }))
      .sort((a, b) => a.t - b.t);
  });
}

// ---------------- news (RSS + Atom) ----------------
const FEEDS = [
  { source: 'Blockworks', url: 'https://blockworks.com/feed', hosts: ['blockworks.com', 'blockworks.co'] },
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', hosts: ['www.coindesk.com', 'coindesk.com'] },
  { source: 'The Block', url: 'https://www.theblock.co/rss.xml', hosts: ['www.theblock.co', 'theblock.co'] },
  { source: 'Decrypt', url: 'https://decrypt.co/feed', hosts: ['decrypt.co'] },
];
export const NEWS_HOSTS = FEEDS.flatMap((f) => f.hosts);

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[e as string] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .trim();
const tag = (block: string, name: string) => block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1];

export function parseFeed(xml: string, source: string, hosts: string[]) {
  const items = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const out = [];
  for (const it of items.slice(0, 30)) {
    const title = decode(tag(it, 'title') ?? '');
    const link = decode(tag(it, 'link') ?? '') || (it.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '');
    const date = decode(tag(it, 'pubDate') ?? tag(it, 'published') ?? tag(it, 'updated') ?? '');
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || !title) continue;
    out.push({ source, title: title.slice(0, 200), url: url.toString(), publishedAt: Date.parse(date) || null });
  }
  return out;
}

export function news() {
  return cached('news', 10 * 60_000, async () => {
    const results = await Promise.allSettled(
      FEEDS.map(async (f) => {
        const res = await fetch(f.url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`${f.source}: HTTP ${res.status}`);
        return parseFeed((await res.text()).slice(0, 2_000_000), f.source, f.hosts);
      }),
    );
    // Only recent stories (some publishers' feeds go stale; Blockworks' public feed stopped in Jan 2026).
    const cutoff = Date.now() - 14 * 86_400_000;
    const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).filter((n) => (n.publishedAt ?? 0) >= cutoff);
    return all.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)).slice(0, 40);
  });
}

// ---------------- DexCheck (optional, needs the user's free API key) ----------------
const dexKey = () => readSecret('DEXCHECK_API_KEY', 'DexCheck API key');

async function dexcheck(path: string) {
  const key = dexKey();
  if (!key) throw Object.assign(new Error('Add a free DexCheck API key in Settings → Connection to see this.'), { needsKey: true });
  const res = await fetch(`https://api.dexcheck.ai/api/v1${path}`, { headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(12_000) });
  if (res.status === 401 || res.status === 403) throw new Error('DexCheck rejected the API key. Check it in Settings → Connection.');
  if (res.status === 429) throw new Error('DexCheck rate limit reached. Try again in a minute.');
  if (!res.ok) throw new Error(`DexCheck error (HTTP ${res.status})`);
  return res.json() as Promise<any>;
}

export function whales(minUsd: number) {
  return cached(`whales:${minUsd}`, 60_000, async () => {
    const d = await dexcheck(`/blockchain/whale-tracker?chain=solana&min_usd=${minUsd}&page=1`);
    return (d?.transactions ?? [])
      .map((t: any) => {
        // DexCheck lists SOL on either side of the pair; report the non-SOL token.
        const solBase = t.base_symbol === 'SOL';
        return {
          side: t.side === 'buy' || t.side === 'sell' ? t.side : null,
          amountUsd: num(t.amount_usd),
          wallet: addr(t.maker),
          pool: addr(t.pair_id),
          token: text(solBase ? t.quote_symbol : t.base_symbol, 20),
          tokenName: text(solBase ? t.quote_name : t.base_name, 60),
          mcap: num(t.mcap),
          at: (num(t.epoch_time) ?? 0) * 1000 || null,
          tx: typeof t.tx_hash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(t.tx_hash) ? t.tx_hash : null,
        };
      })
      .filter((t: any) => t.wallet && t.amountUsd != null)
      .slice(0, 50);
  });
}

export const DURATIONS = ['1d', '7d', '30d', '60d'] as const;
export function topTraders(pool: string, duration: (typeof DURATIONS)[number]) {
  return cached(`top:${pool}:${duration}`, 5 * 60_000, async () => {
    const d = await dexcheck(`/blockchain/top-traders-for-pair?chain=solana&pair_id=${pool}&duration=${duration}&page=1`);
    return (d?.traders ?? [])
      .map((t: any) => ({
        wallet: addr(t.maker),
        profitUsd: num(t.overall_profit),
        realizedUsd: num(t.realized_profit),
        unrealizedUsd: num(t.unrealized_profit),
        roiPct: num(t.roi),
        investedUsd: num(t.investment),
        buys: num(t.buy_total_trades),
        sells: num(t.sell_total_trades),
      }))
      .filter((t: any) => t.wallet)
      .slice(0, 30);
  });
}

// ---------------- price history for backtests ----------------
export type Candle = { t: number; l: number; h: number; c: number; v?: number }; // t = candle start (ms), USD prices, v = USD volume

/**
 * USD price candles for a token between two times, from its most liquid pool on GeckoTerminal.
 * Picks 5-minute candles for spans up to ~3 days, then 15-minute, then hourly (1000 candles max).
 * Returns null when the token has no pool or no data.
 */
export async function priceHistory(mint: string, fromMs: number, toMs: number, chain: ChainId = DEFAULT_CHAIN): Promise<{ step: number; candles: Candle[]; createdAt: number | null } | null> {
  const pools = await gecko(`/networks/${M(chain).geckoNetwork}/tokens/${mint}/pools?page=1`);
  const pool = addr(pools?.data?.[0]?.attributes?.address);
  if (!pool) return null;
  // The token's age: its oldest pool (a pump.fun token's bonding curve predates its later pools).
  const created = (pools?.data ?? []).map((p: any) => Date.parse(p?.attributes?.pool_created_at)).filter((t: number) => Number.isFinite(t) && t > 0);
  const createdAt = created.length ? Math.min(...created) : null;
  const span = Math.max(0, toMs - fromMs);
  const [tf, agg, step] = span <= 3.3 * 86_400_000 ? ['minute', 5, 300_000] : span <= 10 * 86_400_000 ? ['minute', 15, 900_000] : ['hour', 1, 3_600_000];
  const before = Math.floor(Math.min(Date.now(), toMs + step) / 1000);
  const d = await gecko(`/networks/${M(chain).geckoNetwork}/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&before_timestamp=${before}&limit=1000&currency=usd&token=${mint}`);
  const rows: unknown[] = d?.data?.attributes?.ohlcv_list ?? [];
  const candles = rows
    .map((r: any) => (Array.isArray(r) ? r.map(num) : []))
    .filter((r) => r.length >= 5 && r.slice(0, 5).every((v) => v !== null && v >= 0))
    .map(([t, , h, l, c, v]) => ({ t: t! * 1000, h: h!, l: l!, c: c!, ...(v != null ? { v } : {}) }))
    .filter((k) => k.t + step >= fromMs && k.l > 0)
    .sort((a, b) => a.t - b.t);
  return candles.length ? { step, candles, createdAt } : null;
}

/** SOL's price change over the last hour and day (main SOL/USDC pool). Cached for 2 minutes. */
export function solChange(chain: ChainId = DEFAULT_CHAIN): Promise<{ h1: number | null; h24: number | null }> {
  return cached(`native-change:${chain}`, 120_000, async () => {
    const d = await gecko(`/networks/${M(chain).geckoNetwork}/pools/${M(chain).nativeUsdPool}`);
    const c = d?.data?.attributes?.price_change_percentage ?? {};
    return { h1: num(c.h1), h24: num(c.h24) };
  });
}

/**
 * SOL`s USD price per day (UTC day start -> closing price), from the main SOL/USDC pool on
 * GeckoTerminal. Covers up to 1000 days back. Cached for an hour.
 */
export function solUsdDaily(chain: ChainId = DEFAULT_CHAIN): Promise<Map<number, number>> {
  return cached(`native-daily:${chain}`, 3_600_000, async () => {
    const pool = M(chain).nativeUsdPool;
    const d = await gecko(`/networks/${M(chain).geckoNetwork}/pools/${pool}/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=${M(chain).native.wrapped}`);
    const out = new Map<number, number>();
    for (const r of d?.data?.attributes?.ohlcv_list ?? []) {
      const t = num(r?.[0]);
      const c = num(r?.[4]);
      if (t != null && c != null && c > 0) out.set(t * 1000, c);
    }
    if (!out.size) throw new Error("Couldn't load SOL's price history. Try again in a minute.");
    return out;
  });
}

// ---------------- wallet scout sources ----------------
/** Many places to look for tokens that are moving: trending over 1h/6h/24h, new launches, top volume. */
export async function scoutPools(chain: ChainId = DEFAULT_CHAIN, maxAgeMs = 5 * 60_000): Promise<PoolRow[]> {
  const net = M(chain).geckoNetwork;
  // What moves fast (the last hour's trending coins and brand-new pools) is fetched at the caller's pace;
  // slower lists (6 h and 24 h trending, top volume) at most every 5 minutes. Fewer requests per scan.
  const fetchList = async (paths: string[]) => {
    const out: PoolRow[] = [];
    let failed = 0;
    for (const p of paths) out.push(...mapPools(await gecko(p).catch(() => (failed++, null))));
    // Never cache an empty answer from a failed lookup: the next try should ask again.
    if (!out.length) throw new Error(`Couldn't reach the market data service (GeckoTerminal)${failed ? `: ${failed} of ${paths.length} requests failed` : ''}. Try again in a minute.`);
    return out;
  };
  const [fast, slow] = await Promise.allSettled([
    cached(`scout:fast:${chain}`, Math.min(maxAgeMs, 5 * 60_000), () => fetchList([`/networks/${net}/trending_pools?include=base_token&duration=1h&page=1`, `/networks/${net}/new_pools?include=base_token&page=1`])),
    cached(`scout:slow:${chain}`, 5 * 60_000, () => fetchList([`/networks/${net}/trending_pools?include=base_token&duration=6h&page=1`, `/networks/${net}/trending_pools?include=base_token&duration=24h&page=1`, `/networks/${net}/pools?include=base_token&page=1&sort=h24_volume_usd_desc`])),
  ]);
  const rows = [...(fast.status === 'fulfilled' ? fast.value : []), ...(slow.status === 'fulfilled' ? slow.value : [])];
  if (!rows.length) throw (fast.status === 'rejected' ? fast.reason : (slow as PromiseRejectedResult).reason);
  return rows;
}

export type PoolTrade = { kind: 'buy' | 'sell'; wallet: string; t: number; usd: number; priceUsd: number };

/** A pool's latest trades over `minUsd` (up to 300), with the token's USD price on each. */
export async function poolTrades(pool: string, minUsd = 300, chain: ChainId = DEFAULT_CHAIN): Promise<PoolTrade[]> {
  const d = await gecko(`/networks/${M(chain).geckoNetwork}/pools/${pool}/trades?trade_volume_in_usd_greater_than=${minUsd}`);
  const out: PoolTrade[] = [];
  for (const r of d?.data ?? []) {
    const a = r.attributes ?? {};
    const kind = a.kind === 'buy' || a.kind === 'sell' ? a.kind : null;
    const wallet = addr(a.tx_from_address);
    const usd = num(a.volume_in_usd);
    // The token's price: what was received on a buy, what was given on a sell.
    const priceUsd = num(kind === 'buy' ? a.price_to_in_usd : a.price_from_in_usd);
    const t = Date.parse(a.block_timestamp);
    if (!kind || !wallet || usd == null || priceUsd == null || priceUsd <= 0 || !Number.isFinite(t) || a.is_anomalous) continue;
    out.push({ kind, wallet, t, usd, priceUsd });
  }
  return out;
}
