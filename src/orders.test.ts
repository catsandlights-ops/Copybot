import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterAttempt, describeOrder, fmtPrice, makeOrder, orderDue, type Order } from './orders';

const MINT = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';
const t0 = 1_800_000_000_000;
const mk = (b: object) => {
  const o = makeOrder({ mint: MINT, symbol: 'ANSEM', ...b }, t0, 'o1');
  if (typeof o === 'string') throw new Error(o);
  return o;
};

test('makeOrder: validates each kind and gives readable errors', () => {
  assert.equal(makeOrder({ kind: 'buy', mint: 'nope' }, t0, 'x'), 'Enter a valid token address');
  assert.equal(makeOrder({ kind: 'buy', mint: MINT, cond: 'below', priceUsd: 0, sol: 1 }, t0, 'x'), 'Enter the price (USD) that should trigger the order');
  assert.equal(makeOrder({ kind: 'buy', mint: MINT, cond: 'below', priceUsd: 0.05, sol: 500 }, t0, 'x'), 'SOL per buy must be between 0.001 and 100');
  assert.equal(makeOrder({ kind: 'sell', mint: MINT, cond: 'above', priceUsd: 0.05, sellPct: 0 }, t0, 'x'), 'Sell between 1% and 100% of the holding');
  assert.equal(makeOrder({ kind: 'dca', mint: MINT, sol: 0.1, everyHours: 1, times: 2.5 }, t0, 'x'), 'Number of buys must be a whole number from 1 to 500');
  assert.equal(makeOrder({ kind: 'teleport', mint: MINT }, t0, 'x'), 'Pick an order type');
  const b = mk({ kind: 'buy', cond: 'below', priceUsd: 0.05, sol: 0.2, expiresInHours: 24, symbol: '<b>X' });
  assert.equal(b.symbol, 'bX');
  assert.equal(b.expiresAt, t0 + 24 * 3_600_000);
  const d = mk({ kind: 'dca', sol: 0.1, everyHours: 6, times: 4, maxPriceUsd: 0.06 });
  assert.equal(d.nextAt, t0); // first buy straight away
  assert.equal(d.maxPriceUsd, 0.06);
});

test('orderDue: limit buy and sell fire only when the price crosses; sells need a holding; expiry', () => {
  const buy = mk({ kind: 'buy', cond: 'below', priceUsd: 0.05, sol: 0.2, expiresInHours: 1 });
  assert.equal(orderDue(buy, 0.06, false, t0), null);
  assert.deepEqual(orderDue(buy, 0.05, false, t0), { buySol: 0.2 });
  assert.equal(orderDue(buy, null, false, t0), null);
  assert.deepEqual(orderDue(buy, 0.04, false, t0 + 3_600_000), { expire: true });
  const sell = mk({ kind: 'sell', cond: 'above', priceUsd: 0.1, sellPct: 50 });
  assert.equal(orderDue(sell, 0.09, true, t0), null);
  assert.deepEqual(orderDue(sell, 0.11, true, t0), { sellFraction: 0.5 });
  assert.deepEqual(orderDue(sell, 0.11, false, t0), { skip: "you don't hold this token" });
  assert.equal(orderDue({ ...sell, status: 'filled' }, 0.2, true, t0), null);
});

test('DCA: buys on schedule, skips rounds above the cap, finishes after N buys', () => {
  let d: Order = mk({ kind: 'dca', sol: 0.1, everyHours: 6, times: 2, maxPriceUsd: 0.06 });
  assert.deepEqual(orderDue(d, 0.05, false, t0), { buySol: 0.1 });
  d = afterAttempt(d, true, null, t0);
  assert.equal(d.done, 1);
  assert.equal(d.nextAt, t0 + 6 * 3_600_000);
  assert.equal(orderDue(d, 0.05, false, t0 + 3_600_000), null); // not due yet
  const later = t0 + 6 * 3_600_000;
  assert.match((orderDue(d, 0.07, false, later) as { skip: string }).skip, /above your cap/);
  d = afterAttempt(d, false, 'price above cap', later);
  assert.equal(d.done, 1); // a skipped round isn't a buy
  assert.equal(d.status, 'active');
  d = afterAttempt(d, true, null, later + 6 * 3_600_000);
  assert.equal(d.status, 'filled');
  assert.equal(d.note, 'bought 2 of 2');
});

test('afterAttempt: a limit order gives up after 3 refusals in a row', () => {
  let b = mk({ kind: 'buy', cond: 'below', priceUsd: 0.05, sol: 0.2 });
  b = afterAttempt(b, false, 'no sell route (possible honeypot)', t0);
  assert.equal(b.status, 'active');
  b = afterAttempt(afterAttempt(b, false, 'x', t0), false, 'x', t0);
  assert.equal(b.status, 'failed');
  assert.equal(afterAttempt(mk({ kind: 'buy', cond: 'below', priceUsd: 0.05, sol: 0.2 }), true, null, t0).status, 'filled');
});

test('describeOrder and fmtPrice', () => {
  assert.equal(describeOrder(mk({ kind: 'buy', cond: 'below', priceUsd: 0.0000123, sol: 0.2 })), 'Buy 0.2 SOL of ANSEM when the price is at or below $0.0000123');
  assert.equal(describeOrder(mk({ kind: 'sell', cond: 'above', priceUsd: 1.5, sellPct: 100 })), 'Sell 100% of ANSEM when the price is at or above $1.5');
  assert.equal(describeOrder(mk({ kind: 'dca', sol: 0.1, everyHours: 0.5, times: 10 })), 'Buy 0.1 SOL of ANSEM every 30 min, 10 times');
  assert.equal(fmtPrice(123.45), '123.45');
  assert.equal(fmtPrice(0.05318), '0.05318');
});
