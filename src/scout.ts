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

export type ScoutToken = { mint: string; pool: string; symbol: string; change24hPct: number; ageHours: number; liquidityUsd: number; volume24hUsd: number };
export type ScoutCandidate = { wallet: string; earlyOn: string[]; earlySol: number; topTraderOn: string[] };
export type ScoutReport = Report & { earlyOn: string[]; topTraderOn: string[] };
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
 * Tokens worth mining for early buyers: up strongly, a few hours to a week old (so "early" is
 * findable on-chain), real liquidity and volume, and not so busy that scanning to the start is hopeless.
 */
export function pickTokens(rows: PoolRow[], now: number, max = 5): ScoutToken[] {
  const seen = new Set<string>();
  const out: ScoutToken[] = [];
  const ok = rows
    .filter((r) => !SKIP_MINTS.has(r.mint))
    .filter((r) => (r.change.h24 ?? 0) >= 30)
    .filter((r) => r.createdAt && now - r.createdAt >= 3 * 3_600_000 && now - r.createdAt <= 7 * 86_400_000)
    .filter((r) => (r.liquidityUsd ?? 0) >= 20_000 && (r.volume24h ?? 0) >= 50_000)
    .filter((r) => (r.buys24h ?? 0) + (r.sells24h ?? 0) <= 40_000)
    .sort((a, b) => (b.change.h24 ?? 0) - (a.change.h24 ?? 0));
  for (const r of ok) {
    if (seen.has(r.mint)) continue;
    seen.add(r.mint);
    out.push({ mint: r.mint, pool: r.pool, symbol: r.symbol, change24hPct: r.change.h24 ?? 0, ageHours: Math.round((now - r.createdAt!) / 3_600_000), liquidityUsd: r.liquidityUsd ?? 0, volume24hUsd: r.volume24h ?? 0 });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Which wallets to spend analysis time on: early on several of the tokens first, then DexCheck top
 * traders, then big early buyers. Skips wallets already copied.
 */
export function pickCandidates(early: Candidate[], topTraders: Map<string, string[]>, symbols: Map<string, string>, skip: Set<string>, max = 12): ScoutCandidate[] {
  const all = new Map<string, ScoutCandidate>();
  for (const c of early) all.set(c.wallet, { wallet: c.wallet, earlyOn: c.mints.map((m) => symbols.get(m) ?? m.slice(0, 4)), earlySol: c.sol, topTraderOn: [] });
  for (const [w, tokens] of topTraders) {
    const c = all.get(w) ?? { wallet: w, earlyOn: [], earlySol: 0, topTraderOn: [] };
    c.topTraderOn = tokens;
    all.set(w, c);
  }
  const score = (c: ScoutCandidate) => c.earlyOn.length * 2 + c.topTraderOn.length * 1.5 + Math.min(c.earlySol, 20) / 20;
  return [...all.values()]
    .filter((c) => !skip.has(c.wallet))
    .filter((c) => c.earlyOn.length + c.topTraderOn.length > 1 || c.earlySol >= 0.5 || c.topTraderOn.length > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, max);
}

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
