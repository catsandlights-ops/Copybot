import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { sanitizeConfig } from './config';
import { Trader } from './trader';
import { base } from './chains/base';

const TOKEN = '0x4444444444444444444444444444444444444444';
const WETH = base.meta.native.wrapped;

test('Base trades confirmed late are booked when they go through; dropped ones change nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-late-'));
  const prev = process.cwd();
  const saved = Object.getOwnPropertyDescriptors(base);
  try {
    process.chdir(dir);
    fs.mkdirSync('data');
    // A pretend Base: every trade is sent but not confirmed in time; we decide later whether it lands.
    let settle!: (ok: boolean) => void;
    let sends = 0;
    Object.defineProperty(base, 'liveTrading', { get: () => true, configurable: true });
    Object.assign(base, {
      liveOwner: () => '0x1111111111111111111111111111111111111111',
      executeSwap: async () => { sends++; throw Object.assign(new Error('sent, not confirmed yet'), { pendingHash: '0xhash' + sends }); },
      settleLate: () => new Promise<boolean>((r) => { settle = r; }),
      readFill: async () => ({ tokenRaw: 1000n, native: 0.001 }),
      nativeToSol: async (n: number) => n * 10,
      quoteSell: async (_t: string, raw: bigint) => ({ inputMint: TOKEN, outputMint: WETH, inAmount: raw.toString(), outAmount: '900000000000000' }),
    });
    const cfg = sanitizeConfig({ mode: 'live' }, false);
    cfg.mode = 'live';
    const state = { positions: {}, realizedPnlSol: 0 } as any;
    const logs: string[] = [];
    const trades: any[] = [];
    const t = new Trader(null as any, cfg, state, Keypair.generate(), { log: (m) => logs.push(m), trade: (x) => trades.push(x), name: (w) => w });
    const wait = () => new Promise((r) => setTimeout(r, 20));

    // Buy: not confirmed in time -> an error now, nothing booked yet...
    await assert.rejects(t.buy(TOKEN, 18, { inputMint: WETH, outputMint: TOKEN, inAmount: '1000000000000000', outAmount: '990' } as any, 'wallet-a', undefined, base), /not confirmed yet/);
    assert.equal(Object.keys(state.positions).length, 0);
    // ...then it lands: the position appears with the real amounts.
    settle(true); await wait();
    assert.equal(state.positions[TOKEN].amountRaw, '1000');
    assert.equal(state.positions[TOKEN].costSol, 0.01);
    assert.equal(trades.length, 1);
    assert.match(logs.at(-1)!, /confirmed late/);

    // Sell: pending -> a second sell of the same coin waits instead of sending again.
    await assert.rejects(t.sell(TOKEN, 1, 'take profit'), /not confirmed yet/);
    assert.equal(await t.sell(TOKEN, 1, 'take profit'), null);
    assert.match(logs.at(-1)!, /still being confirmed/);
    assert.equal(sends, 2);
    // It never lands: nothing changes, and the coin can be sold again.
    settle(false); await wait();
    assert.match(logs.at(-1)!, /never went through/);
    assert.equal(state.positions[TOKEN].amountRaw, '1000');
    await assert.rejects(t.sell(TOKEN, 1, 'take profit'), /not confirmed yet/);
    assert.equal(sends, 3);
    // This time it lands: position closed, profit booked.
    settle(true); await wait();
    assert.equal(state.positions[TOKEN], undefined);
    assert.equal(trades.at(-1).side, 'sell');
    assert.ok(Math.abs(state.realizedPnlSol - 0) < 1e-12); // sold 1000 for 0.01 SOL, cost 0.01 SOL
  } finally {
    for (const [k, d] of Object.entries(saved)) Object.defineProperty(base, k, d);
    for (const k of ['settleLate'] as const) if (!(k in saved)) delete (base as any)[k];
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
