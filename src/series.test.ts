import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downsample, pushPoint, runningTotal, since, type Pt } from './series';

test('pushPoint: keeps order, thins the older half when full', () => {
  const a: Pt[] = [];
  for (let i = 0; i < 10; i++) pushPoint(a, [i, i], 8);
  assert.ok(a.length <= 8);
  assert.deepEqual(a[a.length - 1], [9, 9]); // the newest point is always kept
  assert.deepEqual(a.slice(-3), [[7, 7], [8, 8], [9, 9]]); // recent detail stays
  for (let i = 1; i < a.length; i++) assert.ok(a[i][0] > a[i - 1][0]);
  pushPoint(a, [5, 99]); // out of order: ignored
  assert.deepEqual(a[a.length - 1], [9, 9]);
  const big: Pt[] = [];
  for (let i = 0; i < 5000; i++) pushPoint(big, [i, 0], 400);
  assert.ok(big.length <= 400 && big[0][0] === 0 && big[big.length - 1][0] === 4999);
});

test('downsample, since and runningTotal', () => {
  const a: Pt[] = Array.from({ length: 101 }, (_, i) => [i, i]);
  const d = downsample(a, 11);
  assert.equal(d.length, 11);
  assert.deepEqual(d[0], [0, 0]);
  assert.deepEqual(d[10], [100, 100]);
  assert.equal(downsample(a.slice(0, 5), 11).length, 5);
  assert.equal(since(a, 95).length, 6);
  assert.deepEqual(runningTotal([{ t: 3, v: -1 }, { t: 1, v: 2 }, { t: 2, v: 0.5 }]), [[1, 2], [2, 2.5], [3, 1.5]]);
});
