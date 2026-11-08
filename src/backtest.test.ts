import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from './backtest';
import { DEFAULT_CONFIG } from './config';
import type { Swap } from './decode';

const A = 'WalletA', B = 'WalletB';
let n = 0;
const T0 = Date.UTC(2026, 10, 1, 12) / 1000;
const sw = (o: Partial<Swap> & Pick<Swap, 'side' | 'mint' | 'wallet'>, minutes: number): Swap => ({
  signature: `s${n++}`, blockTime: T0 + minutes * 60, decimals: 6, tokenAmount: 1_000_000n, tokenPre: 0n, tokenPost: 0n, quote: 'SOL', quoteAmount: 1, ...o,
});
const cfg = () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.wallets = [{ address: A, label: 'a', enabled: true, sizeMultiplier: 1, maxExposureSol: 0 }, { address: B, label: 'b', enabled: true, sizeMultiplier: 2, maxExposureSol: 0 }];
  c.buy = { ...c.buy, sizing: 'fixed', fixedSol: 0.1, minSol: 0.01, maxSol: 1, minTargetBuySol: 0.2 };
  return c;
};
const noCost = { delayPct: 0, feeSol: 0 };

test('copies a buy and their full sell at their prices (no delay cost)', () => {
  // They buy 1M raw for 1 SOL, sell all 1M raw for 3 SOL: a 3x.
  const r = runBacktest([sw({ side: 'buy', mint: 'M', wallet: A }, 0), sw({ side: 'sell', mint: 'M', wallet: A, quoteAmount: 3, tokenPre: 1_000_000n, tokenPost: 0n }, 30)], cfg(), noCost);
  assert.equal(r.closed, 1);
  assert.equal(r.wins, 1);
  assert.ok(Math.abs(r.realizedSol - 0.2) < 1e-9); // 0.1 SOL in, 0.3 out
  assert.ok(Math.abs(r.roiPct! - 200) < 1e-6);
  assert.equal(r.open.length, 0);
});

test('delay cost and fees make copying worse than the original trade', () => {
  const swaps = [sw({ side: 'buy', mint: 'M', wallet: A }, 0), sw({ side: 'sell', mint: 'M', wallet: A, quoteAmount: 1.05, tokenPre: 1_000_000n }, 30)];
  assert.ok(runBacktest(swaps, cfg(), noCost).realizedSol > 0); // they made 5%
  assert.ok(runBacktest(swaps, cfg(), { delayPct: 5, feeSol: 0.0002 }).realizedSol < 0); // we lose after a 5% delay cost
});

test('partial sells follow their fraction; size multiplier applies', () => {
  const r = runBacktest([
    sw({ side: 'buy', mint: 'M', wallet: B }, 0), // B has ×2 → 0.2 SOL
    sw({ side: 'sell', mint: 'M', wallet: B, quoteAmount: 1, tokenAmount: 500_000n, tokenPre: 1_000_000n, tokenPost: 500_000n }, 10), // half at 2x their price
  ], cfg(), noCost);
  assert.equal(r.trades.find((t) => t.side === 'buy')!.sol, 0.2);
  assert.ok(Math.abs(r.realizedSol - 0.1) < 1e-9); // half the position (0.1 cost) sold for 0.2
  assert.equal(r.open.length, 1);
  assert.ok(Math.abs(r.open[0].costSol - 0.1) < 1e-9);
});

test('limits: small buys, already holding, max positions, exposure', () => {
  const c = cfg();
  c.risk.maxOpenPositions = 2;
  c.risk.maxTotalExposureSol = 1;
  const r = runBacktest([
    sw({ side: 'buy', mint: 'TINY', wallet: A, quoteAmount: 0.1 }, 0),
    sw({ side: 'buy', mint: 'M1', wallet: A }, 1),
    sw({ side: 'buy', mint: 'M1', wallet: A }, 2),
    sw({ side: 'buy', mint: 'M2', wallet: A }, 3),
    sw({ side: 'buy', mint: 'M3', wallet: A }, 4),
  ], c, noCost);
  assert.deepEqual(r.skipped, { 'their buy too small': 1, 'already holding': 1, 'max open positions': 1 });
  c.risk.maxOpenPositions = 10;
  c.risk.maxTotalExposureSol = 0.15;
  assert.equal(runBacktest([sw({ side: 'buy', mint: 'X', wallet: A }, 0), sw({ side: 'buy', mint: 'Y', wallet: A }, 1)], c, noCost).skipped['max SOL in trades'], 1);
});

test('circuit breaker stops buys after the daily loss limit', () => {
  const c = cfg();
  c.risk.dailyLossLimitSol = 0.05;
  c.risk.pauseAfterLosses = 0;
  const r = runBacktest([
    sw({ side: 'buy', mint: 'M', wallet: A }, 0),
    sw({ side: 'sell', mint: 'M', wallet: A, quoteAmount: 0.2, tokenPre: 1_000_000n }, 5), // -0.08
    sw({ side: 'buy', mint: 'N', wallet: A }, 10),
  ], c, noCost);
  assert.equal(r.skipped['daily loss limit'], 1);
  assert.ok(Math.abs(r.maxDrawdownSol - 0.08) < 1e-9);
});

test('ignores their sells when copy-sells is off; open positions are marked to market', () => {
  const c = cfg();
  c.sell.copySells = false;
  const swaps = [sw({ side: 'buy', mint: 'M', wallet: A }, 0), sw({ side: 'sell', mint: 'M', wallet: A, quoteAmount: 3, tokenPre: 1_000_000n }, 30)];
  const unpriced = runBacktest(swaps, c, noCost);
  assert.equal(unpriced.closed, 0);
  assert.equal(unpriced.unrealizedSol, null);
  assert.ok(Math.abs(unpriced.totalSol + 0.1) < 1e-9); // unknown value counted as a loss
  const priced = runBacktest(swaps, c, noCost, new Map([['M', 2e-6]])); // now 2 SOL per 1M raw
  assert.ok(Math.abs(priced.unrealizedSol! - 0.1) < 1e-9);
});

test('ignores sells of tokens we never copied, and per-wallet results add up', () => {
  const r = runBacktest([
    sw({ side: 'sell', mint: 'OTHER', wallet: A, tokenPre: 5n }, 0),
    sw({ side: 'buy', mint: 'M', wallet: A }, 1),
    sw({ side: 'sell', mint: 'M', wallet: A, quoteAmount: 2, tokenPre: 1_000_000n }, 9),
    sw({ side: 'buy', mint: 'N', wallet: B }, 2),
    sw({ side: 'sell', mint: 'N', wallet: B, quoteAmount: 0.5, tokenPre: 1_000_000n }, 8),
  ], cfg(), noCost);
  assert.equal(r.closed, 2);
  const a = r.wallets.find((w) => w.wallet === A)!, b = r.wallets.find((w) => w.wallet === B)!;
  assert.ok(Math.abs(a.pnlSol - 0.1) < 1e-9 && Math.abs(b.pnlSol + 0.1) < 1e-9);
  assert.equal(r.worst!.wallet, B);
  assert.deepEqual(r.curve.map(([, v]) => +v.toFixed(3)), [-0.1, 0]);
});

// ---------------- exits replayed from price candles ----------------
const STEP = 300_000;
const series = (startMin: number, rows: [number, number, number][]) => ({
  step: STEP,
  candles: rows.map(([l, h, c], i) => ({ t: (T0 + startMin * 60) * 1000 + i * STEP, l, h, c })),
});

test('stop-loss fires from candles before the wallet sells', () => {
  const c = cfg();
  c.exits = { recoverCostAtPct: 0, tp1AtPct: 0, tp1SellPct: 50, tp2AtPct: 0, tp2SellPct: 50, trailingAfterPct: 0, trailingStopPct: 0 };
  c.risk.stopLossPct = 40;
  // Price USD 1.0 at the buy, then crashes to 0.5 (−50%), they sell an hour later at 3x.
  const prices = new Map([['M', series(-5, [[1, 1, 1], [1, 1, 1], [0.9, 1, 0.95], [0.5, 0.95, 0.5], [0.5, 0.6, 0.55]])]]);
  const swaps = [sw({ side: 'buy', mint: 'M', wallet: A }, 0), sw({ side: 'sell', mint: 'M', wallet: A, quoteAmount: 3, tokenPre: 1_000_000n }, 60)];
  const r = runBacktest(swaps, c, noCost, new Map(), prices);
  assert.equal(r.closed, 1);
  const s = r.trades.find((t) => t.side === 'sell')!;
  assert.match(s.reason!, /stop-loss/);
  assert.ok(Math.abs(s.pnl! + 0.05) < 1e-9); // sold at 0.5x: 0.05 back for 0.1
  assert.deepEqual(r.exitsReplayed, { tokens: 1, withPrices: 1, exitSells: 1 });
  // Without candles, the same history follows their 3x sell.
  assert.ok(runBacktest(swaps, c, noCost).realizedSol > 0.19);
});

test('staged take-profits from candle highs, then their sell closes the rest', () => {
  const c = cfg();
  c.exits = { recoverCostAtPct: 100, tp1AtPct: 300, tp1SellPct: 50, tp2AtPct: 0, tp2SellPct: 50, trailingAfterPct: 0, trailingStopPct: 0 };
  c.risk.stopLossPct = 90;
  const prices = new Map([['M', series(-5, [[1, 1, 1], [1, 1, 1], [1, 2.2, 2], [2, 4.5, 4], [3.5, 4, 3.8]])]]);
  const swaps = [sw({ side: 'buy', mint: 'M', wallet: A }, 0), sw({ side: 'sell', mint: 'M', wallet: A, quoteAmount: 4, tokenPre: 1_000_000n }, 30)];
  const r = runBacktest(swaps, c, noCost, new Map(), prices);
  const reasons = r.trades.filter((t) => t.side === 'sell').map((t) => t.reason).reverse();
  assert.equal(reasons.length, 3);
  assert.match(reasons[0]!, /cost/);
  assert.match(reasons[1]!, /take-profit 1/);
  assert.equal(reasons[2], 'they sold everything');
  assert.ok(r.realizedSol > 0.2);
});

test('usdAt finds the covering candle and ignores stale data', async () => {
  const { usdAt } = await import('./backtest');
  const s = { step: 60_000, candles: [{ t: 0, l: 1, h: 1, c: 1 }, { t: 60_000, l: 2, h: 2, c: 2 }] };
  assert.equal(usdAt(s, 90_000), 2);
  assert.equal(usdAt(s, 30_000), 1);
  assert.equal(usdAt(s, -1), null);
  assert.equal(usdAt(s, 60_000 + 3 * 60_000), null);
});
