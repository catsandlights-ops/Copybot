import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDayStart, phoneWalletId, phoneWallets, todayByChain } from './phone';

test('phoneWallets: plain status per wallet, no addresses, best first within each status', () => {
  const B = '0x' + 'ab'.repeat(20);
  const list = phoneWallets(
    [
      { address: 'Sol1', label: 'one', enabled: true },
      { address: 'Sol2', label: 'two', enabled: true, trialStage: 0 },
      { address: B, label: 'base', enabled: false, shadow: true },
      { address: 'Sol3', label: 'three', enabled: false, pausedReason: '4 losses in a row' },
      { address: 'Sol4', label: 'four', enabled: false },
      { address: 'Sol5', label: 'five', enabled: true },
    ],
    { Sol1: { trades: 3, closed: 3, wins: 2, pnlSol: 0.1 }, Sol5: { trades: 3, closed: 3, wins: 3, pnlSol: 0.4 } },
    { [B]: { closed: 3, wins: 2, pnlSol: 0.05, profitFactor: 2, days: 0.5, open: 1, verdict: 'testing', why: 'needs 5 more finished trades' } },
  );
  assert.deepEqual(list.map((w) => [w.label, w.state]), [['five', 'copying'], ['one', 'copying'], ['two', 'trial'], ['base', 'shadow'], ['three', 'paused'], ['four', 'off']]);
  assert.equal(list.find((w) => w.label === 'base')!.chain, 'base');
  assert.match(list.find((w) => w.label === 'base')!.note, /3 virtual trades, \+0\.050 SOL · needs 5 more/);
  assert.match(list.find((w) => w.label === 'two')!.note, /¼ size/);
  assert.match(list.find((w) => w.label === 'three')!.note, /paused: 4 losses/);
  assert.ok(!JSON.stringify(list).includes('Sol1') && !JSON.stringify(list).includes(B), 'no addresses on the phone');
  assert.equal(list.find((w) => w.label === 'one')!.id, phoneWalletId('Sol1'));
  assert.notEqual(phoneWalletId('Sol1'), phoneWalletId('Sol2'));
});

test('todayByChain: today only, this mode only, split by chain', () => {
  const day = localDayStart(Date.UTC(2026, 10, 12, 15));
  const r = todayByChain(
    [
      { t: day + 1000, mode: 'paper', side: 'sell', pnl: 0.2, chain: 'solana' },
      { t: day + 2000, mode: 'paper', side: 'sell', pnl: -0.05, mint: '0x' + '11'.repeat(20) },
      { t: day + 3000, mode: 'paper', side: 'buy' },
      { t: day - 1000, mode: 'paper', side: 'sell', pnl: 5 }, // yesterday
      { t: day + 4000, mode: 'live', side: 'sell', pnl: 9 }, // other mode
    ],
    'paper',
    day,
  );
  assert.equal(r.closed, 2);
  assert.equal(r.wins, 1);
  assert.ok(Math.abs(r.pnlSol - 0.15) < 1e-12);
  assert.deepEqual(r.solana, { pnlSol: 0.2, closed: 1 });
  assert.deepEqual(r.base, { pnlSol: -0.05, closed: 1 });
});
