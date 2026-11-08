/**
 * Holder concentration from the Solscan Pro API (needs SOLSCAN_API_KEY).
 *
 * Liquidity pools and pump.fun bonding curves are owned by program addresses (PDAs, which are
 * "off the ed25519 curve"), so only on-curve owners, i.e. real wallets, count as holders here.
 */
import { PublicKey } from '@solana/web3.js';
import { readSecret } from './env';

export type HolderItem = { owner?: unknown; amount?: unknown; amount_str?: unknown; percentage?: unknown };
export type HolderStats = { holderCount: number | null; largestPct: number; top10Pct: number; largestOwner: string | null };

const isWallet = (owner: string) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(owner).toBytes());
  } catch {
    return false;
  }
};

/** Share of supply held by the largest wallets (pools/curves excluded). `supplyRaw` from getTokenSupply. */
export function holderStats(items: HolderItem[], supplyRaw: bigint | null, holderCount: number | null, walletCheck = isWallet): HolderStats {
  const byOwner = new Map<string, number>();
  for (const it of items) {
    if (typeof it.owner !== 'string' || !walletCheck(it.owner)) continue;
    let pct: number | null = null;
    const raw = typeof it.amount_str === 'string' && /^\d+$/.test(it.amount_str) ? BigInt(it.amount_str) : typeof it.amount === 'number' ? BigInt(Math.round(it.amount)) : null;
    if (raw !== null && supplyRaw && supplyRaw > 0n) pct = Number((raw * 1_000_000n) / supplyRaw) / 10_000;
    else if (typeof it.percentage === 'number' && Number.isFinite(it.percentage)) pct = it.percentage;
    if (pct === null) continue;
    byOwner.set(it.owner, (byOwner.get(it.owner) ?? 0) + pct);
  }
  const sorted = [...byOwner.entries()].sort((a, b) => b[1] - a[1]);
  return {
    holderCount,
    largestPct: sorted[0]?.[1] ?? 0,
    largestOwner: sorted[0]?.[0] ?? null,
    top10Pct: sorted.slice(0, 10).reduce((a, [, p]) => a + p, 0),
  };
}

const cache = new Map<string, { at: number; v: HolderStats }>();

/** null when no Solscan key is set. Throws on API errors. */
export async function getHolderStats(mint: string, supplyRaw: bigint | null): Promise<HolderStats | null> {
  const key = readSecret('SOLSCAN_API_KEY', 'Solscan API key');
  if (!key) return null;
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const res = await fetch(`https://pro-api.solscan.io/v2.0/token/holders?address=${mint}&page=1&page_size=40`, { headers: { token: key, accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (res.status === 401 || res.status === 403) throw new Error('Solscan rejected the API key (or your plan does not include token holders)');
  if (res.status === 429) throw new Error('Solscan rate limit reached');
  if (!res.ok) throw new Error(`Solscan error (HTTP ${res.status})`);
  const body = (await res.json()) as { success?: boolean; data?: { total?: unknown; items?: HolderItem[] } };
  if (!body.success || !Array.isArray(body.data?.items)) throw new Error('Solscan returned no holder data');
  const total = typeof body.data!.total === 'number' ? body.data!.total : null;
  const v = holderStats(body.data!.items!, supplyRaw, total);
  cache.set(mint, { at: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return v;
}
