import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketStats, learnLessons, lessonFor, updateLessons, type Outcome } from './learn';

const D = 86_400_000;
const now = 100 * D;
// 10 trades in coins under 1 hour old losing 30%, 10 in older coins winning 20%.
const young = (i: number): Outcome => ({ at: now - i * 3_600_000, entry: { ageH: 0.5, liqUsd: 30_000, kind: 'wallet', chain: 'solana' }, pnl: -0.015, cost: 0.05 });
const older = (i: number): Outcome => ({ at: now - i * 3_600_000, entry: { ageH: 30, liqUsd: 30_000, kind: 'wallet', chain: 'solana' }, pnl: 0.01, cost: 0.05 });
const outs = [...Array.from({ length: 10 }, (_, i) => young(i)), ...Array.from({ length: 10 }, (_, i) => older(i))];

test('learning: finds the kind of trade that keeps losing, and only that', () => {
  const l = learnLessons(outs, now);
  assert.equal(l.length, 1);
  assert.equal(l[0].label, 'coins under 1 hour old');
  assert.equal(l[0].n, 10);
  assert.equal(l[0].avgPct, -30);
  assert.ok(lessonFor(l, { ageH: 0.2 }, now));
  assert.equal(lessonFor(l, { ageH: 3 }, now), null);
  assert.equal(lessonFor(l, {}, now), null); // unknown age: not blocked
  assert.equal(lessonFor(l, { ageH: 0.2 }, l[0].expiresAt + 1), null); // a week later it no longer blocks
  const s = bucketStats(outs).find((b) => b.feature === 'age' && b.bucket === '<1h')!;
  assert.deepEqual([s.n, s.wins, Math.round(s.avgPct)], [10, 0, -30]);
});

test('learning: no lesson from too few trades, old trades, small losses, or when everything loses', () => {
  assert.deepEqual(learnLessons(outs.slice(0, 5).concat(outs.slice(10, 15)), now), []); // 5 each: too few
  assert.deepEqual(learnLessons(outs.map((o) => ({ ...o, at: o.at - 20 * D })), now), []); // older than 2 weeks
  assert.deepEqual(learnLessons(outs.map((o) => (o.pnl < 0 ? { ...o, pnl: -0.002 } : o)), now), []); // -4%: not a clear loss
  // Everything loses: no single kind of trade is to blame (the wallets are).
  assert.deepEqual(learnLessons(outs.map((o) => ({ ...o, pnl: -0.015 })), now), []);
});

test('learning: a lesson expires, is retired, and only new trades can bring it back', () => {
  let st = updateLessons([], [], learnLessons(outs, now), now);
  assert.equal(st.added.length, 1);
  const later = now + 8 * D;
  st = updateLessons(st.lessons, st.retired, [], later);
  assert.equal(st.expired.length, 1);
  assert.equal(st.lessons.length, 0);
  // The same old trades don't bring it back...
  assert.deepEqual(learnLessons(outs.map((o) => ({ ...o, at: o.at + 7 * D })), later, st.retired), []);
  // ...but 8 new losing trades of that kind after the retest do.
  const fresh = [...outs.map((o) => ({ ...o, at: o.at + 7 * D })), ...Array.from({ length: 8 }, (_, i) => ({ ...young(0), at: later + (i + 1) * 3_600_000 }))];
  const back = learnLessons(fresh, later + D, st.retired);
  assert.equal(back[0]?.label, 'coins under 1 hour old');
});
