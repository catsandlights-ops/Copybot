import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradesCsv } from './csv';

test('trades CSV: header, labels, paper rows without tx, escaping and formula guard', () => {
  const csv = tradesCsv(
    [
      { t: Date.UTC(2026, 10, 1, 12), mode: 'paper', side: 'buy', mint: 'MINT', sol: 0.05, source: 'W1', sig: 'PAPER' },
      { t: Date.UTC(2026, 10, 1, 13), mode: 'live', side: 'sell', mint: 'MINT', sol: 0.08, pnl: -0.0123456789, sources: ['W1', 'W2'], reason: '=HYPERLINK("x"), "quoted"', sig: 'SIG' },
    ],
    new Map([['W1', 'alpha']]),
  );
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'date_utc,mode,side,token,sol,profit_sol,copied_from,reason,transaction,solscan');
  assert.equal(lines[1], '2026-11-01T12:00:00.000Z,paper,buy,MINT,0.05,,alpha,,,');
  assert.equal(lines[2], `2026-11-01T13:00:00.000Z,live,sell,MINT,0.08,-0.012345679,alpha + W2,"'=HYPERLINK(""x""), ""quoted""",SIG,https://solscan.io/tx/SIG`);
});
