/**
 * Smarter sizing and timing, as pure rules (unit-tested):
 *  - consensus: several copied wallets buying the same coin is a stronger signal
 *  - track record: wallets that make you money get more, ones that lose (or you copy late) get less
 *  - market mood: when SOL is dropping or most coins are falling, buy less or not at all
 */

export type RecentBuy = { mint: string; wallet: string; t: number };

/** Distinct copied wallets that bought this coin within the last `windowMin` minutes. */
export function consensusWallets(recent: RecentBuy[], mint: string, now: number, windowMin: number): string[] {
  const from = now - windowMin * 60_000;
  return [...new Set(recent.filter((b) => b.mint === mint && b.t >= from && b.t <= now).map((b) => b.wallet))];
}

export type WalletEdge = { closed: number; wins: number; pnlSol: number };

/**
 * Size factor from a wallet's record with you (0.4× to 1.5×). Needs 5+ closed trades to move.
 * Losing wallets get 0.6×; winning ones up to 1.5× by win rate. A large copy gap (you get much
 * worse prices than they do) cuts it further.
 */
export function recordFactor(r: WalletEdge | null | undefined, medianGapPct: number | null): { factor: number; why: string | null } {
  let f = 1;
  const why: string[] = [];
  if (r && r.closed >= 5) {
    if (r.pnlSol <= 0) {
      f = 0.6;
      why.push(`it has lost you ${r.pnlSol.toFixed(3)} SOL`);
    } else {
      const wr = r.wins / r.closed;
      f = 1 + Math.min(0.5, Math.max(0, wr - 0.4));
      if (f > 1) why.push(`it has made you +${r.pnlSol.toFixed(3)} SOL (${Math.round(wr * 100)}% won)`);
    }
  }
  if (medianGapPct != null && medianGapPct > 10) {
    f *= medianGapPct > 20 ? 0.5 : 0.75;
    why.push(`you copy it ${medianGapPct.toFixed(0)}% worse on price`);
  }
  f = Math.round(Math.min(1.5, Math.max(0.4, f)) * 100) / 100;
  return { factor: f, why: f === 1 ? null : why.join(', ') };
}

export type MoodInput = { solH1Pct: number | null; solH24Pct: number | null; fallingShare: number | null };
export type Mood = { level: 'good' | 'cautious' | 'bad' | 'unknown'; factor: number; why: string };

/**
 * How the market feels right now. bad = no new buys from signals; cautious = half size.
 * fallingShare = share of trending/new coins that are down over the last hour (0..1).
 */
export function moodFrom(m: MoodInput): Mood {
  const { solH1Pct: h1, solH24Pct: h24, fallingShare: fall } = m;
  if (h1 == null && h24 == null && fall == null) return { level: 'unknown', factor: 1, why: 'no market data yet' };
  const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const bad: string[] = [];
  if (h1 != null && h1 <= -4) bad.push(`SOL ${pct(h1)} in the last hour`);
  if (h24 != null && h24 <= -12) bad.push(`SOL ${pct(h24)} today`);
  if (fall != null && fall >= 0.8) bad.push(`${Math.round(fall * 100)}% of trending coins falling`);
  if (bad.length) return { level: 'bad', factor: 0, why: bad.join(', ') };
  const warn: string[] = [];
  if (h1 != null && h1 <= -2) warn.push(`SOL ${pct(h1)} in the last hour`);
  if (h24 != null && h24 <= -6) warn.push(`SOL ${pct(h24)} today`);
  if (fall != null && fall >= 0.65) warn.push(`${Math.round(fall * 100)}% of trending coins falling`);
  if (warn.length) return { level: 'cautious', factor: 0.5, why: warn.join(', ') };
  return { level: 'good', factor: 1, why: [h1 != null ? `SOL ${pct(h1)} in the last hour` : '', fall != null ? `${Math.round(fall * 100)}% of trending coins falling` : ''].filter(Boolean).join(', ') };
}

/** Share of pools that are down over the last hour (null when there is too little data). */
export function fallingShare(pools: { change: { h1: number | null } }[]): number | null {
  const known = pools.filter((p) => p.change.h1 != null);
  if (known.length < 10) return null;
  return known.filter((p) => p.change.h1! < 0).length / known.length;
}
