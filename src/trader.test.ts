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
      tokenBalance: async () => 1000n, // the wallet holds what the books say
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
    for (const k of ['settleLate', 'tokenBalance'] as const) if (!(k in saved)) delete (base as any)[k];
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

test('live sells: sell what the wallet really holds; a coin that vanished is closed as lost', async () => {
  const { solana } = await import('./chains/solana');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-real-'));
  const prev = process.cwd();
  const saved = Object.getOwnPropertyDescriptors(solana);
  try {
    process.chdir(dir);
    fs.mkdirSync('data');
    const W = solana.meta.native.wrapped;
    const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    let wallet = 600n, soldAmount = 0n;
    Object.defineProperty(solana, 'liveTrading', { get: () => true, configurable: true });
    Object.assign(solana, {
      tokenBalance: async () => wallet,
      quoteSell: async (_m: string, raw: bigint) => { soldAmount = raw; return { inputMint: MINT, outputMint: W, inAmount: raw.toString(), outAmount: '100000000' }; },
      executeSwap: async () => 'SIG',
      decodeSwap: () => null,
    });
    const cfg = sanitizeConfig({ mode: 'live' }, false);
    cfg.mode = 'live';
    const logs: string[] = [];
    const state = { positions: { [MINT]: { chain: 'solana', mint: MINT, decimals: 6, amountRaw: '1000', costSol: 0.2, openedAt: Date.now() - 3_600_000, sources: ['w'] } }, realizedPnlSol: 0 } as any;
    const t = new Trader(null as any, cfg, state, Keypair.generate(), { log: (m) => logs.push(m), trade: () => {}, name: (w) => w });
    (t as any).fill = async (sig: string, _c: unknown, q: any) => ({ sig, ...q }); // no network: use the quote
    // The books say 1000 but the wallet holds 600: it sells 600, not 1000.
    await t.sell(MINT, 1, 'test');
    assert.equal(soldAmount, 600n);
    assert.match(logs.join('\n'), /holds less than the books said \(600 vs 1000\)/);
    // A coin that's no longer in the wallet at all: closed in the books as a loss.
    state.positions[MINT] = { chain: 'solana', mint: MINT, decimals: 6, amountRaw: '1000', costSol: 0.2, openedAt: Date.now() - 3_600_000, sources: ['w'] };
    wallet = 0n;
    const pnl = await t.sell(MINT, 1, 'test');
    assert.equal(pnl, -0.2);
    assert.equal(state.positions[MINT], undefined);
    // Just bought and not showing yet: wait, don't close it.
    state.positions[MINT] = { chain: 'solana', mint: MINT, decimals: 6, amountRaw: '1000', costSol: 0.2, openedAt: Date.now(), sources: ['w'] };
    assert.equal(await t.sell(MINT, 1, 'test'), null);
    assert.ok(state.positions[MINT]);
  } finally {
    for (const [k, d] of Object.entries(saved)) Object.defineProperty(solana, k, d);
    for (const k of ['tokenBalance'] as const) if (!(k in saved)) delete (solana as any)[k];
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('crash safety: a trade sent just before the app died is booked on the next start, once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-crash-'));
  const prev = process.cwd();
  const saved = Object.getOwnPropertyDescriptors(base);
  try {
    process.chdir(dir);
    fs.mkdirSync('data');
    let landed = true;
    Object.defineProperty(base, 'liveTrading', { get: () => true, configurable: true });
    Object.assign(base, {
      liveOwner: () => '0x1111111111111111111111111111111111111111',
      // Sent... and then the app "dies": this never finishes.
      executeSwap: (_c: unknown, _q: unknown, x: any) => { x.onSent('0xsent1'); return new Promise(() => {}); },
      settleLate: async () => landed,
      readFill: async () => ({ tokenRaw: 1000n, native: 0.001 }),
      nativeToSol: async (n: number) => n * 10,
    });
    const cfg = sanitizeConfig({ mode: 'live' }, false);
    cfg.mode = 'live';
    const before = { positions: {}, realizedPnlSol: 0 } as any;
    const t1 = new Trader(null as any, cfg, before, Keypair.generate(), { log: () => {}, trade: () => {}, name: (w) => w });
    void t1.buy(TOKEN, 18, { inputMint: WETH, outputMint: TOKEN, inAmount: '1000000000000000', outAmount: '990' } as any, 'wallet-a', undefined, base);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(JSON.parse(fs.readFileSync('data/inflight-live.json', 'utf8'))[0].sig, '0xsent1'); // written down when sent
    // Next start: it landed, so it's booked (with the real fill), and the note is cleared.
    const state = { positions: {}, realizedPnlSol: 0 } as any;
    const logs: string[] = [];
    const t2 = new Trader(null as any, cfg, state, Keypair.generate(), { log: (m) => logs.push(m), trade: () => {}, name: (w) => w });
    assert.equal(await t2.recoverInflight(), 1);
    assert.equal(state.positions[TOKEN].amountRaw, '1000');
    assert.ok(Math.abs(state.positions[TOKEN].costSol - 0.01) < 1e-12);
    assert.match(logs.join('\n'), /Recovered a buy/);
    assert.deepEqual(JSON.parse(fs.readFileSync('data/inflight-live.json', 'utf8')), []);
    // Starting again books nothing twice.
    assert.equal(await t2.recoverInflight(), 0);
    // A trade that never landed changes nothing.
    landed = false;
    void t1.buy(TOKEN, 18, { inputMint: WETH, outputMint: TOKEN, inAmount: '1000000000000000', outAmount: '990' } as any, 'wallet-a', undefined, base);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await t2.recoverInflight(), 0);
    assert.equal(state.positions[TOKEN].amountRaw, '1000');
    // Booked just before the crash (it's in the trade log already): not booked again.
    landed = true;
    fs.appendFileSync('data/trades.jsonl', JSON.stringify({ sig: '0xsent1', side: 'buy', mode: 'live' }) + '\n');
    void t1.buy(TOKEN, 18, { inputMint: WETH, outputMint: TOKEN, inAmount: '1000000000000000', outAmount: '990' } as any, 'wallet-a', undefined, base);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await t2.recoverInflight(), 0);
    assert.equal(state.positions[TOKEN].amountRaw, '1000');
  } finally {
    for (const [k, d] of Object.entries(saved)) Object.defineProperty(base, k, d);
    for (const k of ['settleLate', 'tokenBalance'] as const) if (!(k in saved)) delete (base as any)[k];
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
    // The engine sees it's waiting (so it doesn't hold a slot or repeat "selling everything").
    assert.equal(t.noBuyersState(MINT), 'wait');
    assert.equal(t.noBuyersState('other'), null);
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
    assert.equal(t.noBuyersState(MINT), null);
    assert.match(logs.at(-1)!, /written off as a loss of 0.1000 SOL/);
  } finally {
    Date.now = realNow;
    (solana as any).quoteSell = saved;
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeOff: a dead coin leaves the books as a total loss, recorded, its slot freed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-writeoff-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync('data');
    const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const cfg = sanitizeConfig({}, false);
    const state = { positions: { [MINT]: { chain: 'solana', mint: MINT, decimals: 6, amountRaw: '1000', costSol: 0.25, openedAt: 1, sources: ['W1'] } }, realizedPnlSol: 0.1 } as any;
    const trades: any[] = [];
    const t = new Trader(null as any, cfg, state, null, { log: () => {}, trade: (x) => trades.push(x), name: (w) => w });
    assert.equal(t.writeOff(MINT, 'written off by you'), -0.25);
    assert.equal(state.positions[MINT], undefined);
    assert.ok(Math.abs(state.realizedPnlSol - -0.15) < 1e-12);
    assert.equal(trades.length, 1);
    assert.equal(trades[0].sig, 'NONE');
    assert.equal(trades[0].pnl, -0.25);
    assert.deepEqual(trades[0].sources, ['W1'], 'the loss counts against the wallet it was copied from');
    assert.ok(fs.readFileSync('data/trades.jsonl', 'utf8').includes('written off by you'));
    assert.equal(t.writeOff(MINT, 'again'), null, 'nothing to write off twice');
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
