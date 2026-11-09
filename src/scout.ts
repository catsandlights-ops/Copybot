/**
 * Wallet scout: finds wallets worth copying without the user pasting anything.
 *
 *   1. pick Solana tokens that pumped recently (GeckoTerminal trending + new pools)
 *   2. find who bought them early (on-chain), plus DexCheck top traders when a key is set
 *   3. analyze the best candidates' real track record (on-chain)
 *   4. Claude picks the most suitable ones (or a rule-based ranking without Claude)
 *
 * The pure helpers (pickTokens, pickCandidates, ruleScore) are unit-tested; runScout wires them up.
 */
import type { Report } from './analyze';
import type { Candidate } from './discover';
import type { PoolRow } from './markets';

export type ScoutToken = {
  mint: string;
  pool: string;
  symbol: string;
  change24hPct: number;
  change6hPct: number | null;
  ageHours: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceUsd: number | null;
  quiet: boolean; // little enough history to read back to its launch (true early buyers)
};
export type ScoutCandidate = { wallet: string; earlyOn: string[]; earlySol: number; topTraderOn: string[]; pumpOn: string[] };
export type ScoutReport = Report & { earlyOn: string[]; topTraderOn: string[]; pumpOn?: string[] };
export type ScoutPick = { address: string; sizeMultiplier: number; budgetSol: number; reason: string };
export type ScoutResult = {
  at: number;
  tokens: ScoutToken[];
  reports: ScoutReport[];
  picks: ScoutPick[];
  pickedBy: 'claude' | 'rules';
  summary: string;
  added: string[]; // addresses actually added to the copy list
  notes: string[];
};

const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

/**
 * Tokens worth mining for good buyers: up 30%+ over 6h or 24h, 1 hour to 14 days old, with real
 * liquidity and volume. Strongest movers first; tokens scanned in recent searches go to the back
 * so each search looks at different coins.
 */
export function pickTokens(rows: PoolRow[], now: number, max = 6, recent: Set<string> = new Set()): ScoutToken[] {
  const best = new Map<string, PoolRow>();
  for (const r of rows) {
    if (SKIP_MINTS.has(r.mint) || !r.createdAt) continue;
    const age = now - r.createdAt;
    if (age < 3_600_000 || age > 14 * 86_400_000) continue;
    if ((r.liquidityUsd ?? 0) < 20_000 || (r.volume24h ?? 0) < 50_000) continue;
    if (Math.max(r.change.h24 ?? 0, r.change.h6 ?? 0) < 30) continue;
    const prev = best.get(r.mint);
    if (!prev || (r.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) best.set(r.mint, r); // the token's main pool
  }
  const move = (r: PoolRow) => Math.max(r.change.h24 ?? 0, r.change.h6 ?? 0);
  const ranked = [...best.values()].sort((a, b) => Number(recent.has(a.mint)) - Number(recent.has(b.mint)) || move(b) - move(a));
  return ranked.slice(0, max).map((r) => {
    const ageMs = now - r.createdAt!;
    const lifetimeTxs = ((r.buys24h ?? 0) + (r.sells24h ?? 0)) * Math.max(1, ageMs / 86_400_000);
    return {
      mint: r.mint,
      pool: r.pool,
      symbol: r.symbol,
      change24hPct: r.change.h24 ?? 0,
      change6hPct: r.change.h6 ?? null,
      ageHours: Math.round(ageMs / 3_600_000),
      liquidityUsd: r.liquidityUsd ?? 0,
      volume24hUsd: r.volume24h ?? 0,
      priceUsd: r.priceUsd,
      quiet: lifetimeTxs <= 25_000 && ageMs <= 3 * 86_400_000,
    };
  });
}

/**
 * "Caught the pump": wallets whose recent buys of a token are now up at least `minGainPct`.
 * Works from a pool's latest large trades, so it suits busy tokens whose launch is too far back.
 */
export function pumpBuyers(trades: { kind: string; wallet: string; usd: number; priceUsd: number }[], priceNowUsd: number | null, minGainPct = 40, minUsd = 300): Map<string, number> {
  const out = new Map<string, number>(); // wallet -> best gain %
  if (!priceNowUsd || priceNowUsd <= 0) return out;
  for (const t of trades) {
    if (t.kind !== 'buy' || t.usd < minUsd || t.priceUsd <= 0) continue;
    const gain = (priceNowUsd / t.priceUsd - 1) * 100;
    if (gain >= minGainPct) out.set(t.wallet, Math.max(out.get(t.wallet) ?? 0, gain));
  }
  return out;
}

/**
 * Which wallets to spend analysis time on: seen on several tokens first (early buyer, caught the
 * pump, top trader), then big early buyers. Skips wallets already copied.
 */
export function pickCandidates(early: Candidate[], topTraders: Map<string, string[]>, symbols: Map<string, string>, skip: Set<string>, max = 12, pump: Map<string, string[]> = new Map()): ScoutCandidate[] {
  const all = new Map<string, ScoutCandidate>();
  const get = (w: string) => all.get(w) ?? (all.set(w, { wallet: w, earlyOn: [], earlySol: 0, topTraderOn: [], pumpOn: [] }), all.get(w)!);
  for (const c of early) {
    const x = get(c.wallet);
    x.earlyOn = c.mints.map((m) => symbols.get(m) ?? m.slice(0, 4));
    x.earlySol = c.sol;
  }
  for (const [w, tokens] of topTraders) get(w).topTraderOn = tokens;
  for (const [w, tokens] of pump) get(w).pumpOn = tokens;
  const tokensSeen = (c: ScoutCandidate) => new Set([...c.earlyOn, ...c.topTraderOn, ...c.pumpOn]).size;
  const score = (c: ScoutCandidate) => tokensSeen(c) * 2 + c.earlyOn.length * 0.5 + c.topTraderOn.length + c.pumpOn.length * 0.5 + Math.min(c.earlySol, 20) / 20;
  return [...all.values()]
    .filter((c) => !skip.has(c.wallet))
    .filter((c) => tokensSeen(c) > 1 || c.earlySol >= 0.5 || c.topTraderOn.length > 0 || c.pumpOn.length > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, max);
}

/** Hard minimum for any wallet the scout adds or suggests, whoever picked it (Claude or the rules). */
export const passesBasics = (r: Report) => ruleScore(r) > 0;

/** Rule-based quality score, used to rank when Claude isn't available. Negative = don't copy. */
export function ruleScore(r: Report): number {
  if (r.closedTokens < 10) return -1;
  if (r.tradesPerDay > 150) return -1; // bot
  if (r.closedTokens && r.medianHoldMin < 2) return -1; // exits too fast to copy
  if (r.roiPct <= 0 || r.realizedPnlSol <= 0) return -1;
  return r.winRate * 100 + Math.min(r.roiPct, 300) / 3 + Math.min(r.closedTokens, 50) / 5;
}

export function rulePicks(reports: Report[], max = 3): ScoutPick[] {
  return reports
    .map((r) => ({ r, s: ruleScore(r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map(({ r }) => ({
      address: r.wallet,
      sizeMultiplier: 1,
      budgetSol: 0,
      reason: `${Math.round(r.winRate * 100)}% win rate on ${r.closedTokens} closed trades, ${r.roiPct.toFixed(0)}% return, holds ~${r.medianHoldMin < 60 ? `${r.medianHoldMin.toFixed(0)} min` : `${(r.medianHoldMin / 60).toFixed(1)} h`}.`,
    }));
}
