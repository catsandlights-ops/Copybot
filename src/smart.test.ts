import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consensusWallets, fallingShare, moodFrom, recordFactor } from './smart';

test('consensusWallets: distinct wallets on the same coin inside the window', () => {
  const now = 1_000_000_000;
  const recent = [
    { mint: 'A', wallet: 'w1', t: now - 60_000 },
    { mint: 'A', wallet: 'w1', t: now - 30_000 }, // same wallet twice counts once
    { mint: 'A', wallet: 'w2', t: now - 5 * 60_000 },
    { mint: 'A', wallet: 'w3', t: now - 20 * 60_000 }, // too long ago
    { mint: 'B', wallet: 'w4', t: now },
  ];
  assert.deepEqual(consensusWallets(recent, 'A', now, 10).sort(), ['w1', 'w2']);
  assert.deepEqual(consensusWallets(recent, 'A', now, 30).length, 3);
  assert.deepEqual(consensusWallets(recent, 'C', now, 10), []);
});

test('recordFactor: needs 5 closed trades; winners up to 1.5x, losers 0.6x, late copies cut', () => {
  assert.deepEqual(recordFactor(null, null), { factor: 1, why: null });
  assert.equal(recordFactor({ closed: 3, wins: 3, pnlSol: 1 }, null).factor, 1);
  assert.equal(recordFactor({ closed: 10, wins: 9, pnlSol: 0.5 }, null).factor, 1.5);
  assert.equal(recordFactor({ closed: 10, wins: 6, pnlSol: 0.2 }, null).factor, 1.2);
  const lose = recordFactor({ closed: 10, wins: 2, pnlSol: -0.3 }, null);
  assert.equal(lose.factor, 0.6);
  assert.match(lose.why!, /lost you -0\.300 SOL/);
  assert.equal(recordFactor(null, 15).factor, 0.75);
  assert.equal(recordFactor({ closed: 10, wins: 2, pnlSol: -0.3 }, 25).factor, 0.4); // floor
  assert.match(recordFactor(null, 15).why!, /15% worse on price/);
});

test('moodFrom: bad stops buys, cautious halves them', () => {
  assert.equal(moodFrom({ solH1Pct: null, solH24Pct: null, fallingShare: null }).level, 'unknown');
  assert.deepEqual(moodFrom({ solH1Pct: 1, solH24Pct: 3, fallingShare: 0.4 }).factor, 1);
  const bad = moodFrom({ solH1Pct: -5, solH24Pct: -2, fallingShare: 0.5 });
  assert.equal(bad.level, 'bad');
  assert.equal(bad.factor, 0);
  assert.match(bad.why, /SOL -5\.0% in the last hour/);
  assert.equal(moodFrom({ solH1Pct: 0, solH24Pct: 0, fallingShare: 0.85 }).level, 'bad');
  const c = moodFrom({ solH1Pct: -2.5, solH24Pct: 0, fallingShare: 0.3 });
  assert.equal(c.level, 'cautious');
  assert.equal(c.factor, 0.5);
});

test('fallingShare: share of coins down over the hour, needs 10+', () => {
  const pools = (ups: number, downs: number) => [...Array(ups).fill({ change: { h1: 5 } }), ...Array(downs).fill({ change: { h1: -5 } })];
  assert.equal(fallingShare(pools(3, 3)), null);
  assert.equal(fallingShare(pools(2, 8)), 0.8);
  assert.equal(fallingShare([...pools(5, 5), { change: { h1: null } }]), 0.5);
});
