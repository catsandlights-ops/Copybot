import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveChecklist, overallVerdict, skipCategory, sourceReport, type PaperTrade } from './readiness';

const D = 86_400_000;
const now = 100 * D;

test('skipCategory: busy services, safety, filters, limits', () => {
  assert.equal(skipCategory('Jupiter is busy (HTTP 429); try again in a moment'), 'busy');
  assert.equal(skipCategory("couldn't check market data (market data unavailable (503))"), 'busy');
  assert.equal(skipCategory('no sell route (possible honeypot)'), 'safety');
  assert.equal(skipCategory('trading tax too high: 0% to buy, 30% to sell (GoPlus)'), 'safety');
  assert.equal(skipCategory('liquidity $8.1K is below $10.0K'), 'filters');
  assert.equal(skipCategory('market mood is bad (SOL -5% in the last hour)'), 'filters');
  assert.equal(skipCategory('max open positions reached'), 'limits');
  assert.equal(skipCategory('already holding'), 'limits');
});

/** n closed trades for a wallet over `days`, with the given profits. */
const history = (w: string, pnls: number[], days: number): PaperTrade[] =>
  pnls.flatMap((p, i) => {
    const t = now - days * D + (i * days * D) / pnls.length;
    return [{ t, mode: 'paper', side: 'buy' as const, source: w }, { t: t + 1000, mode: 'paper', side: 'sell' as const, pnl: p, sources: [w] }];
  });

test('sourceReport: not enough data, losing, barely winning, missed trades, ready', () => {
  const few = sourceReport('w', 'W', 'solana', history('w', [0.1, 0.1], 5), undefined, true, now);
  assert.equal(few.verdict, 'not-yet');
  const lose = sourceReport('w', 'W', 'solana', history('w', Array(12).fill(-0.01), 5), undefined, true, now);
  assert.equal(lose.verdict, 'no');
  const barely = sourceReport('w', 'W', 'solana', history('w', [...Array(6).fill(0.011), ...Array(6).fill(-0.01)], 5), undefined, true, now);
  assert.equal(barely.verdict, 'risky');
  assert.match(barely.why, /barely/);
  const good = history('w', [...Array(8).fill(0.03), ...Array(4).fill(-0.01)], 5);
  const missed = sourceReport('w', 'W', 'solana', good, { seen: 40, copied: 12, skips: { busy: 12 } }, true, now);
  assert.equal(missed.verdict, 'risky');
  assert.equal(missed.missedPct, 30);
  const ok = sourceReport('w', 'W', 'solana', good, { seen: 40, copied: 12, skips: { busy: 2, filters: 26 } }, true, now);
  assert.equal(ok.verdict, 'ready');
  assert.equal(ok.closed, 12);
  assert.equal(ok.pnlSol, 0.2);
  assert.equal(ok.profitFactor, 6);
  // Base: good results, but live trading isn't available there yet.
  assert.equal(sourceReport('w', 'W', 'base', good, undefined, false, now).verdict, 'risky');
});

test('sourceReport: worst dip is the biggest fall from a high', () => {
  const r = sourceReport('w', 'W', 'solana', history('w', [0.1, -0.05, -0.04, 0.2], 5), undefined, true, now);
  assert.equal(r.worstDipSol, 0.09);
});

test('checklist and overall verdict', () => {
  const good = { hasKey: true, privateRpc: true, dailyLossLimitSol: 0.3, stopLossPct: 40, maxTotalExposureSol: 1, connectionOk: true, autopilotBudgetOk: true };
  assert.ok(liveChecklist(good).every((c) => c.ok));
  const bad = liveChecklist({ ...good, privateRpc: false, dailyLossLimitSol: 0 });
  assert.equal(bad.filter((c) => !c.ok).length, 2);
  const ready = sourceReport('w', 'Whale', 'solana', history('w', [...Array(8).fill(0.03), ...Array(4).fill(-0.01)], 5), undefined, true, now);
  assert.equal(overallVerdict([ready], liveChecklist(good)).level, 'ready');
  assert.equal(overallVerdict([ready], bad).level, 'partly');
  assert.equal(overallVerdict([{ ...ready, verdict: 'not-yet' }], liveChecklist(good)).level, 'not-yet');
});
