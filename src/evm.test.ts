import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addrTopic, decodeEvmSwap, isEvmAddress, TRANSFER_TOPIC, WITHDRAWAL_TOPIC, type EvmLog, type EvmTx } from './chains/evm';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const STABLES = { [USDC]: 'USDC' };
const ME = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const OTHER = '0x5555555555555555555555555555555555555555';
const hex = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const transfer = (token: string, from: string, to: string, amount: bigint): EvmLog => ({ address: token, topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)], data: hex(amount) });
const unwrap = (src: string, amount: bigint): EvmLog => ({ address: WETH, topics: [WITHDRAWAL_TOPIC, addrTopic(src)], data: hex(amount) });
const tx = (o: Partial<EvmTx>): EvmTx => ({ hash: '0xabc', from: ME, value: 0n, blockNumber: 100, blockTime: 1_700_000_000, status: true, logs: [], ...o });

test('decodeEvmSwap: buy with ETH sent in the transaction', () => {
  const s = decodeEvmSwap(tx({ value: 10n ** 16n, logs: [transfer(WETH, ROUTER, POOL, 10n ** 16n), transfer(TOKEN, POOL, ME, 5000n)] }), ME, WETH, STABLES);
  assert.deepEqual(s && { side: s.side, token: s.token, tokenRaw: s.tokenRaw, quote: s.quote, quoteRaw: s.quoteRaw }, { side: 'buy', token: TOKEN, tokenRaw: 5000n, quote: 'native', quoteRaw: 10n ** 16n });
});

test('decodeEvmSwap: sell for ETH (router unwraps WETH and sends ETH)', () => {
  const s = decodeEvmSwap(tx({ logs: [transfer(TOKEN, ME, POOL, 4000n), transfer(WETH, POOL, ROUTER, 7n * 10n ** 15n), unwrap(ROUTER, 7n * 10n ** 15n)] }), ME, WETH, STABLES);
  assert.equal(s?.side, 'sell');
  assert.equal(s?.tokenRaw, 4000n);
  assert.equal(s?.quote, 'native');
  assert.equal(s?.quoteRaw, 7n * 10n ** 15n);
});

test('decodeEvmSwap: WETH and stablecoin quotes', () => {
  const buyWeth = decodeEvmSwap(tx({ logs: [transfer(WETH, ME, POOL, 3n * 10n ** 15n), transfer(TOKEN, POOL, ME, 100n)] }), ME, WETH, STABLES);
  assert.deepEqual([buyWeth?.side, buyWeth?.quote, buyWeth?.quoteRaw], ['buy', 'native', 3n * 10n ** 15n]);
  const sellWeth = decodeEvmSwap(tx({ logs: [transfer(TOKEN, ME, POOL, 100n), transfer(WETH, POOL, ME, 2n * 10n ** 15n)] }), ME, WETH, STABLES);
  assert.deepEqual([sellWeth?.side, sellWeth?.quote, sellWeth?.quoteRaw], ['sell', 'native', 2n * 10n ** 15n]);
  const buyUsdc = decodeEvmSwap(tx({ logs: [transfer(USDC, ME, POOL, 25_000_000n), transfer(TOKEN, POOL, ME, 100n)] }), ME, WETH, STABLES);
  assert.deepEqual([buyUsdc?.side, buyUsdc?.quote, buyUsdc?.quoteRaw, buyUsdc?.stable], ['buy', 'stable', 25_000_000n, 'USDC']);
});

test('decodeEvmSwap: ignores failed transactions, plain transfers, other wallets and multi-token swaps', () => {
  const buy = [transfer(TOKEN, POOL, ME, 5000n)];
  assert.equal(decodeEvmSwap(tx({ status: false, value: 1n, logs: buy }), ME, WETH, STABLES), null);
  assert.equal(decodeEvmSwap(tx({ logs: buy }), ME, WETH, STABLES), null); // got tokens but paid nothing: an airdrop or a transfer
  assert.equal(decodeEvmSwap(tx({ value: 1n, logs: buy }), OTHER, WETH, STABLES), null);
  assert.equal(decodeEvmSwap(tx({ value: 1n, logs: [...buy, transfer(OTHER, POOL, ME, 1n)] }), ME, WETH, STABLES), null);
  // Someone else's transaction that pays this wallet ETH doesn't count unwrapped ETH as theirs.
  assert.equal(decodeEvmSwap(tx({ from: OTHER, logs: [transfer(TOKEN, ME, POOL, 1n), unwrap(ROUTER, 5n)] }), ME, WETH, STABLES), null);
});

test('isEvmAddress', () => {
  assert.equal(isEvmAddress(WETH), true);
  assert.equal(isEvmAddress('0x123'), false);
  assert.equal(isEvmAddress('9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump'), false);
});

test('decodeEvmSwap: plain ETH (no WETH log) is read from the balance change', () => {
  const sell = tx({ logs: [transfer(TOKEN, ME, POOL, 100n)] });
  assert.equal(decodeEvmSwap(sell, ME, WETH, STABLES), null);
  const s = decodeEvmSwap(sell, ME, WETH, STABLES, 9n * 10n ** 15n);
  assert.deepEqual([s?.side, s?.quote, s?.quoteRaw], ['sell', 'native', 9n * 10n ** 15n]);
  const buy = decodeEvmSwap(tx({ logs: [transfer(TOKEN, POOL, ME, 100n)] }), ME, WETH, STABLES, -(4n * 10n ** 15n));
  assert.deepEqual([buy?.side, buy?.quoteRaw], ['buy', 4n * 10n ** 15n]);
  // A balance change in the wrong direction doesn't make it a swap.
  assert.equal(decodeEvmSwap(sell, ME, WETH, STABLES, -5n), null);
});
