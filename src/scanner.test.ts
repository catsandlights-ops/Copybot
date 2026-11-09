import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinSignals, overHeld } from './scanner';
import { pickTokens } from './scout';
import { DEFAULT_CONFIG, exitConfigFor, sanitizeConfig, SCANNER_SOURCE, walletRules } from './config';
import { planExit } from './rules';
import type { PoolRow } from './markets';

const now = Date.UTC(2026, 10, 9, 12);
const H = 3_600_000;
const D = 24 * H;
// A healthy new coin that is rising on real buying.
const row = (o: Partial<PoolRow> & { mint: string }): PoolRow => ({
  pool: 'P' + o.mint, symbol: o.mint, name: o.mint, image: null, priceUsd: 1,
  change: { m5: 1, h1: 20, h6: 40, h24: 80 }, volume24h: 480_000, volume1h: 60_000, liquidityUsd: 80_000, marketCapUsd: 1e6,
  createdAt: now - 2 * D, buys24h: 5000, sells24h: 4000, buys1h: 300, sells1h: 150, ...o,
});
const all = { newCoins: true, oldCoins: true };

test('coinSignals: rising on real buying passes; already-run, falling, sold-into, thin or quiet coins do not', () => {
  const s = coinSignals([
    row({ mint: 'GOOD' }),
    row({ mint: 'RAN', change: { m5: 1, h1: 90, h24: 200 } }), // already ran this hour
    row({ mint: 'TIRED', change: { m5: 1, h1: 20, h24: 900 } }), // up 900% today: exhausted
    row({ mint: 'DUMPING', change: { m5: -8, h1: 20, h24: 80 } }), // falling right now
    row({ mint: 'SELLERS', buys1h: 100, sells1h: 200 }),
    row({ mint: 'THIN', liquidityUsd: 8_000 }),
    row({ mint: 'QUIET', volume1h: 10_000 }), // less volume than usual
    row({ mint: 'FLAT', change: { m5: 0, h1: 2, h24: 5 } }),
    row({ mint: 'BABY', createdAt: now - 0.5 * H }), // under an hour old
    row({ mint: 'So11111111111111111111111111111111111111112' }),
  ], now, all);
  assert.deepEqual(s.map((x) => x.mint), ['GOOD']);
  assert.equal(s[0].kind, 'new');
  assert.match(s[0].why, /up 20% in the last hour, 2\.0× more buys than sells, 3\.0× its usual volume/);
});

test('coinSignals: older coins need deeper liquidity and can be switched off; skip list; best first', () => {
  const old = row({ mint: 'OLD', createdAt: now - 60 * D, liquidityUsd: 400_000, volume24h: 2_400_000, volume1h: 250_000, change: { m5: 0.5, h1: 8, h24: 20 } });
  const shallowOld = row({ mint: 'SHALLOW', createdAt: now - 60 * D, liquidityUsd: 60_000, volume24h: 2_400_000, volume1h: 250_000, change: { m5: 0.5, h1: 8, h24: 20 } });
  const strong = row({ mint: 'STRONG', change: { m5: 2, h1: 40, h24: 100 }, buys1h: 600, sells1h: 200, volume1h: 80_000 });
  const rows = [row({ mint: 'GOOD' }), old, shallowOld, strong];
  assert.deepEqual(coinSignals(rows, now, all).map((x) => x.mint), ['STRONG', 'GOOD', 'OLD']);
  assert.deepEqual(coinSignals(rows, now, { newCoins: false, oldCoins: true }).map((x) => x.mint), ['OLD']);
  assert.deepEqual(coinSignals(rows, now, { newCoins: true, oldCoins: false }).map((x) => x.mint), ['STRONG', 'GOOD']);
  assert.deepEqual(coinSignals(rows, now, { ...all, skip: new Set(['STRONG', 'OLD']) }).map((x) => x.mint), ['GOOD']);
  // The user's own liquidity filter applies when it's stricter.
  assert.deepEqual(coinSignals(rows, now, { ...all, minLiquidityUsd: 200_000 }).map((x) => x.mint), ['OLD']);
});

test('coinSignals: one entry per coin, from its deepest pool', () => {
  const s = coinSignals([row({ mint: 'X' }), row({ mint: 'X', pool: 'PX-main', liquidityUsd: 300_000 })], now, all);
  assert.equal(s.length, 1);
  assert.equal(s[0].pool, 'PX-main');
});

test('overHeld: only past the limit, and never when the limit is 0', () => {
  assert.equal(overHeld(now - 13 * H, now, 12), true);
  assert.equal(overHeld(now - 11 * H, now, 12), false);
  assert.equal(overHeld(now - 100 * H, now, 0), false);
});

test('scanner positions use the scanner exits: stop-loss, take-profit, trailing stop', () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.scanner = { ...c.scanner, stopLossPct: 20, takeProfitPct: 50, trailingAfterPct: 15, trailingStopPct: 12 };
  const ex = exitConfigFor(c, [SCANNER_SOURCE]);
  assert.equal(ex.risk.stopLossPct, 20);
  assert.equal(planExit({ costSol: 1 }, 0.79, ex).action?.reason, 'stop-loss -21%');
  assert.equal(planExit({ costSol: 1 }, 1.5, ex).action?.fraction, 1); // take-profit +50%
  assert.equal(planExit({ costSol: 1 }, 1.2, ex).action, null);
  assert.match(planExit({ costSol: 1, peakMultiple: 1.3 }, 1.13, ex).action!.reason, /trailing stop/);
  assert.equal(walletRules(c, SCANNER_SOURCE).minTargetBuySol, 0);
  // Copied wallets keep the normal settings.
  assert.equal(exitConfigFor(c, ['someone']).risk.stopLossPct, DEFAULT_CONFIG.risk.stopLossPct);
});

test('scanner settings: off by default, validated', () => {
  assert.equal(DEFAULT_CONFIG.scanner.tradeCoins, false);
  assert.equal(DEFAULT_CONFIG.scanner.findTraders, false);
  const ok = sanitizeConfig({ scanner: { tradeCoins: true, buySol: 0.02, maxPositions: 2 } }, true);
  assert.equal(ok.scanner.tradeCoins, true);
  assert.equal(ok.scanner.buySol, 0.02);
  assert.equal(ok.scanner.oldCoins, true);
  assert.throws(() => sanitizeConfig({ scanner: { stopLossPct: 0 } }, true), /Scanner stop-loss/);
  assert.throws(() => sanitizeConfig({ scanner: { tradeCoins: 'yes' } }, true));
});

test('pickTokens: old-coin slots mix established coins in with new ones', () => {
  const rows = [
    ...['N1', 'N2', 'N3', 'N4'].map((m, i) => row({ mint: m, change: { h1: 0, h24: 300 - i * 10 } })),
    row({ mint: 'O1', createdAt: now - 90 * D, liquidityUsd: 500_000, volume24h: 3e6, change: { h1: 0, h24: 25 } }),
    row({ mint: 'O2', createdAt: now - 40 * D, liquidityUsd: 500_000, volume24h: 3e6, change: { h1: 0, h24: 18 } }),
    row({ mint: 'OTHIN', createdAt: now - 40 * D, liquidityUsd: 50_000, volume24h: 3e6, change: { h1: 0, h24: 60 } }), // not deep enough for an old coin
  ];
  assert.deepEqual(pickTokens(rows, now, 4).map((x) => x.mint), ['N1', 'N2', 'N3', 'N4']); // no old slots: as before
  const t = pickTokens(rows, now, 4, new Set(), 2);
  assert.deepEqual(t.map((x) => x.mint), ['N1', 'N2', 'O1', 'O2']);
  assert.equal(t[2].old, true);
  assert.equal(t[0].old, undefined);
  // Unused slots go to whichever side has coins.
  assert.deepEqual(pickTokens(rows.slice(4), now, 4, new Set(), 1).map((x) => x.mint), ['O1', 'O2']);
});

// ---------------- proving the scanner ----------------
import { entryRulesFor, exitVariants, replayExit, replaySignals, signalStats } from './scanner';
import type { Candle } from './markets';

const X = { stopLossPct: 20, takeProfitPct: 50, trailingAfterPct: 15, trailingStopPct: 12, maxHoldHours: 12 };
const M = 300_000; // 5-minute candles
const path = (start: number, prices: [number, number, number][]): Candle[] => prices.map(([l, h, c], i) => ({ t: start + i * M, l, h, c }));

test('replayExit: stop-loss, take-profit, trailing stop, time limit, still open (with costs)', () => {
  const t0 = 1_000_000_000_000;
  assert.deepEqual(
    (({ pnlPct, reason, done }) => ({ pnlPct, reason, done }))(replayExit(1, t0, path(t0, [[0.95, 1.05, 1], [0.75, 1, 0.8]]), X, 0)),
    { pnlPct: -20, reason: 'stop-loss', done: true },
  );
  assert.equal(replayExit(1, t0, path(t0, [[0.98, 1.6, 1.5]]), X, 0).reason, 'take-profit');
  assert.equal(replayExit(1, t0, path(t0, [[0.98, 1.6, 1.5]]), X, 3).pnlPct, 47); // +50% minus 3% costs
  // Up 30%, then falls more than 12% from the peak: trailing stop at 1.3 × 0.88.
  const tr = replayExit(1, t0, path(t0, [[0.99, 1.3, 1.25], [1.1, 1.26, 1.12]]), X, 0);
  assert.equal(tr.reason, 'trailing stop');
  assert.equal(tr.pnlPct, 14.4);
  assert.equal(tr.peakPct, 30);
  // Drifts sideways past the hold limit.
  const flat = path(t0, Array.from({ length: 160 }, () => [0.97, 1.03, 1.01] as [number, number, number]));
  const tl = replayExit(1, t0, flat, X, 0);
  assert.equal(tl.reason, 'time limit');
  assert.equal(tl.exitAt, t0 + 144 * M);
  const open = replayExit(1, t0, flat.slice(0, 10), X, 0);
  assert.equal(open.done, false);
  assert.equal(open.reason, 'still open');
  // The low is checked first: a candle that touches both the stop and the target counts as a loss.
  assert.equal(replayExit(1, t0, path(t0, [[0.7, 1.6, 1.0]]), X, 0).reason, 'stop-loss');
  assert.equal(replayExit(1, t0, [], X).done, false);
});

test('replaySignals: fires on a rising coin with a volume surge, then waits out the trade and 6 hours', () => {
  const t0 = 1_000_000_000_000;
  const c: Candle[] = [];
  // 24 hours flat at 1 with low volume, then a 1-hour climb to 1.2 on heavy volume, then on to 1.6.
  for (let i = 0; i < 288; i++) c.push({ t: t0 + i * M, l: 0.99, h: 1.01, c: 1, v: 100 });
  for (let i = 1; i <= 12; i++) c.push({ t: t0 + (287 + i) * M, l: 1 + (i - 1) * 0.0167, h: 1 + i * 0.0167, c: 1 + i * 0.0167, v: 1000 });
  for (let i = 1; i <= 30; i++) c.push({ t: t0 + (299 + i) * M, l: 1.2 + (i - 1) * 0.015, h: 1.2 + i * 0.015, c: 1.2 + i * 0.015, v: 800 });
  const sig = replaySignals(c, M, entryRulesFor('new'), X, 0);
  assert.equal(sig.length, 1); // one trade, then the coin is skipped
  assert.ok(sig[0].up1hPct >= 8 && sig[0].up1hPct <= 60);
  assert.ok(sig[0].surge >= 1.3);
  assert.equal(sig[0].result.reason, 'take-profit');
  // A flat coin never fires; neither does one rising on no extra volume.
  assert.equal(replaySignals(c.slice(0, 288), M, entryRulesFor('new'), X).length, 0);
  const quiet = c.map((k) => ({ ...k, v: 100 }));
  assert.equal(replaySignals(quiet, M, entryRulesFor('new'), X).length, 0);
  // Strict rules want a bigger move than this one; loose rules fire earlier.
  assert.ok(entryRulesFor('new', 'strict').minUp > entryRulesFor('new').minUp);
  assert.ok(entryRulesFor('new', 'loose').minUp < entryRulesFor('new').minUp);
});

test('signalStats and exitVariants', () => {
  const r = (pnlPct: number, done = true) => ({ pnlPct, reason: '', exitAt: 0, done, peakPct: 0, troughPct: 0 });
  const s = signalStats([r(50), r(-20), r(10, false)], 0.1);
  assert.deepEqual(s, { signals: 3, closed: 2, wins: 2, avgPnlPct: 13.3, totalSol: 0.04, worstPct: -20, bestPct: 50 });
  assert.equal(signalStats([], 0.1).avgPnlPct, null);
  const v = exitVariants(X);
  assert.equal(v[0].id, 'current');
  assert.deepEqual(v[0].exits, X);
  assert.ok(v.length >= 4);
});
