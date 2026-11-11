import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, sanitizeConfig } from './config';
import { activeStrategy, applyStrategy, STRATEGIES, strategyById, strategyChanges } from './strategies';

test('every strategy is a valid configuration', () => {
  for (const s of STRATEGIES) assert.doesNotThrow(() => sanitizeConfig({ ...applyStrategy(DEFAULT_CONFIG, s), strategy: s.id }, true), s.id);
});

test('strategies never touch money settings, wallets or safety checks', () => {
  const mine = structuredClone(DEFAULT_CONFIG);
  mine.buy = { ...mine.buy, sizing: 'percent', fixedSol: 0.33, percentOfTarget: 7, minSol: 0.02, maxSol: 0.9 };
  mine.risk = { ...mine.risk, maxOpenPositions: 9, maxTotalExposureSol: 4, solReserve: 0.2, dailyLossLimitSol: 1.1, pauseAfterLosses: 6 };
  mine.safety = { ...mine.safety, slippageBps: 500, maxRoundTripLossPct: 8 };
  mine.wallets = [{ address: 'So11111111111111111111111111111111111111112', label: 'w', enabled: true, sizeMultiplier: 2, maxExposureSol: 0.5 }];
  for (const s of STRATEGIES) {
    const c = applyStrategy(mine, s);
    assert.equal(c.buy.fixedSol, 0.33);
    assert.equal(c.buy.sizing, 'percent');
    assert.equal(c.buy.maxSol, 0.9);
    assert.equal(c.risk.maxTotalExposureSol, 4);
    assert.equal(c.risk.maxOpenPositions, 9);
    assert.equal(c.risk.dailyLossLimitSol, 1.1);
    assert.equal(c.risk.solReserve, 0.2);
    assert.deepEqual(c.safety, mine.safety);
    assert.deepEqual(c.wallets, mine.wallets);
    assert.deepEqual(c.ai, mine.ai);
  }
});

test('Balanced is the default settings; switching shows changes and is detected', () => {
  assert.equal(activeStrategy(DEFAULT_CONFIG), 'balanced');
  const sniper = strategyById('sniper')!;
  const changes = strategyChanges(DEFAULT_CONFIG, sniper);
  assert.ok(changes.some(([k, from, to]) => k === 'risk.stopLossPct' && from === 40 && to === 25));
  const c = applyStrategy(DEFAULT_CONFIG, sniper);
  assert.equal(activeStrategy(c), 'sniper');
  // Every preset sets the same keys, so switching from one to another fully replaces it.
  const keys = (s: typeof sniper) => Object.entries(s.patch).flatMap(([sec, v]) => Object.keys(v!).map((k) => `${sec}.${k}`)).sort();
  for (const s of STRATEGIES) assert.deepEqual(keys(s), keys(STRATEGIES[0]), s.id);
  c.risk.stopLossPct = 30; // user tweak
  assert.equal(activeStrategy(c), null);
  assert.equal(strategyById('nope'), null);
});

test('compareStrategies: same trades replayed with each strategy, ranked', async () => {
  const { compareStrategies } = await import('./strategies');
  const A = 'WalletA', T0 = Date.UTC(2026, 10, 1, 12) / 1000;
  let n = 0;
  const sw = (o: any, min: number) => ({ signature: `s${n++}`, wallet: A, blockTime: T0 + min * 60, decimals: 6, tokenAmount: 1_000_000n, tokenPre: 0n, tokenPost: 0n, quote: 'SOL', quoteAmount: 1, ...o });
  // Each token pumps to 1.8x within 15 min, then they ride it down and sell at 0.5x an hour later.
  const rows = [[1, 1, 1], [1, 1, 1], [1, 1.4, 1.4], [1.4, 1.8, 1.7], [1.2, 1.7, 1.2], [0.9, 1.2, 0.9], [0.6, 0.9, 0.6], [0.5, 0.6, 0.5], ...Array(6).fill([0.5, 0.5, 0.5])];
  const series = { step: 300_000, candles: rows.map(([l, h, c], i) => ({ t: (T0 - 300) * 1000 + i * 300_000, l, h, c })) };
  const mints = Array.from({ length: 12 }, (_, i) => `M${i}`);
  const swaps = mints.flatMap((m) => [sw({ side: 'buy', mint: m }, 0), sw({ side: 'sell', mint: m, quoteAmount: 0.5, tokenPre: 1_000_000n }, 60)]);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.wallets = [{ address: A, label: 'a', enabled: true, sizeMultiplier: 1, maxExposureSol: 0 }];
  cfg.buy = { ...cfg.buy, fixedSol: 0.1 };
  cfg.risk = { ...cfg.risk, maxOpenPositions: 20, maxTotalExposureSol: 10, dailyLossLimitSol: 0, pauseAfterLosses: 0 };
  const c = compareStrategies(swaps as any, cfg, { delayPct: 0, feeSol: 0 }, new Map(), new Map(mints.map((m) => [m, series])));
  assert.equal(c.currentIs, 'balanced');
  assert.deepEqual(c.results.map((r) => r.id).sort(), ['conservative', 'current', 'momentum', 'sniper', 'whale']); // Balanced = current, not run twice
  assert.equal(c.results.find((r) => r.id === 'whale')!.copied, 0); // their 1 SOL buys are under Whale follower's 5 SOL minimum
  assert.ok(['sniper', 'momentum'].includes(c.best.id), c.best.id); // fast profits or crash protection beat riding a pump-and-dump
  assert.ok(c.best.totalSol > 0 && c.current.totalSol < c.best.totalSol);
  assert.equal(c.verdict, 'better');
});

test('a strategy that makes no trades is never the winner', async () => {
  const { compareStrategies } = await import('./strategies');
  const A = 'W', T0 = Date.UTC(2026, 10, 1, 12) / 1000;
  // One losing copied trade: Whale follower (5 SOL minimum) would skip it and "win" with 0.
  const swaps = [
    { signature: 'a', wallet: A, blockTime: T0, decimals: 6, tokenAmount: 1_000_000n, tokenPre: 0n, tokenPost: 0n, quote: 'SOL', quoteAmount: 1, side: 'buy', mint: 'M' },
    { signature: 'b', wallet: A, blockTime: T0 + 600, decimals: 6, tokenAmount: 1_000_000n, tokenPre: 1_000_000n, tokenPost: 0n, quote: 'SOL', quoteAmount: 0.8, side: 'sell', mint: 'M' },
  ];
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.wallets = [{ address: A, label: 'w', enabled: true, sizeMultiplier: 1, maxExposureSol: 0 }];
  const c = compareStrategies(swaps as any, cfg, { delayPct: 0, feeSol: 0 }, new Map(), new Map());
  assert.notEqual(c.best.id, 'whale');
  assert.equal(c.results[c.results.length - 1].id, 'whale');
});

test('when every strategy loses, the verdict says so instead of naming a winner', async () => {
  const { compareStrategies } = await import('./strategies');
  const A = 'W', T0 = Date.UTC(2026, 10, 1, 12) / 1000;
  const swaps = Array.from({ length: 12 }, (_, i) => [
    { signature: `b${i}`, wallet: A, blockTime: T0 + i * 3600, decimals: 6, tokenAmount: 1_000_000n, tokenPre: 0n, tokenPost: 0n, quote: 'SOL', quoteAmount: 6, side: 'buy', mint: `M${i}` },
    { signature: `s${i}`, wallet: A, blockTime: T0 + i * 3600 + 600, decimals: 6, tokenAmount: 1_000_000n, tokenPre: 1_000_000n, tokenPost: 0n, quote: 'SOL', quoteAmount: 4, side: 'sell', mint: `M${i}` },
  ]).flat();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.wallets = [{ address: A, label: 'w', enabled: true, sizeMultiplier: 1, maxExposureSol: 0 }];
  cfg.risk = { ...cfg.risk, dailyLossLimitSol: 0, pauseAfterLosses: 0 };
  const c = compareStrategies(swaps as any, cfg, { delayPct: 0, feeSol: 0 }, new Map(), new Map());
  assert.ok(c.results.every((r) => r.totalSol < 0));
  assert.equal(c.verdict, 'all-lose');
});

test('a wallet can have its own strategy; its exit overrides still win; others use the global rules', async () => {
  const { walletRules, exitConfigFor } = await import('./config');
  const W1 = 'So11111111111111111111111111111111111111112', W2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const c = sanitizeConfig({ wallets: [{ address: W1, label: 'fast', strategy: 'sniper', exits: { tp2AtPct: 120 } }, { address: W2, label: 'normal' }, { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', label: 'bad', strategy: 'nonsense' }] }, true);
  assert.equal(c.wallets[0].strategy, 'sniper');
  assert.equal(c.wallets[2].strategy, undefined); // unknown strategies are dropped
  const r1 = walletRules(c, W1);
  assert.equal(r1.risk.stopLossPct, 25); // from Sniper
  assert.equal(r1.risk.maxPriceDriftPct, 8);
  assert.equal(r1.exits.tp1AtPct, 40);
  assert.equal(r1.exits.tp2AtPct, 120); // the wallet's own override wins
  const r2 = walletRules(c, W2);
  assert.equal(r2.risk.stopLossPct, DEFAULT_CONFIG.risk.stopLossPct);
  assert.equal(r2.minTargetBuySol, DEFAULT_CONFIG.buy.minTargetBuySol);
  assert.equal(exitConfigFor(c, [W1]).risk.stopLossPct, 25);
  // Money settings are never per-wallet-strategy.
  assert.equal(r1.risk.maxTotalExposureSol, c.risk.maxTotalExposureSol);
});

test('pickWalletStrategy: finds the strategy that fits one wallet, and only switches on clear evidence', async () => {
  const { pickWalletStrategy } = await import('./strategies');
  const A = 'WalletA';
  const T0 = Date.UTC(2026, 10, 1, 12) / 1000;
  let n = 0;
  const sw = (o: any, min: number) => ({ signature: `s${n++}`, wallet: A, blockTime: T0 + min * 60, decimals: 6, tokenAmount: 1_000_000n, tokenPre: 0n, tokenPost: 0n, quote: 'SOL', quoteAmount: 1, ...o });
  const STEP = 300_000;
  const series = (rows: [number, number, number][]) => ({ step: STEP, candles: rows.map(([l, h, c], i) => ({ t: (T0 - 300) * 1000 + i * STEP, l, h, c })) });
  // Every coin pumps to 1.8x within 15 minutes, then they ride it down and sell at 0.5x.
  const pumpThenDump = series([[1, 1, 1], [1, 1, 1], [1, 1.4, 1.4], [1.4, 1.8, 1.7], [1.2, 1.7, 1.2], [0.9, 1.2, 0.9], [0.6, 0.9, 0.6], [0.5, 0.6, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.wallets = [{ address: A, label: 'a', enabled: true, sizeMultiplier: 1, maxExposureSol: 0 }];
  cfg.buy = { ...cfg.buy, fixedSol: 0.1, minTargetBuySol: 0 };
  cfg.exits.lockAtPct = 0; // compare the strategies' own exits
  cfg.protect.crashPct = 0;
  cfg.risk.maxOpenPositions = 20;
  cfg.risk.maxTotalExposureSol = 10;
  const mints = Array.from({ length: 12 }, (_, i) => `M${i}`);
  const swaps = mints.flatMap((m) => [sw({ side: 'buy', mint: m }, 0), sw({ side: 'sell', mint: m, quoteAmount: 0.5, tokenPre: 1_000_000n }, 60)]) as any[];
  const prices = new Map(mints.map((m) => [m, pumpThenDump]));
  const opts = { delayPct: 0, feeSol: 0 };
  const p = pickWalletStrategy(swaps, cfg, opts, new Map(), prices, A, 0)!;
  assert.equal(p.current.id, 'mine');
  assert.ok(p.best.totalSol > p.current.totalSol, 'a strategy that takes profit on the way up beats riding it down');
  assert.notEqual(p.best.id, 'mine');
  assert.equal(p.change, true);
  // Already on the best strategy: nothing to change.
  const onBest = structuredClone(cfg);
  onBest.wallets[0].strategy = p.best.id;
  assert.equal(pickWalletStrategy(swaps, onBest, opts, new Map(), prices, A, 0)!.change, false);
  // Only 2 coins: too few finished trades to switch on.
  const few = pickWalletStrategy(swaps.slice(0, 4), cfg, opts, new Map(), prices, A, 0)!;
  assert.equal(few.change, false);
  assert.equal(few.why, 'too few finished trades to tell');
  // A wallet with no trades in the data: nothing to judge.
  assert.equal(pickWalletStrategy(swaps, { ...cfg, wallets: [{ ...cfg.wallets[0], address: 'B' }] }, opts, new Map(), prices, 'B', 0), null);
});

test('pickWalletStrategy works the same for a Base wallet (0x address, Base coins, ETH converted to SOL)', async () => {
  const { pickWalletStrategy } = await import('./strategies');
  const A = '0x' + 'ab'.repeat(20);
  const T0 = Date.UTC(2026, 10, 1, 12) / 1000;
  let n = 0;
  const sw = (o: any, min: number) => ({ chain: 'base', signature: `0x${n++}`, wallet: A, blockTime: T0 + min * 60, decimals: 18, tokenAmount: 10n ** 18n, tokenPre: 0n, tokenPost: 0n, quote: 'SOL', quoteAmount: 1, nativeAmount: 0.05, ...o });
  const STEP = 300_000;
  const rows: [number, number, number][] = [[1, 1, 1], [1, 1, 1], [1, 1.4, 1.4], [1.4, 1.8, 1.7], [1.2, 1.7, 1.2], [0.9, 1.2, 0.9], [0.6, 0.9, 0.6], [0.5, 0.6, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]];
  const pumpThenDump = { step: STEP, candles: rows.map(([l, h, c], i) => ({ t: (T0 - 300) * 1000 + i * STEP, l, h, c })) };
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.wallets = [{ address: A, chain: 'base', label: 'b', enabled: true, sizeMultiplier: 1, maxExposureSol: 0 } as any];
  cfg.buy = { ...cfg.buy, fixedSol: 0.1, minTargetBuySol: 0 };
  cfg.exits.lockAtPct = 0;
  cfg.protect.crashPct = 0;
  cfg.risk.maxOpenPositions = 20;
  cfg.risk.maxTotalExposureSol = 10;
  const mints = Array.from({ length: 12 }, (_, i) => '0x' + String(i).padStart(40, 'c'));
  const swaps = mints.flatMap((m) => [sw({ side: 'buy', mint: m }, 0), sw({ side: 'sell', mint: m, quoteAmount: 0.5, tokenPre: 10n ** 18n }, 60)]) as any[];
  const p = pickWalletStrategy(swaps, cfg, { delayPct: 0, feeSol: 0 }, new Map(), new Map(mints.map((m) => [m, pumpThenDump])), A, 0)!;
  assert.ok(p, 'a Base wallet is judged like any other');
  assert.ok(p.best.totalSol > p.current.totalSol);
  assert.equal(p.change, true);
});
