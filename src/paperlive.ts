/**
 * "Paper vs live": how much worse real trades did than paper mode would have booked them. Each live
 * trade carries its paper twin (the quote just before sending, with paper's fee estimate), so the
 * gap is measured trade by trade: buys that cost more, sells that brought in less, and trades that
 * failed (paper would have booked them). Pure (unit-tested).
 */
type T = { t: number; mode: string; side: string; chain?: string; mint: string; sol: number; tokenRaw: string; paperSol?: number; paperRaw?: string };
type F = { t: number; chain?: string; side: string };

export type ChainGap = {
  chain: 'solana' | 'base';
  trades: number; // live trades with a paper twin
  failed: number; // live trades that failed for good
  buyWorsePct: number | null; // average: how much more a buy cost than paper's price (+ = worse)
  sellWorsePct: number | null; // average: how much less a sell brought in than paper's price (+ = worse)
  gapSol: number; // SOL the live trades lost compared with paper (+ = live did worse)
  volumeSol: number; // SOL traded live
  gapPct: number | null; // gapSol as a share of the volume: how much rosier paper results are
};

const chainOf = (x: { chain?: string; mint?: string }) => (x.chain === 'base' || /^0x[0-9a-fA-F]{40}$/.test(x.mint ?? '') ? 'base' : 'solana');

/** One trade's gap in SOL, for the same number of tokens (+ = live did worse than paper). */
export function tradeGapSol(t: T): number | null {
  const raw = Number(t.tokenRaw), praw = Number(t.paperRaw);
  if (t.paperSol == null || !(raw > 0) || !(praw > 0) || !(t.paperSol >= 0)) return null;
  const paperForSame = (t.paperSol / praw) * raw; // paper's price, for the tokens really traded
  return t.side === 'buy' ? t.sol - paperForSame : paperForSame - t.sol;
}

export function paperVsLive(trades: T[], failures: F[], since = 0): { chains: ChainGap[]; total: ChainGap | null; text: string } {
  const live = trades.filter((t) => t.mode === 'live' && t.t >= since && t.paperSol != null && t.paperRaw);
  const chains: ChainGap[] = [];
  for (const chain of ['solana', 'base'] as const) {
    const mine = live.filter((t) => chainOf(t) === chain);
    const failed = failures.filter((f) => f.t >= since && chainOf(f) === chain).length;
    if (!mine.length && !failed) continue;
    const pct = (side: string) => {
      const xs = mine.filter((t) => t.side === side).flatMap((t) => {
        const g = tradeGapSol(t);
        const base = t.side === 'buy' ? t.sol - (g ?? 0) : t.sol + (g ?? 0); // paper's SOL for the same tokens
        return g == null || !(base > 0) ? [] : [(g / base) * 100];
      });
      return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
    };
    const gapSol = mine.reduce((a, t) => a + (tradeGapSol(t) ?? 0), 0);
    const volumeSol = mine.reduce((a, t) => a + t.sol, 0);
    chains.push({ chain, trades: mine.length, failed, buyWorsePct: pct('buy'), sellWorsePct: pct('sell'), gapSol, volumeSol, gapPct: volumeSol > 0 ? (gapSol / volumeSol) * 100 : null });
  }
  if (!chains.length) return { chains, total: null, text: 'No live trades yet. Once you trade live, this compares every real fill with what paper mode would have booked.' };
  const sum = (k: 'trades' | 'failed' | 'gapSol' | 'volumeSol') => chains.reduce((a, c) => a + c[k], 0);
  const total: ChainGap = { chain: 'solana', trades: sum('trades'), failed: sum('failed'), buyWorsePct: null, sellWorsePct: null, gapSol: sum('gapSol'), volumeSol: sum('volumeSol'), gapPct: sum('volumeSol') > 0 ? (sum('gapSol') / sum('volumeSol')) * 100 : null };
  const failRate = total.trades + total.failed > 0 ? (total.failed / (total.trades + total.failed)) * 100 : 0;
  let text: string;
  if (total.trades < 10) text = `Only ${total.trades} live trade${total.trades === 1 ? '' : 's'} so far: give it a few more before trusting the numbers.`;
  else if ((total.gapPct ?? 0) <= 1.5 && failRate <= 5) text = `Live trades match paper closely (${fmt(total.gapPct)} of the money traded${failRate ? `, ${failRate.toFixed(0)}% failed` : ''}): your paper results can be trusted.`;
  else if ((total.gapPct ?? 0) <= 4 && failRate <= 15) text = `Live does a little worse than paper (${fmt(total.gapPct)} of the money traded${failRate ? `, ${failRate.toFixed(0)}% failed` : ''}): take that much off paper results when you judge them.`;
  else text = `Live does clearly worse than paper (${fmt(total.gapPct)} of the money traded${failRate ? `, ${failRate.toFixed(0)}% failed` : ''}). Paper results look better than reality: check Speed settings (priority fee, private RPC) and the slippage limit.`;
  return { chains, total, text };
}

const fmt = (p: number | null) => (p == null ? '—' : `${p >= 0 ? '' : '−'}${Math.abs(p).toFixed(1)}%`);
