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

test('pickTokens: moving 30%+ (6h or 24h), 1h–14d old, liquid; best first; one entry per token; quiet flag', () => {
  const t = pickTokens([
    row({ mint: 'A', change: { h1: 0, h24: 80 } }),
    row({ mint: 'B', change: { h1: 0, h24: 300 } }),
    row({ mint: 'B', change: { h1: 0, h24: 300 }, liquidityUsd: 500_000, pool: 'PB-main' }), // same token, bigger pool
    row({ mint: 'SIXH', change: { h1: 0, h6: 120, h24: 10 } }), // moving in the last 6h only
    row({ mint: 'FLAT', change: { h1: 0, h6: 5, h24: 10 } }),
    row({ mint: 'BABY', createdAt: now - 0.5 * H }),
    row({ mint: 'OLD', createdAt: now - 30 * 24 * H }),
    row({ mint: 'WEEKOLD', createdAt: now - 7 * 24 * H }), // allowed now, but too much history for early buyers
    row({ mint: 'THIN', liquidityUsd: 5_000 }),
    row({ mint: 'NODATE', createdAt: null }),
    row({ mint: 'So11111111111111111111111111111111111111112' }),
  ], now, 10);
  assert.deepEqual(t.map((x) => x.mint), ['B', 'SIXH', 'WEEKOLD', 'A']);
  assert.equal(t[0].pool, 'PB-main');
  assert.equal(t.find((x) => x.mint === 'A')!.quiet, true);
  assert.equal(t.find((x) => x.mint === 'WEEKOLD')!.quiet, false);
  assert.equal(pickTokens(Array.from({ length: 9 }, (_, i) => row({ mint: 'T' + i })), now).length, 6);
});

test('pickTokens: tokens from recent searches go to the back so searches vary', () => {
  const rows = [row({ mint: 'TOP', change: { h1: 0, h24: 500 } }), row({ mint: 'NEXT', change: { h1: 0, h24: 100 } }), row({ mint: 'LAST', change: { h1: 0, h24: 50 } })];
  assert.deepEqual(pickTokens(rows, now, 2).map((x) => x.mint), ['TOP', 'NEXT']);
  assert.deepEqual(pickTokens(rows, now, 2, new Set(['TOP'])).map((x) => x.mint), ['NEXT', 'LAST']);
});

test('pumpBuyers: recent big buys now up 40%+', async () => {
  const { pumpBuyers } = await import('./scout');
  const b = pumpBuyers([
    { kind: 'buy', wallet: 'early', usd: 1000, priceUsd: 1 },
    { kind: 'buy', wallet: 'early', usd: 500, priceUsd: 0.5 }, // keeps the best gain
    { kind: 'buy', wallet: 'late', usd: 1000, priceUsd: 2.5 },
    { kind: 'buy', wallet: 'tiny', usd: 50, priceUsd: 0.5 },
    { kind: 'sell', wallet: 'seller', usd: 1000, priceUsd: 0.5 },
  ], 3);
  assert.deepEqual([...b.entries()], [['early', 500]]);
  assert.equal(pumpBuyers([{ kind: 'buy', wallet: 'x', usd: 1000, priceUsd: 1 }], null).size, 0);
});

test('pickCandidates: wallets seen on several tokens first, any source; skips copied wallets and dust', () => {
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
    12,
    new Map([['pumper', ['CCC']], ['double', ['CCC']]]),
  );
  assert.deepEqual(c.map((x) => x.wallet), ['double', 'one-hit-big', 'trader', 'pumper']);
  assert.deepEqual(c[0].pumpOn, ['CCC']);
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

test('passesBasics: the hard floor for any scout pick', async () => {
  const { passesBasics } = await import('./scout');
  assert.equal(passesBasics(rep({})), true);
  // The wallet the first real scout run surfaced: losing money and trading 269 times a day.
  assert.equal(passesBasics(rep({ closedTokens: 10, winRate: 0.4, realizedPnlSol: -1.44, roiPct: -6, tradesPerDay: 269, medianHoldMin: 72 })), false);
});
