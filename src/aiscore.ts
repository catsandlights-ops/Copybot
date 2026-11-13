/**
 * How the AI's buy decisions turned out, compared with what the plain rules would have done.
 *
 * The AI is only asked after every rule has passed, so "the rules alone" would have bought at the
 * normal size. An hour after each decision the bot checks what the same buy would be worth:
 *   - AI bought (size ×k): the AI made k × normal size × change; the rules made normal size × change.
 *   - AI skipped:          the AI made nothing;                    the rules made normal size × change.
 * The difference is what the AI added (or cost). Decisions made while the AI was benched count
 * too (what it *would* have done), so it can earn its way back.
 */

export type ScoredDecision = { t: number; verdict: string; baseSol?: number; size?: number; outcomePct?: number | null; benched?: boolean; symbol?: string; reason?: string };

export type Scorecard = {
  days: number;
  n: number; // decisions with a known result
  bought: number;
  skipped: number;
  boughtAvgPct: number | null; // what the coins it bought did over the next hour
  skippedAvgPct: number | null; // what the coins it skipped did
  dodged: number; // skipped coins that fell
  missed: number; // skipped coins that rose
  aiSol: number; // result of following the AI
  rulesSol: number; // result of following the rules alone
  edgeSol: number; // aiSol - rulesSol
  verdict: 'too-early' | 'helping' | 'hurting' | 'even';
};

export const SCORE = {
  days: 14,
  minScored: 20, // decisions with results before a verdict
  evenPct: 1, // an edge under 1% of the money involved counts as even
  backDays: 7, // a benched AI comes back when it would have done better than the rules over this long...
  backMin: 15, // ...with at least this many results
};

const scored = (ds: ScoredDecision[], from: number) =>
  ds.filter((d) => d.t >= from && (d.verdict === 'buy' || d.verdict === 'skip') && typeof d.outcomePct === 'number' && Number.isFinite(d.outcomePct) && (d.baseSol ?? 0) > 0);

export function scorecard(ds: ScoredDecision[], now: number, days = SCORE.days, since = 0): Scorecard {
  const list = scored(ds, Math.max(now - days * 86_400_000, since));
  let aiSol = 0, rulesSol = 0, involved = 0;
  const b: number[] = [], s: number[] = [];
  for (const d of list) {
    const pct = d.outcomePct as number, base = d.baseSol as number;
    const rules = (base * pct) / 100;
    rulesSol += rules;
    involved += base;
    if (d.verdict === 'buy') {
      const size = Number.isFinite(d.size) && (d.size as number) > 0 ? (d.size as number) : 1;
      aiSol += rules * size;
      b.push(pct);
    } else s.push(pct);
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const edgeSol = aiSol - rulesSol;
  const verdict = list.length < SCORE.minScored ? 'too-early' : Math.abs(edgeSol) < (involved * SCORE.evenPct) / 100 ? 'even' : edgeSol > 0 ? 'helping' : 'hurting';
  return { days, n: list.length, bought: b.length, skipped: s.length, boughtAvgPct: avg(b), skippedAvgPct: avg(s), dodged: s.filter((p) => p < 0).length, missed: s.filter((p) => p > 0).length, aiSol, rulesSol, edgeSol, verdict };
}

export type Bench = { benched: boolean; at: number; why: string; since: number };
export const NO_BENCH: Bench = { benched: false, at: 0, why: '', since: 0 };

/**
 * Should the AI stop deciding buys (or start again)? Returns the new state when it changes.
 * `since`: results before this don't count (set when you let it decide again by hand).
 */
export function benchCheck(cur: Bench, ds: ScoredDecision[], now: number): Bench | null {
  if (!cur.benched) {
    const c = scorecard(ds, now, SCORE.days, cur.since);
    if (c.verdict !== 'hurting') return null;
    return { benched: true, at: now, since: cur.since, why: `Over the last ${c.n} results, following the AI made ${fmt(c.aiSol)} SOL and the plain rules would have made ${fmt(c.rulesSol)} SOL.` };
  }
  const c = scorecard(ds, now, SCORE.backDays, cur.at);
  if (c.n < SCORE.backMin || c.edgeSol <= 0) return null;
  return { benched: false, at: now, since: cur.since, why: `While benched, the AI's calls would have made ${fmt(c.aiSol)} SOL against ${fmt(c.rulesSol)} SOL for the rules (${c.n} results).` };
}

const fmt = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;
const pct = (x: number | null) => (x == null ? null : Math.round(x));

/** A short summary of its own record, put in front of the AI before each buy decision. */
export function trackRecord(ds: ScoredDecision[], now: number, clean: (s: unknown, max?: number) => string) {
  const c = scorecard(ds, now);
  if (!c.n) return 'No results yet: this is one of your first decisions.';
  // The clearest recent mistakes, so it can see what it got wrong.
  const list = scored(ds, now - SCORE.days * 86_400_000);
  const mistakes = list
    .filter((d) => (d.verdict === 'skip' && (d.outcomePct as number) >= 30) || (d.verdict === 'buy' && (d.outcomePct as number) <= -30))
    .slice(-5)
    .map((d) => ({ you: d.verdict === 'buy' ? 'bought' : 'skipped', coin: clean(d.symbol, 16) || '?', nextHourPct: pct(d.outcomePct as number), yourReason: clean(d.reason, 140) }));
  return {
    lastDays: c.days,
    results: c.n,
    youBought: { count: c.bought, avgNextHourPct: pct(c.boughtAvgPct) },
    youSkipped: { count: c.skipped, avgNextHourPct: pct(c.skippedAvgPct), fell: c.dodged, rose: c.missed },
    followingYouSol: +c.aiSol.toFixed(4),
    rulesAloneSol: +c.rulesSol.toFixed(4),
    verdict: c.verdict === 'too-early' ? 'not enough results yet' : c.verdict === 'helping' ? 'you are beating the plain rules' : c.verdict === 'hurting' ? 'the plain rules are beating you: be more willing to follow them (buy at normal size) unless you see a clear reason' : 'about the same as the plain rules',
    recentMistakes: mistakes,
  };
}

// ---------- part 4: which AI setup does best ----------

/** The AI that made a decision: "claude-opus-5-5", or "ollama:qwen2.5:7b" for a local model. */
export type SetupRow = { model: string; n: number; edgeSol: number; involvedSol: number; edgePct: number; costUsd: number };

/** Each AI setup's buy calls over the last `days`: how much better (or worse) than the plain rules, per SOL traded. */
export function bySetup(ds: (ScoredDecision & { model?: string; costUsd?: number })[], now: number, days = 30): SetupRow[] {
  const groups = new Map<string, typeof ds>();
  for (const d of ds) if (d.model && d.t >= now - days * 86_400_000) groups.set(d.model, [...(groups.get(d.model) ?? []), d]);
  return [...groups].map(([model, list]) => {
    const c = scorecard(list, now, days);
    const involved = scored(list, now - days * 86_400_000).reduce((a, d) => a + (d.baseSol as number), 0);
    return { model, n: c.n, edgeSol: c.edgeSol, involvedSol: involved, edgePct: involved ? (c.edgeSol / involved) * 100 : 0, costUsd: list.reduce((a, d) => a + (d.costUsd ?? 0), 0) };
  }).sort((a, b) => b.edgePct - a.edgePct);
}

export const SETUP = { minScored: 20, betterByPct: 2 };

/** Suggest switching when another setup you've tried did clearly better per SOL traded, on enough results. */
export function setupAdvice(rows: SetupRow[], current: string): { to: string; why: string } | null {
  const cur = rows.find((r) => r.model === current);
  const best = rows.find((r) => r.model !== current && r.n >= SETUP.minScored);
  if (!cur || cur.n < SETUP.minScored || !best || best.edgePct - cur.edgePct < SETUP.betterByPct) return null;
  return { to: best.model, why: `${best.model} added ${best.edgePct.toFixed(1)}% per SOL traded over the rules (${best.n} results), against ${cur.edgePct.toFixed(1)}% for ${cur.model} (${cur.n} results).` };
}
