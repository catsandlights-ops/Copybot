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
