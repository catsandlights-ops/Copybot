import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcFailover } from './rpc';

test('switches to the backup after 5 failures in a row, and back after 5 minutes', () => {
  let now = 0;
  const events: string[] = [];
  let backup: string | null = 'B';
  const f = new RpcFailover(() => ({ primary: 'P', backup }), (to) => events.push(to), undefined, () => now);
  for (let i = 0; i < 4; i++) f.fail('P');
  f.ok('P'); // a success resets the count
  for (let i = 0; i < 4; i++) f.fail('P');
  assert.equal(f.current(), 'P');
  f.fail('P');
  assert.equal(f.current(), 'B');
  f.fail('B'); // failures on the backup don't bounce us around
  now = 4 * 60_000;
  assert.equal(f.current(), 'B');
  now = 5 * 60_000;
  assert.equal(f.current(), 'P');
  assert.deepEqual(events, ['backup', 'primary']);
  // No backup configured: never switches.
  backup = null;
  for (let i = 0; i < 20; i++) f.fail('P');
  assert.equal(f.current(), 'P');
});
