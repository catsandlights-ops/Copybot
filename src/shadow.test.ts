import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyBook, restartShadow, SHADOW, shadowBuy, shadowSell, shadowStats, shadowVerdict } from './shadow';

const D = 86_400_000;

test('shadow book: their trades replayed at your size, with the copy gap and fees', () => {
  const b = emptyBook();
  assert.equal(shadowBuy(b, 'W', 'M', 0.25, 1e-6, 5, 0), true);
  assert.equal(shadowBuy(b, 'W', 'M', 0.25, 1e-6, 5, 1), false); // already holding
  // They sell half at 2x: our half sells at 2x less the 5% gap.
  const t = shadowSell(b, 'W', 'M', 0.5, 2e-6, 5, 10)!;
  const tokensHalf = 0.25 / (1e-6 * 1.05) / 2;
  assert.ok(Math.abs(t.proceeds - (tokensHalf * 2e-6 * 0.95 - SHADOW.feeSol)) < 1e-12);
  assert.ok(Math.abs(t.cost - (0.25 + SHADOW.feeSol) / 2) < 1e-12);
  shadowSell(b, 'W', 'M', 1, 2e-6, 5, 20);
  assert.equal(b.open.W.M, undefined);
  assert.equal(shadowSell(b, 'W', 'M', 1, 2e-6, 5, 30), null); // nothing left
  const s = shadowStats(b, 'W', 20);
  assert.equal(s.closed, 2);
  assert.ok(s.pnlSol > 0.2);
});

test('shadow verdict: promoted only on proof, dropped when it keeps losing', () => {
  const b = emptyBook();
  const trade = (i: number, mult: number) => {
    shadowBuy(b, 'W', `M${i}`, 0.25, 1e-6, 5, i * 1000);
    shadowSell(b, 'W', `M${i}`, 1, mult * 1e-6, 5, i * 1000 + 500);
  };
  for (let i = 0; i < 7; i++) trade(i, 1.6);
  assert.match(shadowVerdict(shadowStats(b, 'W', 7000)).why, /needs 1 more finished trade and a full day/);
  trade(7, 1.6);
  assert.equal(shadowVerdict(shadowStats(b, 'W', 7000)).verdict, 'testing'); // 8 trades but not a day yet
  assert.equal(shadowVerdict(shadowStats(b, 'W', D + 1000)).verdict, 'promote');
  // Another wallet that loses steadily is dropped after 15 trades.
  const c = emptyBook();
  for (let i = 0; i < 15; i++) {
    shadowBuy(c, 'L', `M${i}`, 0.25, 1e-6, 5, i);
    shadowSell(c, 'L', `M${i}`, 1, 0.8e-6, 5, i + 1);
  }
  assert.equal(shadowVerdict(shadowStats(c, 'L', 2 * D)).verdict, 'drop');
  // A restarted test only counts new trades.
  restartShadow(b, 'W', 10 * D);
  assert.equal(shadowStats(b, 'W', 10 * D).closed, 0);
});
