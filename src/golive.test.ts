import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from './config';
import { applyRoles, currentLimits, rampAdvice, roundTrip, starterLimits, suggestRoles, withLimits, type GoLiveRecord } from './golive';

test('starterLimits: small trades sized to the wallet, never above your own settings', () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.buy.fixedSol = 0.25;
  c.risk.maxOpenPositions = 8;
  c.risk.maxTotalExposureSol = 10;
  c.risk.dailyLossLimitSol = 2;
  c.risk.stopLossPct = 50;
  const { limits, notes } = starterLimits(2, c);
  assert.equal(limits.fixedSol, 0.1); // 5% of 2 SOL
  assert.equal(limits.maxOpenPositions, 3);
  assert.ok(limits.maxTotalExposureSol <= 1 && limits.maxTotalExposureSol >= limits.fixedSol);
  assert.equal(limits.dailyLossLimitSol, 0.2);
  assert.equal(limits.stopLossPct, 40);
  assert.ok(!notes.some((n) => /Add at least/.test(n)));
  // A big wallet: still no bigger than what you already trade.
  assert.equal(starterLimits(100, c).limits.fixedSol, 0.25);
  // A tiny wallet: a floor of 0.02 per trade, and a warning.
  const tiny = starterLimits(0.05, c);
  assert.equal(tiny.limits.fixedSol, 0.02);
  assert.ok(tiny.notes.some((n) => /Add at least 0.1 SOL/.test(n)));
  // Limits that were off (0) get a value.
  const off = structuredClone(c);
  off.risk.dailyLossLimitSol = 0;
  off.risk.stopLossPct = 0;
  off.risk.maxTotalExposureSol = 0;
  const o = starterLimits(2, off).limits;
  assert.ok(o.dailyLossLimitSol > 0 && o.stopLossPct === 40 && o.maxTotalExposureSol > 0);
  // Round trip through withLimits/currentLimits.
  assert.deepEqual(currentLimits(withLimits(c, limits)), limits);
});

test('suggestRoles / applyRoles: proven wallets go live, the rest go to shadow', () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.wallets = [
    { address: 'A', label: 'a', enabled: true, sizeMultiplier: 1, maxExposureSol: 0 },
    { address: 'B', label: 'b', enabled: true, sizeMultiplier: 1, maxExposureSol: 0 },
    { address: 'C', label: 'c', enabled: false, sizeMultiplier: 1, maxExposureSol: 0 },
    { address: 'D', label: 'd', enabled: false, shadow: true, sizeMultiplier: 1, maxExposureSol: 0 } as any,
  ];
  const roles = suggestRoles(c.wallets, [{ source: 'A', verdict: 'ready' }, { source: 'B', verdict: 'risky' }, { source: 'D', verdict: 'ready' }]);
  assert.deepEqual(roles, { A: 'live', B: 'shadow', C: 'off', D: 'live' });
  const n = applyRoles(c, roles, 123);
  const by = (a: string) => n.wallets.find((w) => w.address === a) as any;
  assert.equal(by('A').enabled, true);
  assert.equal(by('B').enabled, false);
  assert.equal(by('B').shadow, true);
  assert.equal(by('C').enabled, false);
  assert.equal(by('D').enabled, true);
  assert.equal(by('D').shadow, undefined);
  assert.equal(by('D').since, 123);
  assert.equal((c.wallets[1] as any).shadow, undefined, 'the original config is untouched');
});

test('rampAdvice: normal limits come back after a profitable starter week', () => {
  const day = 86_400_000;
  const rec: GoLiveRecord = { at: 0, before: { fixedSol: 0.25, maxOpenPositions: 5, maxTotalExposureSol: 5, dailyLossLimitSol: 1, stopLossPct: 50 }, starter: { fixedSol: 0.05, maxOpenPositions: 3, maxTotalExposureSol: 0.5, dailyLossLimitSol: 0.2, stopLossPct: 40 } };
  const sells = (n: number, pnl: number) => Array.from({ length: n }, (_, i) => ({ t: i * 1000, pnl }));
  assert.equal(rampAdvice(rec, sells(12, 0.01), 3 * day)!.due, false);
  assert.match(rampAdvice(rec, sells(12, 0.01), 3 * day)!.text, /4 more days/);
  assert.equal(rampAdvice(rec, sells(12, 0.01), 8 * day)!.due, true);
  assert.equal(rampAdvice(rec, sells(12, -0.01), 8 * day)!.due, false);
  assert.match(rampAdvice(rec, sells(12, -0.01), 8 * day)!.text, /a profit/);
  assert.equal(rampAdvice(rec, sells(4, 0.01), 8 * day)!.due, false);
  assert.equal(rampAdvice({ ...rec, restoredAt: 1 }, sells(12, 0.01), 8 * day), null);
  assert.equal(rampAdvice({ ...rec, starter: null }, [], 0), null);
});

test('roundTrip: buys the stablecoin, sells it all back, reports the cost; stops cleanly on failures', async () => {
  const USDC = 'USD';
  const mk = (o: { failSell?: boolean; balance?: number } = {}) => {
    let native = o.balance ?? 1;
    let usd = 5_000_000n; // already held some
    const sent: string[] = [];
    const chain: any = {
      meta: { id: 'solana', native: { symbol: 'SOL', decimals: 9, wrapped: 'W' }, stable: { symbol: 'USDC', address: USDC } },
      balance: async () => native,
      tokenBalance: async () => usd,
      quoteBuy: async (_t: string, raw: bigint) => ({ inputMint: 'W', outputMint: USDC, inAmount: raw.toString(), outAmount: String(Number(raw) * 0.15) }),
      quoteSell: async (_t: string, raw: bigint) => ({ inputMint: USDC, outputMint: 'W', inAmount: raw.toString(), outAmount: String(Math.floor(Number(raw) / 0.15)) }),
      executeSwap: async (_ctx: unknown, q: any, x: any) => {
        assert.equal(x.test, true);
        if (q.outputMint === USDC) {
          native -= Number(q.inAmount) / 1e9 + 0.000_01;
          usd += BigInt(q.outAmount);
          sent.push('buy');
          return 'sigBuy';
        }
        if (o.failSell) throw new Error('blockhash expired');
        assert.equal(q.inAmount, String(1_500_000), 'sells exactly what the buy gave, not what was already held');
        usd -= BigInt(q.inAmount);
        native += Number(q.outAmount) / 1e9 - 0.000_01;
        sent.push('sell');
        return 'sigSell';
      },
      nativeToSol: async (x: number) => x,
    };
    return { chain, sent };
  };
  const ctx: any = { cfg: { safety: { slippageBps: 300 } } };
  const ok = mk();
  const r = await roundTrip(ok.chain, ctx, 'me', 0.01, async () => {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(ok.sent, ['buy', 'sell']);
  if (r.ok) {
    assert.ok(r.costNative > 0 && r.costNative < 0.001, String(r.costNative));
    assert.equal(r.note, '', 'no new-account note when USDC was already held');
  }
  const bad = await roundTrip(mk({ failSell: true }).chain, ctx, 'me', 0.01, async () => {});
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.step, 'sell');
    assert.equal(bad.buySig, 'sigBuy');
    assert.match(bad.error, /stays in the wallet/);
  }
  const poor = await roundTrip(mk({ balance: 0.02 }).chain, ctx, 'me', 0.01, async () => {});
  assert.equal(poor.ok, false);
  if (!poor.ok) assert.equal(poor.step, 'balance');
});
