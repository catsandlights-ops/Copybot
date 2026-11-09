import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isLimited, runChecks, summary } from './status';

test('classify: working, slow, rate-limited, down', () => {
  assert.deepEqual(classify(200, null), { health: 'ok', detail: 'working' });
  assert.equal(classify(5000, null).health, 'slow');
  assert.equal(classify(100, new Error('Jupiter is busy (HTTP 429)')).health, 'limited');
  assert.equal(classify(100, new Error('Base RPC busy (request limit reached)')).health, 'limited');
  assert.equal(classify(100, new Error('fetch failed')).health, 'down');
  assert.equal(isLimited('Too Many Requests'), true);
  assert.equal(isLimited('connection refused'), false);
});

test('runChecks: runs every check, times out slow ones, skips ones not in use, gives the fix', async () => {
  const rs = await runChecks(
    [
      { id: 'a', name: 'A', what: 'x', run: async () => 'block 5', fixes: {} },
      { id: 'b', name: 'B', what: 'x', run: () => new Promise(() => {}), fixes: { down: 'restart B' } },
      { id: 'c', name: 'C', what: 'x', run: async () => { throw new Error('HTTP 429'); }, fixes: { limited: 'add a key' } },
      { id: 'd', name: 'D', what: 'x', run: async () => {}, fixes: {}, enabled: () => false },
    ],
    300,
  );
  assert.deepEqual(rs.map((r) => r.health), ['ok', 'down', 'limited', 'off']);
  assert.match(rs[0].detail, /block 5/);
  assert.match(rs[1].detail, /no answer within/);
  assert.equal(rs[1].fix, 'restart B');
  assert.equal(rs[2].fix, 'add a key');
  assert.deepEqual(summary(rs), { level: 'bad', text: 'B is not working' });
  assert.deepEqual(summary(rs.filter((r) => r.id !== 'b')), { level: 'warn', text: 'C is busy or slow' });
  assert.deepEqual(summary([rs[0]]), { level: 'ok', text: 'Everything is working' });
});
