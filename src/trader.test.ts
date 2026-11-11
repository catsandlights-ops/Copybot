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

test('paper trades pay an estimated network fee on the way in and out', async () => {
  const { solana } = await import('./chains/solana');
  const { PAPER_FEE_SOL } = await import('./trader');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-fee-'));
  const prev = process.cwd();
  const saved = solana.quoteSell;
  try {
    process.chdir(dir);
    fs.mkdirSync('data');
    const W = solana.meta.native.wrapped;
    const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    (solana as any).quoteSell = async (_m: string, raw: bigint) => ({ inputMint: MINT, outputMint: W, inAmount: raw.toString(), outAmount: '300000000' });
    const cfg = sanitizeConfig({}, false);
    const state = { positions: {}, realizedPnlSol: 0 } as any;
    const t = new Trader(null as any, cfg, state, null, { log: () => {}, trade: () => {}, name: (w) => w });
    await t.buy(MINT, 6, { inputMint: W, outputMint: MINT, inAmount: '250000000', outAmount: '1000' } as any, 'w', undefined, solana);
    assert.ok(Math.abs(state.positions[MINT].costSol - (0.25 + PAPER_FEE_SOL)) < 1e-12); // paid 0.25 + fee
    const pnl = await t.sell(MINT, 1, 'test');
    assert.ok(Math.abs(pnl! - (0.3 - PAPER_FEE_SOL - (0.25 + PAPER_FEE_SOL))) < 1e-12); // got 0.3 − fee
  } finally {
    (solana as any).quoteSell = saved;
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no buyers: retries quietly with growing pauses, then writes the coin off after 2 hours", async () => {
  const { solana } = await import('./chains/solana');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-noroute-'));
  const prev = process.cwd();
  const saved = solana.quoteSell;
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  try {
    process.chdir(dir);
    fs.mkdirSync('data');
    Date.now = () => now;
    let quotes = 0;
    (solana as any).quoteSell = async () => (quotes++, null); // nobody is buying
    const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const cfg = sanitizeConfig({}, false);
    const state = { positions: { [MINT]: { chain: 'solana', mint: MINT, decimals: 6, amountRaw: '1000', costSol: 0.1, openedAt: now - 13 * 3_600_000, sources: ['scanner'] } }, realizedPnlSol: 0 } as any;
    const logs: string[] = [];
    const t = new Trader(null as any, cfg, state, null, { log: (m) => logs.push(m), trade: () => {}, name: (w) => w });
    assert.equal(await t.sell(MINT, 1, "held 12 h (the scanner's limit)"), null);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /no one is buying it.*writes it off after 2 hours/);
    // The exit check runs every 20 s: those tries are skipped without asking or logging again.
    for (let i = 0; i < 10; i++) {
      now += 20_000;
      await t.sell(MINT, 1, 'x');
    }
    assert.ok(quotes < 6, `asked ${quotes} times in 200 s`);
    assert.equal(logs.length, 1);
    // Two hours later, still no buyers: written off as a loss, freeing the slot.
    for (let i = 0; i < 30 && state.positions[MINT]; i++) {
      now += 10 * 60_000;
      await t.sell(MINT, 1, 'x');
    }
    assert.equal(state.positions[MINT], undefined);
    assert.ok(Math.abs(state.realizedPnlSol + 0.1) < 1e-12);
    assert.match(logs.at(-1)!, /written off as a loss of 0.1000 SOL/);
  } finally {
    Date.now = realNow;
    (solana as any).quoteSell = saved;
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
