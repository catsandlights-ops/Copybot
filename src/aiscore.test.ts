import test from 'node:test';
import assert from 'node:assert/strict';
import { scorecard, benchCheck, trackRecord, bySetup, setupAdvice, NO_BENCH, SCORE } from './aiscore';

const H = 3_600_000, D = 24 * H, now = 100 * D;
const clean = (s: unknown, max = 40) => String(s ?? '').slice(0, max);
const dec = (verdict: 'buy' | 'skip', pct: number, t = now - D, size = 1) => ({ t, verdict, baseSol: 0.1, size: verdict === 'buy' ? size : 0, outcomePct: pct });

test('scorecard: buys count at their size, skips count as nothing, the rules buy everything at normal size', () => {
  const c = scorecard([dec('buy', 50, now - D, 2), dec('skip', -80), dec('skip', 20)], now);
  assert.equal(c.n, 3);
  assert.equal(c.bought, 1);
  assert.equal(c.skipped, 2);
  // AI: 0.1 × 2 × 50% = 0.1. Rules: 0.05 - 0.08 + 0.02 = -0.01.
  assert.ok(Math.abs(c.aiSol - 0.1) < 1e-9);
  assert.ok(Math.abs(c.rulesSol + 0.01) < 1e-9);
  assert.ok(c.edgeSol > 0);
  assert.equal(c.dodged, 1);
  assert.equal(c.missed, 1);
  assert.equal(c.verdict, 'too-early');
});

test('scorecard: ignores unchecked, old and non-buy decisions', () => {
  const c = scorecard([dec('buy', 10, now - 30 * D), { t: now - H, verdict: 'skip', baseSol: 0.1 }, { t: now - H, verdict: 'hold', baseSol: 0.1, outcomePct: 5 }, { t: now - H, verdict: 'buy', outcomePct: 5 }], now);
  assert.equal(c.n, 0);
});

test('scorecard: verdicts once there are enough results', () => {
  const good = Array.from({ length: SCORE.minScored }, (_, i) => (i % 2 ? dec('buy', 30) : dec('skip', -60)));
  assert.equal(scorecard(good, now).verdict, 'helping');
  const bad = Array.from({ length: SCORE.minScored }, (_, i) => (i % 2 ? dec('buy', -30) : dec('skip', 60)));
  assert.equal(scorecard(bad, now).verdict, 'hurting');
  const same = Array.from({ length: SCORE.minScored }, () => dec('buy', 10));
  assert.equal(scorecard(same, now).verdict, 'even');
});

test('bench: losing to the rules benches it; beating them while benched brings it back', () => {
  const bad = Array.from({ length: SCORE.minScored }, () => dec('skip', 40));
  const b = benchCheck(NO_BENCH, bad, now);
  assert.ok(b?.benched);
  assert.match(b!.why, /plain rules/);
  // Still benched while there are too few new results...
  assert.equal(benchCheck(b!, [...bad, dec('skip', -50, now + H)], now + 2 * H), null);
  // ...and back once its benched calls would have beaten the rules.
  const later = Array.from({ length: SCORE.backMin }, (_, i) => dec('skip', -50, now + H + i));
  const back = benchCheck(b!, [...bad, ...later], now + 2 * H);
  assert.equal(back?.benched, false);
  // Not benched again while the old losing record is before `since` (you let it decide again).
  assert.equal(benchCheck({ ...NO_BENCH, since: now + 1 }, bad, now + 2), null);
});

test('track record: a summary plus its clearest recent mistakes', () => {
  assert.match(String(trackRecord([], now, clean)), /No results/);
  const t = trackRecord([{ ...dec('skip', 90), symbol: 'MOON', reason: 'too new' }, dec('buy', -50), dec('buy', 5)], now, clean) as Exclude<ReturnType<typeof trackRecord>, string>;
  assert.equal(t.results, 3);
  assert.equal(t.recentMistakes.length, 2);
  assert.deepEqual(t.recentMistakes[0], { you: 'skipped', coin: 'MOON', nextHourPct: 90, yourReason: 'too new' });
});

test('setups: compared per SOL traded; switch suggested only on enough results and a clear gap', () => {
  const mk = (model: string, n: number, pct: number, verdict: 'buy' | 'skip') => Array.from({ length: n }, () => ({ ...dec(verdict, pct), model, costUsd: 0.01 }));
  const ds = [...mk('claude-haiku-5-5', 20, 40, 'skip'), ...mk('claude-opus-5-5', 20, -40, 'skip')];
  const rows = bySetup(ds, now);
  assert.equal(rows[0].model, 'claude-opus-5-5'); // its skips dodged falls: best edge
  assert.ok(rows[0].edgePct > 0 && rows[1].edgePct < 0);
  assert.ok(Math.abs(rows[0].costUsd - 0.2) < 1e-9);
  assert.equal(setupAdvice(rows, 'claude-haiku-5-5')?.to, 'claude-opus-5-5');
  assert.equal(setupAdvice(rows, 'claude-opus-5-5'), null);
  // Too few results on the other setup: no suggestion.
  assert.equal(setupAdvice(bySetup([...mk('claude-haiku-5-5', 20, 40, 'skip'), ...mk('claude-opus-5-5', 5, -40, 'skip')], now), 'claude-haiku-5-5'), null);
});
