/**
 * Shadow copying: a wallet is watched and copied VIRTUALLY (no money, nothing touches your limits,
 * even in live mode). Each of its buys and sells is replayed at your buy size, at its own fill price
 * made worse by your copy delay, plus network fees. When the virtual results prove it in your own
 * conditions, it's promoted to real copying; if it keeps losing, it's dropped. Pure: no files, no network.
 */

export type ShadowPos = { cost: number; tokens: number; openedAt: number };
export type ShadowTrade = { wallet: string; mint: string; t: number; cost: number; proceeds: number };
export type ShadowBook = { open: Record<string, Record<string, ShadowPos>>; closed: ShadowTrade[]; since: Record<string, number> };

export const SHADOW = { minClosed: 8, minDays: 1, minProfitFactor: 1.3, dropAfter: 15, max: 8, feeSol: 0.0002 };

export const emptyBook = (): ShadowBook => ({ open: {}, closed: [], since: {} });

/** Their buy, copied virtually: `sol` at their price per raw token made worse by the copy gap. */
export function shadowBuy(b: ShadowBook, wallet: string, mint: string, sol: number, theirSolPerRaw: number, gapPct: number, now: number): boolean {
  if (!(sol > 0) || !(theirSolPerRaw > 0)) return false;
  const open = (b.open[wallet] ??= {});
  if (open[mint]) return false; // like "don't buy more of a token you hold"
  b.since[wallet] ??= now;
  open[mint] = { cost: sol + SHADOW.feeSol, tokens: sol / (theirSolPerRaw * (1 + gapPct / 100)), openedAt: now };
  return true;
}

/** Their sell of `fraction` of their tokens: the same share of the virtual position, at their price less the gap. */
export function shadowSell(b: ShadowBook, wallet: string, mint: string, fraction: number, theirSolPerRaw: number, gapPct: number, now: number): ShadowTrade | null {
  const p = b.open[wallet]?.[mint];
  if (!p || !(fraction > 0) || !(theirSolPerRaw > 0)) return null;
  const f = Math.min(1, fraction >= 0.95 ? 1 : fraction);
  const tokens = p.tokens * f;
  const cost = p.cost * f;
  const proceeds = Math.max(0, tokens * theirSolPerRaw * (1 - gapPct / 100) - SHADOW.feeSol);
  p.tokens -= tokens;
  p.cost -= cost;
  if (f >= 1 || p.tokens <= 0) delete b.open[wallet][mint];
  const t: ShadowTrade = { wallet, mint, t: now, cost, proceeds };
  b.closed.push(t);
  if (b.closed.length > 5000) b.closed = b.closed.slice(-5000);
  return t;
}

export type ShadowStats = { closed: number; wins: number; pnlSol: number; profitFactor: number | null; days: number; open: number };

export function shadowStats(b: ShadowBook, wallet: string, now: number): ShadowStats {
  const mine = b.closed.filter((t) => t.wallet === wallet && t.t >= (b.since[wallet] ?? 0));
  const pnl = mine.map((t) => t.proceeds - t.cost);
  const won = pnl.filter((x) => x > 0).reduce((a, x) => a + x, 0);
  const lost = -pnl.filter((x) => x < 0).reduce((a, x) => a + x, 0);
  return {
    closed: mine.length,
    wins: pnl.filter((x) => x > 0).length,
    pnlSol: pnl.reduce((a, x) => a + x, 0),
    profitFactor: lost > 0 ? won / lost : won > 0 ? null : 0,
    days: b.since[wallet] != null ? (now - b.since[wallet]) / 86_400_000 : 0,
    open: Object.keys(b.open[wallet] ?? {}).length,
  };
}

/** Has the shadow wallet earned real copying ('promote'), shown it won't ('drop'), or is it still being tested? */
export function shadowVerdict(s: ShadowStats): { verdict: 'promote' | 'drop' | 'testing'; why: string } {
  const pf = s.profitFactor == null ? Infinity : s.profitFactor;
  if (s.closed >= SHADOW.minClosed && s.days >= SHADOW.minDays && s.pnlSol > 0 && pf >= SHADOW.minProfitFactor)
    return { verdict: 'promote', why: `${s.closed} virtual trades, ${s.pnlSol >= 0 ? '+' : ''}${s.pnlSol.toFixed(3)} SOL, won ${(pf === Infinity ? 'every one' : `${pf.toFixed(1)}× what it lost`)}` };
  if (s.closed >= SHADOW.dropAfter && s.pnlSol <= 0) return { verdict: 'drop', why: `${s.closed} virtual trades and still losing (${s.pnlSol.toFixed(3)} SOL)` };
  const need: string[] = [];
  if (s.closed < SHADOW.minClosed) need.push(`${SHADOW.minClosed - s.closed} more finished trade${SHADOW.minClosed - s.closed === 1 ? '' : 's'}`);
  if (s.days < SHADOW.minDays) need.push('a full day');
  if (s.closed >= SHADOW.minClosed && s.pnlSol <= 0) need.push('a profit');
  else if (s.closed >= SHADOW.minClosed && pf < SHADOW.minProfitFactor) need.push(`to win ${SHADOW.minProfitFactor}× what it loses`);
  return { verdict: 'testing', why: `needs ${need.join(' and ') || 'a little more time'}` };
}

/** Restart a wallet's shadow test (e.g. when a paused wallet goes into shadow): only new trades count. */
export function restartShadow(b: ShadowBook, wallet: string, now: number) {
  b.since[wallet] = now;
  delete b.open[wallet];
}
