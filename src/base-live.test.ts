import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveData, baseAccount, checkBaseTx, KYBER_ROUTER } from './chains/base-live';

const OWNER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x4444444444444444444444444444444444444444';
const swapData = '0xe21fd0e9' + '00'.repeat(60) + OWNER.slice(2) + '00'.repeat(40);
const gas = 400_000n, fee = 2_000_000_000n; // 0.0008 ETH max
const MAX = 2n * 10n ** 15n; // 0.002 ETH

test('checkBaseTx: a correct buy and sell pass', () => {
  assert.equal(checkBaseTx({ to: KYBER_ROUTER, data: swapData, value: 10n ** 15n, gas, maxFeePerGas: fee }, { kind: 'swap', owner: OWNER, value: 10n ** 15n }, MAX), null);
  assert.equal(checkBaseTx({ to: KYBER_ROUTER.toUpperCase().replace('0X', '0x'), data: swapData, value: 0n, gas, maxFeePerGas: fee }, { kind: 'swap', owner: OWNER, value: 0n }, MAX), null);
});

test('checkBaseTx: refuses another destination, more ETH, payout elsewhere, high fees', () => {
  const ok = { to: KYBER_ROUTER, data: swapData, value: 10n ** 15n, gas, maxFeePerGas: fee };
  const exp = { kind: 'swap' as const, owner: OWNER, value: 10n ** 15n };
  assert.match(checkBaseTx({ ...ok, to: '0x9999999999999999999999999999999999999999' }, exp, MAX)!, /not the KyberSwap router/);
  assert.match(checkBaseTx({ ...ok, value: 10n ** 18n }, exp, MAX)!, /not the 0.001 ETH intended/);
  assert.match(checkBaseTx({ ...ok, data: '0xe21fd0e9' + '00'.repeat(100) }, exp, MAX)!, /doesn't pay out to your wallet/);
  assert.match(checkBaseTx({ ...ok, maxFeePerGas: 10n ** 10n }, exp, MAX)!, /network fee/);
  assert.match(checkBaseTx({ ...ok, data: '0x' }, exp, MAX)!, /no instructions/);
});

test('checkBaseTx: approvals only for the exact amount, the right token, the router', () => {
  const exp = { kind: 'approve' as const, token: TOKEN, amount: 500n };
  const tx = { to: TOKEN, data: approveData(KYBER_ROUTER, 500n), value: 0n, gas: 60_000n, maxFeePerGas: fee };
  assert.equal(checkBaseTx(tx, exp, MAX), null);
  assert.match(checkBaseTx({ ...tx, data: approveData(KYBER_ROUTER, 2n ** 256n - 1n) }, exp, MAX)!, /exactly the amount/); // "unlimited"
  assert.match(checkBaseTx({ ...tx, data: approveData('0x9999999999999999999999999999999999999999', 500n) }, exp, MAX)!, /exactly the amount/);
  assert.match(checkBaseTx({ ...tx, to: '0x5555555555555555555555555555555555555555' }, exp, MAX)!, /not for the token/);
  assert.match(checkBaseTx({ ...tx, value: 1n }, exp, MAX)!, /must not send ETH/);
  assert.equal(approveData(KYBER_ROUTER, 1n), '0x095ea7b3' + '0'.repeat(24) + KYBER_ROUTER.slice(2) + '0'.repeat(63) + '1');
});

test('baseAccount: valid keys only', () => {
  const a = baseAccount('0x' + '11'.repeat(32));
  assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(baseAccount('11'.repeat(32)).address, a.address);
  assert.throws(() => baseAccount('nope'), /64 hexadecimal/);
});
