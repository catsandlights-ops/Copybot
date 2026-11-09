import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodKey, profitReport, taxCsv, taxRows, taxSummary, type ReportTrade } from './report';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

test('periodKey: day, Monday-start week, month (local time)', () => {
  const wed = at(2026, 11, 11);
  assert.equal(periodKey(wed, 'day'), '2026-11-11');
  assert.equal(periodKey(wed, 'week'), '2026-11-09');
  assert.equal(periodKey(at(2026, 11, 9), 'week'), '2026-11-09'); // Monday itself
  assert.equal(periodKey(at(2026, 11, 15), 'week'), '2026-11-09'); // Sunday belongs to the week before
  assert.equal(periodKey(wed, 'month'), '2026-11');
});

const W1 = 'WaLLet1', W2 = 'WaLLet2';
const trades: ReportTrade[] = [
  { t: at(2026, 11, 9), mode: 'live', side: 'buy', mint: 'A', sol: 1, tokenRaw: '1000000', source: W1 },
  { t: at(2026, 11, 9, 14), mode: 'live', side: 'sell', mint: 'A', sol: 1.5, tokenRaw: '1000000', pnl: 0.5, sources: [W1], reason: 'take-profit' },
  { t: at(2026, 11, 10), mode: 'live', side: 'buy', mint: 'B', sol: 1, tokenRaw: '200', source: W2 },
  { t: at(2026, 11, 10, 15), mode: 'live', side: 'sell', mint: 'B', sol: 0.7, tokenRaw: '200', pnl: -0.3, sources: [W2], reason: 'stop-loss' },
  { t: at(2026, 11, 10, 16), mode: 'paper', side: 'sell', mint: 'C', sol: 9, pnl: 8, sources: [W1] },
];

test('profitReport: per period newest first, totals, best/worst, per source; one mode only', () => {
  const r = profitReport(trades, 'live', 'day');
  assert.deepEqual(r.rows.map((x) => [x.key, x.sells, x.wins, +x.pnlSol.toFixed(3)]), [['2026-11-10', 1, 0, -0.3], ['2026-11-09', 1, 1, 0.5]]);
  assert.equal(+r.totals.pnlSol.toFixed(3), 0.2);
  assert.equal(r.totals.buys, 2);
  assert.equal(r.best[0].mint, 'A');
  assert.equal(r.worst[0].mint, 'B');
  assert.deepEqual(r.bySource.map((s) => s.source), [W1, W2]);
  assert.equal(profitReport(trades, 'live', 'week').rows.length, 1);
  assert.equal(profitReport(trades, 'paper', 'day').totals.pnlSol, 8);
});

test('taxRows: USD at trade time and average-cost gains per token, across partial sells', () => {
  const t0 = at(2025, 12, 30);
  const log: ReportTrade[] = [
    { t: t0, mode: 'live', side: 'buy', mint: 'X', sol: 1, tokenRaw: '100', sig: 'sigA' }, // 1 SOL at $100 = $100 for 100 tokens
    { t: t0 + 86_400_000, mode: 'live', side: 'buy', mint: 'X', sol: 1, tokenRaw: '100' }, // 1 SOL at $200 = $200 for 100 more
    { t: t0 + 3 * 86_400_000, mode: 'live', side: 'sell', mint: 'X', sol: 1.5, tokenRaw: '100' }, // half: 1.5 SOL at $200 = $300, cost $150
    { t: t0 + 4 * 86_400_000, mode: 'live', side: 'sell', mint: 'X', sol: 0.5, tokenRaw: '100', sig: 'PAPER' }, // rest: $100, cost $150
    { t: t0, mode: 'paper', side: 'buy', mint: 'Y', sol: 5, tokenRaw: '1' },
  ];
  const price = (t: number) => (t < t0 + 86_400_000 ? 100 : 200);
  const rows = taxRows(log, 'live', price, new Map([['X', 2]]), new Map([['X', 'XCOIN']]));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => [r.type, r.usd, r.costBasisUsd, r.gainUsd]), [
    ['buy', 100, null, null],
    ['buy', 200, null, null],
    ['sell', 300, 150, 150],
    ['sell', 100, 150, -50],
  ]);
  assert.equal(rows[0].tokenAmount, 1); // 100 raw with 2 decimals
  assert.equal(rows[0].symbol, 'XCOIN');
  assert.equal(rows[0].sig, 'sigA');
  assert.equal(rows[3].sig, ''); // paper "signatures" aren't transactions
  assert.equal(rows[2].gainSol, 0.5);
  const s = taxSummary(rows.filter((r) => new Date(r.t).getFullYear() === 2026));
  assert.equal(s.sells, 2);
  assert.equal(s.gainUsd, 100);
  // A missing price leaves the USD cells empty instead of guessing.
  const none = taxRows(log, 'live', () => null, new Map(), new Map());
  assert.equal(none[2].gainUsd, null);
  assert.equal(taxSummary(none).missingPrices, 4);
  const csv = taxCsv(rows);
  assert.ok(csv.startsWith('﻿date_utc,type,token_symbol'));
  assert.ok(csv.includes(',sell,XCOIN,X,1,1.5,200,300,150,150,0.5,'));
});
