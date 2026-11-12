import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paperVsLive, tradeGapSol } from './paperlive';

const B = '0x' + '22'.repeat(20);
const tr = (o: object) => ({ t: 10, mode: 'live', side: 'buy', mint: 'Sol1', sol: 1, tokenRaw: '1000', paperSol: 1, paperRaw: '1000', ...o });

test('tradeGapSol: same tokens at paper price vs what live really paid / got', () => {
  // Paid 1.02 SOL for 1000 tokens that paper priced at 1.00: 0.02 worse.
  assert.ok(Math.abs(tradeGapSol(tr({ sol: 1.02 }) as any)! - 0.02) < 1e-12);
  // Got only 980 tokens for 1 SOL: paper's price for 980 is 0.98, so live paid 0.02 more.
  assert.ok(Math.abs(tradeGapSol(tr({ tokenRaw: '980' }) as any)! - 0.02) < 1e-12);
  // A sell that brought 0.97 instead of paper's 1.00: 0.03 worse.
  assert.ok(Math.abs(tradeGapSol(tr({ side: 'sell', sol: 0.97 }) as any)! - 0.03) < 1e-12);
  // Live did better than paper: a negative gap.
  assert.ok(tradeGapSol(tr({ side: 'sell', sol: 1.01 }) as any)! < 0);
  assert.equal(tradeGapSol(tr({ paperSol: undefined }) as any), null, 'paper trades and old records have no twin');
});

test('paperVsLive: per chain, failures counted, a plain verdict', () => {
  const trades = [
    ...Array.from({ length: 10 }, () => tr({ sol: 1.01 })), // Solana buys 1% worse
    ...Array.from({ length: 10 }, () => tr({ side: 'sell', sol: 0.99 })), // Solana sells 1% worse
    tr({ mint: B, chain: 'base', sol: 1.05 }), // a Base buy 5% worse
    tr({ mode: 'paper', sol: 9 }), // paper trades are ignored
  ];
  const r = paperVsLive(trades as any, [{ t: 10, chain: 'base', side: 'buy' }]);
  const sol = r.chains.find((c) => c.chain === 'solana')!;
  const base = r.chains.find((c) => c.chain === 'base')!;
  assert.equal(sol.trades, 20);
  assert.ok(Math.abs(sol.buyWorsePct! - 1) < 1e-9);
  assert.ok(Math.abs(sol.sellWorsePct! - 1) < 1e-9);
  assert.ok(Math.abs(sol.gapSol - 0.2) < 1e-9);
  assert.equal(base.trades, 1);
  assert.equal(base.failed, 1);
  assert.equal(r.total!.trades, 21);
  assert.match(r.text, /match paper closely|a little worse/);
  assert.match(paperVsLive([], []).text, /No live trades yet/);
  assert.match(paperVsLive([tr({})] as any, []).text, /Only 1 live trade/);
  const bad = Array.from({ length: 12 }, () => tr({ sol: 1.1 }));
  assert.match(paperVsLive(bad as any, []).text, /clearly worse/);
  assert.equal(paperVsLive(trades as any, [], 11).total, null, 'since: only trades after it');
});
