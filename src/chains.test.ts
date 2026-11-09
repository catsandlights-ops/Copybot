import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chainIds, chainOf, DEFAULT_CHAIN, getChain, isChainId, KNOWN_CHAINS } from './chains';
import { sanitizeConfig } from './config';
import { makeOrder } from './orders';

const SOL_ADDR = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';

test('chain registry: Solana is the default, and the fallback for unknown or missing chains', () => {
  assert.equal(DEFAULT_CHAIN, 'solana');
  assert.deepEqual(chainIds(), ['solana']);
  assert.deepEqual([...KNOWN_CHAINS], chainIds());
  assert.equal(getChain().meta.id, 'solana');
  assert.equal(getChain({}).meta.id, 'solana'); // a record from before chains
  assert.equal(getChain({ chain: 'dogechain' }).meta.id, 'solana');
  assert.equal(chainOf(undefined), 'solana');
  assert.equal(chainOf({ chain: 'solana' }), 'solana');
  assert.equal(isChainId('solana'), true);
  assert.equal(isChainId('base'), false);
});

test('every chain adapter fills in the whole plug', () => {
  for (const id of chainIds()) {
    const c = getChain(id);
    for (const fn of ['decodeSwap', 'quoteBuy', 'quoteSell', 'executeSwap', 'checkToken', 'balance', 'nativeUsd'] as const) assert.equal(typeof c[fn], 'function', `${id}.${fn}`);
    const m = c.meta;
    assert.equal(m.id, id);
    assert.ok(m.name && m.native.symbol && m.native.decimals > 0 && m.geckoNetwork && m.dexscreenerId && m.nativeUsdPool && m.keySecret);
    assert.ok(m.isAddress(m.native.wrapped) && m.isAddress(m.stable.address));
    assert.match(m.explorer.tx('abc'), /^https:\/\//);
  }
});

test('Solana facts are exactly what Copybot used before chains', () => {
  const m = getChain('solana').meta;
  assert.equal(m.native.symbol, 'SOL');
  assert.equal(m.native.decimals, 9);
  assert.equal(m.geckoNetwork, 'solana');
  assert.equal(m.dexscreenerId, 'solana');
  assert.equal(m.keySecret, 'PRIVATE_KEY'); // existing installs keep their key
  assert.equal(m.isAddress(SOL_ADDR), true);
  assert.equal(m.isAddress('0x4200000000000000000000000000000000000006'), false);
  assert.equal(m.explorer.token('X'), 'https://solscan.io/token/X');
});

test('records get their chain: wallets in settings, new orders, and positions saved before chains', async () => {
  const cfg = sanitizeConfig({ wallets: [{ address: SOL_ADDR }, { address: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', chain: 'moonchain' }] }, false);
  assert.deepEqual(cfg.wallets.map((w) => w.chain), ['solana', 'solana']);
  const o = makeOrder({ kind: 'dca', mint: SOL_ADDR, sol: 0.1, everyHours: 1, times: 2 }, 1, 'id');
  assert.ok(typeof o !== 'string' && o.chain === 'solana');
  // A positions file written by an older version (no chain on positions) loads as Solana.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-chain-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync('data');
    fs.writeFileSync('data/state-paper.json', JSON.stringify({ positions: { [SOL_ADDR]: { mint: SOL_ADDR, decimals: 6, amountRaw: '1', costSol: 0.1, openedAt: 1, sources: [] } }, realizedPnlSol: 0 }));
    const { loadState } = await import('./state');
    assert.equal(loadState('paper').state.positions[SOL_ADDR].chain, 'solana');
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
