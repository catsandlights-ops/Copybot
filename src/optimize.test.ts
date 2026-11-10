import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from './config';
import { exitSetups, optimizeExits } from './optimize';
import type { Swap } from './decode';

const A = 'WalletA';
const T0 = Date.UTC(2026, 10, 1, 12) / 1000;
let n = 0;
const sw = (o: Partial<Swap> & Pick<Swap, 'side' | 'mint'>, min: number): Swap => ({ signature: `s${n++}`, wallet: A, blockTime: T0 + min * 60, decimals: 6, tokenAmount: 1_000_000n, tokenPre: 0n, tokenPost: 0n, quote: 'SOL', quoteAmount: 1, ...o });
const STEP = 300_000;
// Every token pumps to 1.8x within 15 min, then they ride it all the way down and sell at 0.5x.
const series = (rows: [number, number, number][]) => ({ step: STEP, candles: rows.map(([l, h, c], i) => ({ t: (T0 - 300) * 1000 + i * STEP, l, h, c })) });
const pumpThenDump = series([[1, 1, 1], [1, 1, 1], [1, 1.4, 1.4], [1.4, 1.8, 1.7], [1.2, 1.7, 1.2], [0.9, 1.2, 0.9], [0.6, 0.9, 0.6], [0.5, 0.6, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]);

test('16 setups: your current settings plus 5 styles × 3 stop-losses', () => {
  const s = exitSetups(DEFAULT_CONFIG);
  assert.equal(s.length, 16);
  assert.equal(s[0].id, 'current');
  assert.equal(new Set(s.map((x) => x.id)).size, 16);
});

test('taking profit early wins when tokens pump then dump before they sell', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.wallets = [{ address: A, label: 'a', enabled: true, sizeMultiplier: 1, maxExposureSol: 0, exits: { stopLossPct: 5 } }];
  cfg.buy = { ...cfg.buy, fixedSol: 0.1, minTargetBuySol: 0 };
  cfg.protect.crashPct = 0; // compare exits only
  cfg.exits.lockAtPct = 0; // compare the exit styles themselves (the profit lock is tested below)
  cfg.risk.maxOpenPositions = 20;
  cfg.risk.maxTotalExposureSol = 10;
  const mints = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12'];
  const swaps = mints.flatMap((m) => [sw({ side: 'buy', mint: m }, 0), sw({ side: 'sell', mint: m, quoteAmount: 0.5, tokenPre: 1_000_000n }, 60)]);
  const prices = new Map(mints.map((m) => [m, pumpThenDump]));
  const o = optimizeExits(swaps, cfg, { delayPct: 0, feeSol: 0 }, new Map(), prices);
  assert.match(o.best.setup.id, /^(early|quick)-/);
  assert.ok(o.best.totalSol > 0);
  assert.ok(o.current.totalSol < o.best.totalSol);
  const follow = o.results.find((r) => r.setup.id === 'follow-60')!;
  assert.ok(Math.abs(follow.totalSol + 0.6) < 1e-6); // 12 × (0.05 − 0.1): they sold at 0.5x
  assert.equal(o.verdict, 'better');
  // Per-wallet overrides are ignored while comparing (a −5% wallet stop-loss would hide the differences).
  assert.ok(o.results.every((r) => r.closed > 0));
});

test('Rule #1: with the profit lock on, pump-then-dump coins end in profit even when only following their sells', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.wallets = [{ address: A, label: 'a', enabled: true, sizeMultiplier: 1, maxExposureSol: 0 }];
  cfg.buy = { ...cfg.buy, fixedSol: 0.1, minTargetBuySol: 0 };
  cfg.protect.crashPct = 0;
  cfg.risk.maxOpenPositions = 20;
  cfg.risk.maxTotalExposureSol = 10;
  const mints = ['M1', 'M2', 'M3'];
  const swaps = mints.flatMap((m) => [sw({ side: 'buy', mint: m }, 0), sw({ side: 'sell', mint: m, quoteAmount: 0.5, tokenPre: 1_000_000n }, 60)]);
  const o = optimizeExits(swaps, cfg, { delayPct: 0, feeSol: 0 }, new Map(), new Map(mints.map((m) => [m, pumpThenDump])));
  const follow = o.results.find((r) => r.setup.id === 'follow-60')!;
  assert.ok(follow.totalSol > 0, `following their sells with the lock made ${follow.totalSol}`);
});
