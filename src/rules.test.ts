import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, sanitizeConfig } from './config';
import { buyBlockReason, freshGuard, marketSkipReason, planExit, priceDriftPct, recordSell, walletExposureSol, walletRecords } from './rules';
import { summarizePairs } from './market';

const cfg = structuredClone(DEFAULT_CONFIG); // stop-loss 40, recover at +100, tp1 +300/50%, tp2 +900/50%, trail 30% after +50
const pos = (extra = {}) => ({ costSol: 1, steps: [] as any[], peakMultiple: 1, ...extra });

// ---------------- staged exits ----------------
test('no action while price is flat', () => {
  assert.equal(planExit(pos(), 1.1, cfg).action, null);
});

test('stop-loss sells everything at -40%', () => {
  const a = planExit(pos(), 0.6, cfg).action!;
  assert.equal(a.fraction, 1);
  assert.match(a.reason, /stop-loss/);
});

test('at 2x sells half to take the cost back', () => {
  const a = planExit(pos(), 2, cfg).action!;
  assert.equal(a.step, 'recover');
  assert.equal(a.fraction, 0.5);
});

test('at 2.5x the cost-back sale is 40% of the holding', () => {
  const a = planExit(pos(), 2.5, cfg).action!;
  assert.equal(a.step, 'recover');
  assert.ok(Math.abs(a.fraction - 0.4) < 1e-9);
});

test('steps run in order and never repeat', () => {
  assert.equal(planExit(pos({ steps: ['recover'] }), 4, cfg).action!.step, 'tp1');
  assert.equal(planExit(pos({ steps: ['recover', 'tp1'] }), 10, cfg).action!.step, 'tp2');
  assert.equal(planExit(pos({ steps: ['recover', 'tp1', 'tp2'], peakMultiple: 10 }), 10, cfg).action, null);
});

test('trailing stop is not armed below +50%', () => {
  // peaked at +40% then fell 30%: trailing not armed, no stop-loss yet (with the profit lock off)
  const noLock = { ...cfg, exits: { ...cfg.exits, lockAtPct: 0 } };
  assert.equal(planExit(pos({ peakMultiple: 1.4 }), 0.98, noLock).action, null);
});

test('Rule #1, profit lock: once up 20%, a winner is sold before it can turn into a loss', () => {
  // Up 40% at the peak, back to +4%: sold to keep it a winner.
  const r = planExit(pos({ peakMultiple: 1.4 }), 1.04, cfg);
  assert.equal(r.action!.fraction, 1);
  assert.match(r.action!.reason, /profit lock: was up \+40%, sold at \+4% to keep it a winner/);
  // Fell straight through the floor between two checks: still sold at once, before it gets worse.
  assert.match(planExit(pos({ peakMultiple: 1.4 }), 0.98, cfg).action!.reason, /profit lock: .*sold before it got worse/);
  // Never up 20%: no lock (the normal stop-loss applies); still above the floor: hold.
  assert.equal(planExit(pos({ peakMultiple: 1.15 }), 1.0, cfg).action, null);
  assert.equal(planExit(pos({ peakMultiple: 1.4 }), 1.2, cfg).action, null);
  // Older setups without the setting get the defaults (20 / 5); custom values are respected.
  const old = { ...cfg, exits: { ...cfg.exits, lockAtPct: undefined, lockFloorPct: undefined } };
  assert.equal(planExit(pos({ peakMultiple: 1.25 }), 1.04, old).action!.fraction, 1);
  const custom = { ...cfg, exits: { ...cfg.exits, lockAtPct: 50, lockFloorPct: 10 } };
  assert.equal(planExit(pos({ peakMultiple: 1.4 }), 1.04, custom).action, null);
  assert.match(planExit(pos({ peakMultiple: 1.6 }), 1.09, custom).action!.reason, /profit lock/);
});

test('trailing stop sells everything after falling 30% from the peak', () => {
  const r = planExit(pos({ steps: ['recover'], peakMultiple: 3 }), 2.0, cfg); // 33% off a 3x peak
  assert.equal(r.action!.fraction, 1);
  assert.match(r.action!.reason, /trailing stop/);
});

test('peak is remembered and only goes up', () => {
  assert.equal(planExit(pos({ peakMultiple: 1.3 }), 1.2, cfg).peakMultiple, 1.3);
  assert.equal(planExit(pos({ peakMultiple: 1.3 }), 1.45, cfg).peakMultiple, 1.45);
});

test('sell-everything target still works when set', () => {
  const c = structuredClone(cfg);
  c.risk.takeProfitPct = 150;
  const a = planExit(pos(), 2.6, c).action!;
  assert.equal(a.fraction, 1);
  assert.match(a.reason, /take-profit \+160%/);
});

test('steps set to 0 are off', () => {
  const c = structuredClone(cfg);
  c.exits.recoverCostAtPct = 0;
  assert.equal(planExit(pos(), 2.2, c).action, null);
});

// ---------------- don't chase ----------------
test('price drift: same price is 0%, 20% more expensive is +20%', () => {
  // they paid 1 SOL for 1,000,000 raw units
  assert.equal(Math.round(priceDriftPct(1, 1_000_000n, 100_000_000n, 100_000n)!), 0);
  assert.equal(Math.round(priceDriftPct(1, 1_000_000n, 120_000_000n, 100_000n)!), 20);
  assert.equal(priceDriftPct(1, 0n, 1n, 1n), null);
});

// ---------------- market filters ----------------
const f = cfg.filters; // min liquidity $10K, max 2% of pool
const now = Date.UTC(2026, 10, 8, 12);
test('market filters: low liquidity, big trade, market cap range, token age, missing data', () => {
  assert.match(marketSkipReason({ liquidityUsd: 5_000, marketCapUsd: 50_000, createdAt: null }, f, 10, now)!, /liquidity \$5\.0K is below \$10\.0K/);
  assert.match(marketSkipReason({ liquidityUsd: 20_000, marketCapUsd: 50_000, createdAt: null }, f, 1_000, now)!, /5\.0% of the pool/);
  assert.equal(marketSkipReason({ liquidityUsd: 20_000, marketCapUsd: 50_000, createdAt: null }, f, 100, now), null);
  const g = { ...f, minMarketCapUsd: 100_000, maxMarketCapUsd: 5_000_000, minTokenAgeMin: 30 };
  assert.match(marketSkipReason({ liquidityUsd: 1e6, marketCapUsd: 50_000, createdAt: null }, g, 10, now)!, /below \$100\.0K/);
  assert.match(marketSkipReason({ liquidityUsd: 1e6, marketCapUsd: 9e6, createdAt: null }, g, 10, now)!, /above \$5\.0M/);
  assert.match(marketSkipReason({ liquidityUsd: 1e6, marketCapUsd: 1e6, createdAt: now - 10 * 60_000 }, g, 10, now)!, /10 min old/);
  assert.equal(marketSkipReason(null, f, 10, now), null);
  assert.match(marketSkipReason(null, { ...f, skipIfNoMarketData: true }, 10, now)!, /no market data/);
});

test('summarizePairs adds up liquidity across pools and keeps the oldest pool time', () => {
  const m = 'MINT';
  const info = summarizePairs(m, [
    { chainId: 'solana', baseToken: { address: m, symbol: 'LEAF', name: 'Leaf' }, liquidity: { usd: 1000 }, marketCap: 50_000, pairCreatedAt: 2000, volume: { h24: 300 }, priceChange: { h1: 12 }, txns: { h1: { buys: 40, sells: 10 } } },
    { chainId: 'solana', baseToken: { address: m }, liquidity: { usd: 500 }, fdv: 60_000, pairCreatedAt: 1000, volume: { h24: 200 } },
    { chainId: 'ethereum', baseToken: { address: m }, liquidity: { usd: 99999 } },
  ])!;
  assert.deepEqual(info, { liquidityUsd: 1500, marketCapUsd: 60_000, createdAt: 1000, symbol: 'LEAF', name: 'Leaf', volume24hUsd: 500, change1hPct: 12, change5mPct: null, buys1h: 40, sells1h: 10, buys5m: null, sells5m: null });
  assert.equal(summarizePairs(m, []), null);
});

test('pump.fun bonding-curve tokens: unknown liquidity is not treated as $0', () => {
  const m = 'PUMP';
  const info = summarizePairs(m, [{ chainId: 'solana', baseToken: { address: m }, liquidity: undefined, marketCap: 20_000, pairCreatedAt: 5 }])!;
  assert.equal(info.liquidityUsd, null);
  assert.equal(marketSkipReason(info, f, 10, now), null); // liquidity checks skipped
  assert.match(marketSkipReason(info, { ...f, minMarketCapUsd: 50_000 }, 10, now)!, /market cap/); // other filters still apply
});

// ---------------- circuit breaker ----------------
test('daily loss limit blocks buys until tomorrow, unless resumed', () => {
  const t = Date.UTC(2026, 10, 8, 12);
  const risk = { ...cfg.risk, dailyLossLimitSol: 0.3 };
  let g = freshGuard(t);
  let r = recordSell(g, -0.2, risk, t);
  assert.equal(r.event, null);
  r = recordSell(r.guard, -0.15, risk, t);
  assert.match(r.event!, /Daily loss limit/);
  assert.match(buyBlockReason(r.guard, risk, t)!, /daily loss limit/);
  assert.equal(buyBlockReason({ ...r.guard, resumedDay: r.guard.day }, risk, t), null);
  assert.equal(buyBlockReason(r.guard, risk, t + 36 * 3600_000), null); // next day
});

test('4 losses in a row pause buys for 60 minutes; a win resets the streak', () => {
  const t = Date.UTC(2026, 10, 8, 12);
  const risk = { ...cfg.risk, dailyLossLimitSol: 0 };
  let g = freshGuard(t);
  for (const pnl of [-0.01, -0.01, 0.02, -0.01, -0.01, -0.01]) g = recordSell(g, pnl, risk, t).guard;
  assert.equal(g.lossStreak, 3);
  const r = recordSell(g, -0.01, risk, t);
  assert.match(r.event!, /4 losing trades in a row/);
  assert.ok(buyBlockReason(r.guard, risk, t + 30 * 60_000));
  assert.equal(buyBlockReason(r.guard, risk, t + 61 * 60_000), null);
});

// ---------------- per-wallet budgets ----------------
test('wallet exposure splits shared positions', () => {
  const ps = [{ costSol: 0.1, sources: ['A'] }, { costSol: 0.2, sources: ['A', 'B'] }, { costSol: 0.5, sources: ['C'] }];
  assert.ok(Math.abs(walletExposureSol(ps, 'A') - 0.2) < 1e-12);
  assert.equal(walletExposureSol(ps, 'C'), 0.5);
});

// ---------------- config ----------------
test('config: new wallet fields default and validate', () => {
  const c = sanitizeConfig({ wallets: [{ address: 'GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f' }] }, true);
  assert.equal(c.wallets[0].sizeMultiplier, 1);
  assert.equal(c.wallets[0].maxExposureSol, 0);
  assert.throws(() => sanitizeConfig({ wallets: [{ address: 'GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f', sizeMultiplier: 50 }] }, true), /Size multiplier/);
  assert.throws(() => sanitizeConfig({ exits: { tp1AtPct: 300, tp2AtPct: 200 } }, true), /higher than take-profit 1/);
});

test('walletRecords: our results per copied wallet, shared sells split', () => {
  const r = walletRecords(
    [
      { mode: 'paper', side: 'buy', source: 'A' },
      { mode: 'paper', side: 'buy', source: 'B' },
      { mode: 'paper', side: 'sell', sources: ['A'], pnl: 0.2 },
      { mode: 'paper', side: 'sell', sources: ['A', 'B'], pnl: -0.1 },
      { mode: 'live', side: 'sell', sources: ['A'], pnl: 5 },
    ],
    'paper',
  );
  assert.deepEqual(r.A, { trades: 1, closed: 2, wins: 1, pnlSol: 0.15000000000000002 });
  assert.deepEqual(r.B, { trades: 1, closed: 1, wins: 0, pnlSol: -0.05 });
});

test('copyGapPct: buys paying more and sells getting less are both positive (worse for us)', async () => {
  const { copyGapPct, median } = await import('./rules');
  // They paid 1 SOL for 1,000,000 raw; we paid 0.1 SOL for 90,000 raw → 11.1% more per token.
  assert.ok(Math.abs(copyGapPct('buy', 1, 1_000_000n, 0.1, 90_000n)! - 11.111) < 0.01);
  // They sold 1,000,000 raw for 2 SOL; we sold 100,000 raw for 0.19 SOL → 5% less.
  assert.ok(Math.abs(copyGapPct('sell', 2, 1_000_000n, 0.19, 100_000n)! - 5) < 1e-9);
  // We beat them (price dipped before we bought) → negative gap.
  assert.ok(copyGapPct('buy', 1, 1_000_000n, 0.1, 110_000n)! < 0);
  assert.equal(copyGapPct('buy', 1, 0n, 0.1, 5n), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('dangerReason: rug, crash and dump checks', async () => {
  const { dangerReason } = await import('./rules');
  const p = { liquidityDropPct: 50, crashPct: 35, crashWindowMin: 5, maxSellBuyRatio: 3 };
  const now = 10 * 60_000;
  const base = { now, valueSol: 1, samples: [[now - 60_000, 1], [now, 1]] as [number, number][], liquidityUsd: 50_000, peakLiquidityUsd: 60_000, buys5m: 30, sells5m: 40 };
  assert.equal(dangerReason(base, p), null);
  assert.match(dangerReason({ ...base, liquidityUsd: 20_000 }, p)!, /liquidity fell 67%/);
  assert.equal(dangerReason({ ...base, liquidityUsd: null }, p), null); // bonding curve: no pool figure
  assert.match(dangerReason({ ...base, valueSol: 0.6, samples: [[now - 120_000, 1], [now, 0.6]] }, p)!, /price fell 40% in under 5 min/);
  // A slow decline outside the window doesn't count.
  assert.equal(dangerReason({ ...base, valueSol: 0.6, samples: [[now - 10 * 60_000, 1], [now, 0.6]] }, p), null);
  // Heavy selling counts only while the price is really falling (5%+ in 5 minutes)...
  assert.equal(dangerReason({ ...base, buys5m: 5, sells5m: 25 }, p), null); // price flat: lots of tiny sells, not a dump
  assert.match(dangerReason({ ...base, buys5m: 5, sells5m: 25, valueSol: 0.9 }, p)!, /25 sells vs 5 buys in the last 5 min, price down 10%/); // our own price samples
  assert.match(dangerReason({ ...base, buys5m: 5, sells5m: 25, change5mPct: -8 }, p)!, /price down 8%/); // the market's 5-minute change
  assert.equal(dangerReason({ ...base, buys5m: 5, sells5m: 25, change5mPct: -3 }, p), null);
  assert.equal(dangerReason({ ...base, buys5m: 1, sells5m: 10 }, p), null); // too few sells to judge
  assert.equal(dangerReason({ ...base, liquidityUsd: 1, buys5m: 0, sells5m: 99 }, { liquidityDropPct: 0, crashPct: 0, crashWindowMin: 5, maxSellBuyRatio: 0 }), null);
});

test('per-wallet exits: overrides apply to positions opened by that wallet only, and are validated', async () => {
  const { DEFAULT_CONFIG, exitConfigFor, sanitizeConfig } = await import('./config');
  const W = 'So11111111111111111111111111111111111111112';
  const c = sanitizeConfig({ wallets: [{ address: W, label: 'scalper', exits: { stopLossPct: 15, tp1AtPct: 50, trailingStopPct: '' } }] }, true);
  assert.deepEqual(c.wallets[0].exits, { stopLossPct: 15, tp1AtPct: 50 });
  const own = exitConfigFor(c, [W]);
  assert.equal(own.risk.stopLossPct, 15);
  assert.equal(own.exits.tp1AtPct, 50);
  assert.equal(own.exits.tp2AtPct, DEFAULT_CONFIG.exits.tp2AtPct);
  assert.equal(exitConfigFor(c, ['other']).risk.stopLossPct, DEFAULT_CONFIG.risk.stopLossPct);
  assert.throws(() => sanitizeConfig({ wallets: [{ address: W, label: 'x', exits: { stopLossPct: 400 } }] }, true), /Stop-loss must be between/);
  assert.throws(() => sanitizeConfig({ wallets: [{ address: W, label: 'x', exits: { tp1AtPct: 500, tp2AtPct: 100 } }] }, true), /take-profit 2 must be higher/);
  // planExit with a wallet's tighter stop-loss sells where the global one would hold.
  const { planExit } = await import('./rules');
  assert.equal(planExit({ costSol: 1 }, 0.8, exitConfigFor(c, [W])).action?.fraction, 1);
  assert.equal(planExit({ costSol: 1 }, 0.8, c).action, null);
});

test('wallet trial: steps up after enough profitable copies; any wallet pauses after a losing streak', async () => {
  const { walletLifecycle, trialFactor } = await import('./rules');
  const t = { enabled: true, winsToStepUp: 3, pauseAfterLosses: 5 };
  assert.deepEqual([trialFactor(0), trialFactor(1), trialFactor(undefined)], [0.25, 0.5, 1]);
  assert.deepEqual(walletLifecycle({ trialStage: 0 }, [0.1, -0.05, 0.2], t), { stepUp: false, pause: null });
  assert.deepEqual(walletLifecycle({ trialStage: 0 }, [0.1, -0.05, 0.2, 0.01], t), { stepUp: true, pause: null });
  assert.deepEqual(walletLifecycle({}, [0.1, 0.2, 0.3], t), { stepUp: false, pause: null }); // already full size
  assert.equal(walletLifecycle({}, [0.5, -0.1, -0.1, -0.1, -0.1, -0.1], t).pause, '5 losing copies in a row');
  assert.equal(walletLifecycle({}, [-0.1, -0.1, -0.1, -0.1], t).pause, null);
  assert.equal(walletLifecycle({}, [-0.1, -0.1, -0.1, -0.1, -0.1], { ...t, pauseAfterLosses: 0 }).pause, null); // off
  assert.equal(walletLifecycle({ trialStage: 1 }, [1, 1, 1], { ...t, enabled: false }).stepUp, false);
});

test('config keeps trial fields; existing wallets get a start date on upgrade', async () => {
  const { sanitizeConfig } = await import('./config');
  const W = 'So11111111111111111111111111111111111111112';
  const c = sanitizeConfig({ wallets: [{ address: W, label: 'a', enabled: false, trialStage: 1, since: 5, pausedReason: '5 losing copies<script>' }] }, true);
  assert.equal(c.wallets[0].trialStage, 1);
  assert.equal(c.wallets[0].since, 5);
  assert.equal(c.wallets[0].pausedReason, '5 losing copiesscript');
  assert.equal(sanitizeConfig({ wallets: [{ address: W, label: 'a', trialStage: 7 }] }, true).wallets[0].trialStage, undefined);
});

test('healthVerdict', async () => {
  const { healthVerdict } = await import('./rules');
  assert.equal(healthVerdict({ copied: 0, closed: 0, totalSol: 0 }), 'quiet');
  assert.equal(healthVerdict({ copied: 3, closed: 2, totalSol: 1 }), 'unclear');
  assert.equal(healthVerdict({ copied: 5, closed: 4, totalSol: 0.1 }), 'keep');
  assert.equal(healthVerdict({ copied: 5, closed: 4, totalSol: -0.1 }), 'losing');
  // 642 of 1,500 transactions unreadable: no fair verdict, even with no copies seen.
  assert.equal(healthVerdict({ copied: 0, closed: 0, totalSol: 0, read: 1500, unreadable: 642 }), 'unclear');
  assert.equal(healthVerdict({ copied: 5, closed: 4, totalSol: 0.1, read: 100, unreadable: 10 }), 'keep');
});

test('paper wallet balance and picking experiment wallets', async () => {
  const { paperFreeSol, experimentPicks } = await import('./rules');
  assert.equal(paperFreeSol(10, 1.5, 2), 9.5);
  assert.equal(paperFreeSol(10, -9, 0.5), 0.5);
  const caught = new Map([
    ['one-token-big', { tokens: ['A'], bestGainPct: 900 }],
    ['two-tokens', { tokens: ['A', 'B'], bestGainPct: 60 }],
    ['mine', { tokens: ['A', 'B', 'C'], bestGainPct: 500 }],
    ['one-token-small', { tokens: ['C'], bestGainPct: 45 }],
  ]);
  assert.deepEqual(experimentPicks(caught, new Set(['mine']), 2).map((p) => p.wallet), ['two-tokens', 'one-token-small']); // 'one-token-big' only adds token A, already covered
});

test('experiment picks are spread over different tokens', async () => {
  const { experimentPicks } = await import('./rules');
  const caught = new Map([
    ['gpu1', { tokens: ['GPU'], bestGainPct: 900 }],
    ['gpu2', { tokens: ['GPU'], bestGainPct: 800 }],
    ['gpu3', { tokens: ['GPU'], bestGainPct: 700 }],
    ['cat', { tokens: ['CAT'], bestGainPct: 50 }],
    ['dog', { tokens: ['DOG'], bestGainPct: 45 }],
  ]);
  assert.deepEqual(experimentPicks(caught, new Set(), 3).map((p) => p.wallet), ['gpu1', 'cat', 'dog']);
  // Only one token moving: still fills the places.
  assert.equal(experimentPicks(new Map([['a', { tokens: ['X'], bestGainPct: 90 }], ['b', { tokens: ['X'], bestGainPct: 80 }]]), new Set(), 3).length, 2);
});

test('panicReason: closed + open result past the limit; 0 = off', async () => {
  const { panicReason } = await import('./rules');
  assert.equal(panicReason(-0.3, -0.25, 0.5), "today's total is -0.550 SOL (closed -0.300, open -0.250), past your 0.5 SOL panic limit");
  assert.equal(panicReason(-0.3, -0.1, 0.5), null);
  assert.equal(panicReason(0.2, -0.6, 0.5), null); // today's profit cushions it
  assert.equal(panicReason(-5, -5, 0), null);
});

test('perTokenValue: selling part of a position (or buying more) is not a price drop', async () => {
  const { perTokenValue, dangerReason } = await import('./rules');
  const before = perTokenValue(1.0, '1000000'); // 1 SOL for 1,000,000 units
  const afterHalfSold = perTokenValue(0.5, '500000'); // sold half: value halves, price the same
  assert.equal(before, afterHalfSold);
  const now = 1_000_000_000;
  const p = { ...DEFAULT_CONFIG.protect, liquidityDropPct: 0, maxSellBuyRatio: 0, crashPct: 35, crashWindowMin: 5 };
  assert.equal(dangerReason({ now, valueSol: afterHalfSold, samples: [[now - 60_000, before], [now, afterHalfSold]], liquidityUsd: null, peakLiquidityUsd: null, buys5m: null, sells5m: null }, p), null);
  assert.equal(perTokenValue(1, '0'), 0);
});

test('losing streak: near break-even losses (under 2% of cost) do not count', async () => {
  const { recordSell, freshGuard } = await import('./rules');
  const risk = { ...DEFAULT_CONFIG.risk, pauseAfterLosses: 3, dailyLossLimitSol: 0 };
  const t = 1_800_000_000_000;
  let g = freshGuard(t);
  for (let i = 0; i < 5; i++) g = recordSell(g, -0.0001, risk, t, 0.05).guard; // -0.2% each: not real losses
  assert.equal(g.lossStreak, 0);
  assert.ok(!g.pausedUntil);
  g = recordSell(g, -0.005, risk, t, 0.05).guard; // -10%: a real loss
  g = recordSell(g, -0.0001, risk, t, 0.05).guard; // break-even: neither adds nor resets
  assert.equal(g.lossStreak, 1);
  g = recordSell(g, -0.005, risk, t, 0.05).guard;
  const r = recordSell(g, -0.005, risk, t, 0.05);
  assert.match(r.event!, /3 losing trades in a row/);
  assert.equal(recordSell(freshGuard(t), -0.0001, risk, t).guard.lossStreak, 1); // cost unknown: counts as before
  const { isBreakEvenLoss } = await import('./rules');
  assert.equal(isBreakEvenLoss(-0.0001, 0.0499), true); // sold for 0.0499, cost 0.05
  assert.equal(isBreakEvenLoss(-0.005, 0.045), false);
  assert.equal(isBreakEvenLoss(0.001, 0.051), false);
});

test('smallVsUsual: skips a test buy far below what that wallet usually buys, only once it knows', async () => {
  const { smallVsUsual, median } = await import('./rules');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  const usual = [0.8, 1, 1.2, 0.9, 1.1];
  assert.match(smallVsUsual(0.1, usual, 25)!, /their buy \(0.10 SOL\) is much smaller than they usually buy \(1.00 SOL\)/);
  assert.equal(smallVsUsual(0.3, usual, 25), null); // 30% of usual: copied
  assert.equal(smallVsUsual(0.05, [0.05, 0.04, 0.06, 0.05, 0.05], 25), null); // a small trader's normal buy: copied
  assert.equal(smallVsUsual(0.01, usual.slice(0, 4), 25), null); // only 4 seen: doesn't know "usual" yet
  assert.equal(smallVsUsual(0.01, usual, 0), null); // off
});

test('needsFullQuote: a real quote when stale, when there is none, or when anything would sell soon', async () => {
  const { needsFullQuote, FULL_QUOTE_EVERY_MS } = await import('./rules');
  const p = pos({ peakMultiple: 1.1 }); // cost 1 SOL, peaked at +10%
  const now = 1_000_000;
  assert.equal(needsFullQuote(p, 1.02, cfg, now - 10_000, now), false); // calm, recent quote: the estimate is enough
  assert.equal(needsFullQuote(p, null, cfg, now - 10_000, now), true); // no price: quote
  assert.equal(needsFullQuote(p, 1.02, cfg, undefined, now), true); // never quoted
  assert.equal(needsFullQuote(p, 1.02, cfg, now - FULL_QUOTE_EVERY_MS, now), true); // stale
  assert.equal(needsFullQuote(p, 0.62, cfg, now - 10_000, now), true); // within 5% of the −40% stop-loss
  assert.equal(needsFullQuote(pos({ peakMultiple: 1.3 }), 1.08, cfg, now - 10_000, now), true); // near Rule #1's +5% floor
});

test("don't buy into a crash: falling hard, or being dumped, in the last 5 minutes", async () => {
  const { marketSkipReason } = await import('./rules');
  const f = { ...cfg.filters, minLiquidityUsd: 0, maxTradePctOfLiquidity: 0, maxDrop5mPct: 15 };
  const info = (x: object) => ({ liquidityUsd: 50_000, marketCapUsd: 500_000, createdAt: 0, change5mPct: 0, buys5m: 30, sells5m: 30, ...x }) as any;
  assert.equal(marketSkipReason(info({ change5mPct: -3 }), f, null, 1), null); // a normal wobble
  assert.match(marketSkipReason(info({ change5mPct: -22 }), f, null, 1)!, /crashing: down 22% in the last 5 minutes/);
  assert.match(marketSkipReason(info({ change5mPct: -7, sells5m: 60, buys5m: 10 }), f, null, 1)!, /being dumped: 60 sells vs 10 buys/);
  assert.equal(marketSkipReason(info({ change5mPct: 2, sells5m: 60, buys5m: 10 }), f, null, 1), null); // many sells, price holding: not a dump
  assert.equal(marketSkipReason(info({ change5mPct: -40 }), { ...f, maxDrop5mPct: 0 }, null, 1), null); // off
});

test('trailing stop fits each coin: wild coins get more room, calm ones a tighter stop', async () => {
  const { typicalSwingPct, trailWidthPct, planExit: plan } = await import('./rules');
  const now = 10_000_000;
  const series = (stepPct: number) => Array.from({ length: 120 }, (_, i) => [now - (119 - i) * 30_000, 1 + (Math.floor(i / 10) % 2 ? stepPct : 0) / 100] as [number, number]); // moves every 5 minutes
  assert.equal(typicalSwingPct(series(1).slice(-20), now), null); // 10 minutes: not enough yet
  const calm = typicalSwingPct(series(4), now)!, wild = typicalSwingPct(series(20), now)!;
  assert.ok(calm < wild);
  assert.equal(trailWidthPct(30, null), 30); // no history: your setting
  assert.equal(trailWidthPct(30, 2), 18); // calm: 60% of 30
  assert.equal(trailWidthPct(30, 16), 40); // 2.5 × 16
  assert.equal(trailWidthPct(30, 40), 48); // wild: capped at 160%
  // Peaked at 3x, now 33% off the peak: the plain 30% stop sells; a wild coin's 48% doesn't (yet).
  const p = pos({ steps: ['recover'], peakMultiple: 3 });
  assert.match(plan(p, 2.0, cfg).action!.reason, /trailing stop/);
  assert.equal(plan(p, 2.0, cfg, 40).action, null);
  assert.match(plan(p, 1.5, cfg, 40).action!.reason, /trailing stop: down 50% .*, 48% for this coin's swings/);
  // A calm coin is sold earlier (18% off the peak).
  assert.match(plan(p, 2.4, cfg, 2).action!.reason, /trailing stop: down 20%/);
  // Switched off: always your setting.
  assert.equal(plan(p, 2.4, { ...cfg, exits: { ...cfg.exits, adaptiveTrail: false } }, 2).action, null);
});
