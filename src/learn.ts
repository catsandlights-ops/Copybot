/**
 * Learning: Copybot keeps score of the conditions every trade was bought in (coin age, liquidity,
 * market cap, market mood, time of day, chain, where the buy came from) and learns which of them
 * have been losing money for YOU lately. A lesson blocks those buys for a week, then is retired:
 * the next trades of that kind are a fresh test, and only new results can bring the lesson back.
 * Pure: no network, no files.
 */

export type Entry = {
  liqUsd?: number | null;
  ageH?: number | null;
  mcapUsd?: number | null;
  mood?: string | null;
  hour?: number | null; // local hour 0-23
  chain?: string | null;
  kind?: 'wallet' | 'scanner' | 'order' | null;
};

/** One finished sale, with the conditions its position was bought in. */
export type Outcome = { at: number; entry: Entry; pnl: number; cost: number };

export type Lesson = {
  feature: string;
  bucket: string;
  label: string; // "coins under 1 hour old"
  n: number;
  avgPct: number; // average result per trade, % of cost
  pnlSol: number;
  learnedAt: number;
  expiresAt: number;
};
export type Retired = { feature: string; bucket: string; label: string; retiredAt: number };

type Feature = { id: string; bucket: (e: Entry) => string | null; label: (b: string) => string };
const band = (v: number | null | undefined, edges: number[], names: string[]) => (v == null || !Number.isFinite(v) ? null : names[edges.filter((x) => v >= x).length]);
const usd = (n: number) => (n >= 1e6 ? `$${n / 1e6}M` : `$${n / 1e3}K`);

export const FEATURES: Feature[] = [
  {
    id: 'age',
    bucket: (e) => band(e.ageH, [1, 6, 24, 168], ['<1h', '1-6h', '6-24h', '1-7d', '7d+']),
    label: (b) => ({ '<1h': 'coins under 1 hour old', '1-6h': 'coins 1 to 6 hours old', '6-24h': 'coins 6 to 24 hours old', '1-7d': 'coins 1 to 7 days old', '7d+': 'coins over a week old' })[b] ?? b,
  },
  {
    id: 'liquidity',
    bucket: (e) => band(e.liqUsd, [10_000, 25_000, 100_000], ['<10K', '10-25K', '25-100K', '100K+']),
    label: (b) => ({ '<10K': `coins with under ${usd(10_000)} liquidity`, '10-25K': `coins with ${usd(10_000)} to ${usd(25_000)} liquidity`, '25-100K': `coins with ${usd(25_000)} to ${usd(100_000)} liquidity`, '100K+': `coins with over ${usd(100_000)} liquidity` })[b] ?? b,
  },
  {
    id: 'mcap',
    bucket: (e) => band(e.mcapUsd, [100_000, 1_000_000, 10_000_000], ['<100K', '100K-1M', '1-10M', '10M+']),
    label: (b) => ({ '<100K': `coins worth under ${usd(100_000)}`, '100K-1M': `coins worth ${usd(100_000)} to ${usd(1_000_000)}`, '1-10M': `coins worth ${usd(1_000_000)} to ${usd(10_000_000)}`, '10M+': `coins worth over ${usd(10_000_000)}` })[b] ?? b,
  },
  { id: 'mood', bucket: (e) => (e.mood && e.mood !== 'unknown' ? e.mood : null), label: (b) => `buys while the market mood is ${b}` },
  {
    id: 'time',
    bucket: (e) => band(e.hour, [6, 12, 18], ['night', 'morning', 'afternoon', 'evening']),
    label: (b) => ({ night: 'buys at night (midnight to 6 AM)', morning: 'buys in the morning (6 AM to noon)', afternoon: 'buys in the afternoon (noon to 6 PM)', evening: 'buys in the evening (6 PM to midnight)' })[b] ?? b,
  },
  { id: 'chain', bucket: (e) => e.chain ?? null, label: (b) => `buys on ${b === 'base' ? 'Base' : 'Solana'}` },
  { id: 'kind', bucket: (e) => e.kind ?? null, label: (b) => ({ wallet: 'copied buys', scanner: "the scanner's own buys", order: 'your orders' })[b] ?? b },
];

export const LEARN = { windowDays: 14, minTrades: 8, maxAvgPct: -10, worseByPct: 5, maxShare: 0.6, maxLessons: 3, lessonDays: 7 };

export type BucketStat = { feature: string; bucket: string; label: string; n: number; wins: number; avgPct: number; pnlSol: number };

/** Results per condition (only trades whose conditions were recorded). */
export function bucketStats(outs: Outcome[]): BucketStat[] {
  const m = new Map<string, BucketStat & { costSum: number }>();
  for (const o of outs) {
    if (!(o.cost > 0)) continue;
    for (const f of FEATURES) {
      const b = f.bucket(o.entry);
      if (b == null) continue;
      const k = f.id + '|' + b;
      const s = m.get(k) ?? { feature: f.id, bucket: b, label: f.label(b), n: 0, wins: 0, avgPct: 0, pnlSol: 0, costSum: 0 };
      s.n++;
      if (o.pnl > 0) s.wins++;
      s.pnlSol += o.pnl;
      s.avgPct += (o.pnl / o.cost) * 100;
      s.costSum += o.cost;
      m.set(k, s);
    }
  }
  return [...m.values()].map(({ costSum: _c, ...s }) => ({ ...s, avgPct: s.avgPct / s.n }));
}

/**
 * What the last two weeks taught: conditions that clearly lost money (enough trades, a clear
 * average loss, worse than usual). A condition covering most trades isn't a lesson: then the
 * wallets or the market are the problem, not one kind of coin. Retired lessons only count
 * trades made after they were retired (a fresh test).
 */
export function learnLessons(outs: Outcome[], now: number, retired: Retired[] = [], cfg = LEARN): Lesson[] {
  const recent = outs.filter((o) => now - o.at <= cfg.windowDays * 86_400_000 && o.cost > 0);
  if (recent.length < cfg.minTrades) return [];
  const overall = recent.reduce((a, o) => a + (o.pnl / o.cost) * 100, 0) / recent.length;
  const lessons: Lesson[] = [];
  for (const f of FEATURES) {
    const groups = new Map<string, Outcome[]>();
    for (const o of recent) {
      const b = f.bucket(o.entry);
      if (b != null) groups.set(b, [...(groups.get(b) ?? []), o]);
    }
    if (groups.size < 2) continue; // nothing to compare against
    for (const [b, all] of groups) {
      const r = retired.filter((x) => x.feature === f.id && x.bucket === b).reduce((a, x) => Math.max(a, x.retiredAt), 0);
      const g = all.filter((o) => o.at > r);
      if (g.length < cfg.minTrades || g.length / recent.length > cfg.maxShare) continue;
      const avgPct = g.reduce((a, o) => a + (o.pnl / o.cost) * 100, 0) / g.length;
      const pnlSol = g.reduce((a, o) => a + o.pnl, 0);
      if (avgPct > cfg.maxAvgPct || pnlSol >= 0 || avgPct > overall - cfg.worseByPct) continue;
      lessons.push({ feature: f.id, bucket: b, label: f.label(b), n: g.length, avgPct: Math.round(avgPct * 10) / 10, pnlSol, learnedAt: now, expiresAt: now + cfg.lessonDays * 86_400_000 });
    }
  }
  return lessons.sort((a, b) => a.pnlSol - b.pnlSol).slice(0, cfg.maxLessons);
}

/** The lesson (if any) that says not to make this buy. */
export const lessonFor = (lessons: Lesson[], e: Entry, now: number): Lesson | null =>
  lessons.find((l) => l.expiresAt > now && FEATURES.find((f) => f.id === l.feature)?.bucket(e) === l.bucket) ?? null;

/**
 * Merge a fresh learning round into what was known: lessons past their week are retired (their
 * kind of trade gets a fresh chance), new ones are added. Returns what changed, for the journal.
 */
export function updateLessons(current: Lesson[], retired: Retired[], fresh: Lesson[], now: number) {
  const expired = current.filter((l) => l.expiresAt <= now);
  const kept = current.filter((l) => l.expiresAt > now);
  const nextRetired = [...retired.filter((r) => now - r.retiredAt < 60 * 86_400_000), ...expired.map((l) => ({ feature: l.feature, bucket: l.bucket, label: l.label, retiredAt: now }))];
  const added = fresh.filter((f) => !kept.some((k) => k.feature === f.feature && k.bucket === f.bucket));
  return { lessons: [...kept, ...added], retired: nextRetired, added, expired };
}
