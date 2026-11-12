import type { ChainId } from './chains/types';

/**
 * The spotter: between full wallet searches, Remora keeps noting traders who just caught a move
 * (cheap: market data only). The next full search checks them first, backtests them, and only
 * then may copy them. Traders spotted on several coins rank higher.
 */
export type Spotted = { wallet: string; chain: ChainId; tokens: string[]; firstAt: number; lastAt: number };

export const SPOT_KEEP_MS = 24 * 3_600_000; // forget traders not seen again within a day
export const SPOT_MAX = 300;

const key = (chain: ChainId, w: string) => (chain === 'base' ? w.toLowerCase() : w);

/** Add what one spotting round found (wallet -> coins it caught). Old entries fade out; the pool stays small. */
export function addSpotted(pool: Spotted[], chain: ChainId, found: Map<string, string[]>, now: number): Spotted[] {
  const out = pool.filter((s) => now - s.lastAt < SPOT_KEEP_MS).map((s) => ({ ...s, tokens: [...s.tokens] }));
  for (const [w, tokens] of found) {
    const k = key(chain, w);
    const hit = out.find((s) => s.chain === chain && s.wallet === k);
    if (hit) {
      for (const t of tokens) if (!hit.tokens.includes(t)) hit.tokens.push(t);
      hit.tokens = hit.tokens.slice(-10);
      hit.lastAt = now;
    } else out.push({ wallet: k, chain, tokens: [...new Set(tokens)].slice(0, 10), firstAt: now, lastAt: now });
  }
  // Keep the most promising: seen on more coins, then most recent.
  return out.sort((a, b) => b.tokens.length - a.tokens.length || b.lastAt - a.lastAt).slice(0, SPOT_MAX);
}

/** Spotted traders on one chain, not already copied, as "caught the move on" lists for the full search. */
export function spottedFor(pool: Spotted[], chain: ChainId, skip: Set<string>, max = 30): Map<string, string[]> {
  const lower = new Set([...skip].map((s) => s.toLowerCase()));
  return new Map(
    pool
      .filter((s) => s.chain === chain && !skip.has(s.wallet) && !lower.has(s.wallet.toLowerCase()))
      .slice(0, max)
      .map((s) => [s.wallet, s.tokens]),
  );
}

/** Forget traders the full search has now checked (it remembers the verdict itself). */
export const forgetSpotted = (pool: Spotted[], chain: ChainId, checked: Iterable<string>): Spotted[] => {
  const done = new Set([...checked].map((w) => key(chain, w)));
  return pool.filter((s) => !(s.chain === chain && done.has(s.wallet)));
};

/** Merge spotted traders into a search's own "caught the pump" list (coins combined, no duplicates). */
export function mergeCaught(own: Map<string, string[]>, spotted: Map<string, string[]>): Map<string, string[]> {
  const out = new Map([...own].map(([w, t]) => [w, [...t]]));
  for (const [w, t] of spotted) out.set(w, [...new Set([...(out.get(w) ?? []), ...t])]);
  return out;
}
