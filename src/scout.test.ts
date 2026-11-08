import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCandidates, pickTokens, rulePicks, ruleScore } from './scout';
import type { PoolRow } from './markets';
import type { Report } from './analyze';

const now = Date.UTC(2026, 10, 9, 12);
const H = 3_600_000;
const row = (o: Partial<PoolRow> & { mint: string }): PoolRow => ({
  pool: 'P' + o.mint, symbol: o.mint, name: o.mint, image: null, priceUsd: 1,
  change: { h1: 0, h24: 100 }, volume24h: 500_000, liquidityUsd: 80_000, marketCapUsd: 1e6,
  createdAt: now - 24 * H, buys24h: 5000, sells24h: 4000, ...o,
});

test('pickTokens: pumped, 3h–7d old, liquid, not too busy; best first; no duplicates or SOL/USDC', () => {
  const t = pickTokens([
    row({ mint: 'A', change: { h1: 0, h24: 80 } }),
    row({ mint: 'B', change: { h1: 0, h24: 300 } }),
    row({ mint: 'B', change: { h1: 0, h24: 300 } }),
    row({ mint: 'FLAT', change: { h1: 0, h24: 10 } }),
    row({ mint: 'BABY', createdAt: now - 1 * H }),
    row({ mint: 'OLD', createdAt: now - 30 * 24 * H }),
    row({ mint: 'THIN', liquidityUsd: 5_000 }),
    row({ mint: 'BUSY', buys24h: 60_000 }),
    row({ mint: 'NODATE', createdAt: null }),
    row({ mint: 'So11111111111111111111111111111111111111112' }),
  ], now);
  assert.deepEqual(t.map((x) => x.mint), ['B', 'A']);
  assert.equal(t[0].ageHours, 24);
  assert.equal(pickTokens(Array.from({ length: 9 }, (_, i) => row({ mint: 'T' + i })), now, 5).length, 5);
});

test('pickCandidates: multi-token early buyers and top traders first; skips copied wallets and dust', () => {
  const sym = new Map([['m1', 'AAA'], ['m2', 'BBB']]);
  const c = pickCandidates(
    [
      { wallet: 'one-hit-dust', mints: ['m1'], sol: 0.1 },
      { wallet: 'one-hit-big', mints: ['m1'], sol: 3 },
      { wallet: 'double', mints: ['m1', 'm2'], sol: 0.4 },
      { wallet: 'mine', mints: ['m1', 'm2'], sol: 9 },
    ],
    new Map([['trader', ['AAA']], ['one-hit-big', ['BBB']]]),
    sym,
    new Set(['mine']),
  );
  assert.deepEqual(c.map((x) => x.wallet), ['double', 'one-hit-big', 'trader']);
  assert.deepEqual(c[0].earlyOn, ['AAA', 'BBB']);
  assert.deepEqual(c[1].topTraderOn, ['BBB']);
});

const rep = (o: Partial<Report>): Report => ({
  wallet: 'W', swaps: 100, days: 10, tradesPerDay: 10, tokens: 30, closedTokens: 25, winRate: 0.55,
  realizedPnlSol: 12, spentOnClosedSol: 20, roiPct: 60, medianBuySol: 1, medianHoldMin: 45, notes: [], ...o,
});

test('ruleScore rejects bots, too-fast exits, losers and thin records', () => {
  assert.ok(ruleScore(rep({})) > 0);
  assert.equal(ruleScore(rep({ tradesPerDay: 400 })), -1);
  assert.equal(ruleScore(rep({ medianHoldMin: 0.5 })), -1);
  assert.equal(ruleScore(rep({ roiPct: -10, realizedPnlSol: -2 })), -1);
  assert.equal(ruleScore(rep({ closedTokens: 4 })), -1);
});

test('rulePicks ranks the best and explains why', () => {
  const p = rulePicks([rep({ wallet: 'ok' }), rep({ wallet: 'great', winRate: 0.7, roiPct: 150 }), rep({ wallet: 'bot', tradesPerDay: 900 })], 3);
  assert.deepEqual(p.map((x) => x.address), ['great', 'ok']);
  assert.match(p[0].reason, /70% win rate on 25 closed trades/);
});
