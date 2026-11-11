import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapsFromTransfers, toSwaps, type AlchemyTransfer } from './chains/base-history';

const W = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const hex = (n: bigint) => '0x' + n.toString(16);
const eth = (hash: string, block: number, from: string, to: string, wei: bigint, category = 'external'): AlchemyTransfer => ({ hash, blockNum: hex(BigInt(block)), from, to, category, rawContract: { address: null, value: hex(wei), decimal: '0x12' }, metadata: { blockTimestamp: new Date(1_700_000_000_000 + block * 2000).toISOString() } });
const erc = (hash: string, block: number, token: string, from: string, to: string, raw: bigint, dec = 18): AlchemyTransfer => ({ hash, blockNum: hex(BigInt(block)), from, to, category: 'erc20', rawContract: { address: token, value: hex(raw), decimal: hex(BigInt(dec)) }, metadata: { blockTimestamp: new Date(1_700_000_000_000 + block * 2000).toISOString() } });
const STABLES = new Set([USDC]);

test('swapsFromTransfers: buy with ETH, partial sell for ETH (internal), sell for USDC; running balances', () => {
  const tr = [
    eth('0xa', 10, W, ROUTER, 10n ** 16n), erc('0xa', 10, TOKEN, POOL, W, 1000n), // buy 1000 for 0.01 ETH
    erc('0xb', 20, TOKEN, W, POOL, 400n), eth('0xb', 20, ROUTER, W, 6n * 10n ** 15n, 'internal'), // sell 400 for 0.006 ETH
    erc('0xc', 30, TOKEN, W, POOL, 600n), erc('0xc', 30, USDC, POOL, W, 20_000_000n, 6), // sell the rest for 20 USDC
  ];
  // Both queries (to and from) return the same transfers: duplicates must not double count.
  const s = swapsFromTransfers([...tr, ...tr].reverse(), W, WETH, STABLES);
  assert.deepEqual(s.map((x) => [x.side, x.quote, x.tokenRaw, x.tokenPre, x.quoteRaw]), [
    ['buy', 'native', 1000n, 0n, 10n ** 16n],
    ['sell', 'native', 400n, 1000n, 6n * 10n ** 15n],
    ['sell', 'stable', 600n, 600n, 20_000_000n],
  ]);
  assert.equal(s[0].blockTime, Math.floor((1_700_000_000_000 + 10 * 2000) / 1000));
});

test('swapsFromTransfers: WETH quotes, unseen ETH proceeds, older buys outside the window', () => {
  const s = swapsFromTransfers(
    [
      erc('0xa', 1, WETH, W, POOL, 5n * 10n ** 15n), erc('0xa', 1, TOKEN, POOL, W, 50n),
      erc('0xb', 2, TOKEN, W, POOL, 80n), // sold more than seen bought (older buys) and the ETH paid out isn't visible
    ],
    W, WETH, STABLES,
  );
  assert.deepEqual([s[0].side, s[0].quote, s[0].quoteRaw], ['buy', 'native', 5n * 10n ** 15n]);
  assert.deepEqual([s[1].side, s[1].quote, s[1].tokenPre], ['sell', 'unknown', 80n]);
});

test('toSwaps: Copybot swap shape, ETH converted to SOL, unknown proceeds dropped', () => {
  const hs = swapsFromTransfers([eth('0xa', 1, W, ROUTER, 10n ** 17n), erc('0xa', 1, TOKEN, POOL, W, 7n, 9), erc('0xb', 2, TOKEN, W, POOL, 7n, 9)], W, WETH, STABLES);
  const sw = toSwaps(hs, W, 25);
  assert.equal(sw.length, 1);
  assert.deepEqual([sw[0].chain, sw[0].side, sw[0].quote, sw[0].quoteAmount, sw[0].nativeAmount, sw[0].decimals, sw[0].mint], ['base', 'buy', 'SOL', 2.5, 0.1, 9, TOKEN]);
});

test('earlyBuyersFromTransfers: tokens leaving the pool are buys; a router is followed to the buyer', async () => {
  const { earlyBuyersFromTransfers } = await import('./chains/base-history');
  const POOL = '0x' + '11'.repeat(20), ROUTER = '0x' + '22'.repeat(20), A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), DEPLOYER = '0x' + 'dd'.repeat(20);
  const tr = (hash: string, from: string, to: string): AlchemyTransfer => ({ hash, blockNum: '0x1', from, to, category: 'erc20', rawContract: { address: '0xtoken', value: '0x1', decimal: '0x12' } });
  const m = earlyBuyersFromTransfers(
    [
      tr('h0', '0x0000000000000000000000000000000000000000', DEPLOYER), // minted
      tr('h1', DEPLOYER, POOL.toUpperCase().replace('0X', '0x')), // liquidity added: not a buy
      tr('h2', POOL, A), // A buys directly
      tr('h3', POOL, ROUTER), // B buys through a router
      tr('h3', ROUTER, B),
      tr('h4', A, POOL), // A sells: not a buy
      tr('h5', POOL, A), // A buys again
    ],
    POOL,
    10,
  );
  assert.deepEqual([...m.entries()].sort(), [[A, 2], [B, 1]].sort());
});
