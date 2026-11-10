import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSpotted, forgetSpotted, mergeCaught, spottedFor, SPOT_KEEP_MS } from './spotter';

const H = 3_600_000;

test('spotter: traders seen on more coins rank first; old ones fade; Base addresses ignore case', () => {
  let pool = addSpotted([], 'solana', new Map([['A', ['WIF']], ['B', ['BONK']]]), 0);
  pool = addSpotted(pool, 'solana', new Map([['B', ['POPCAT', 'BONK']]]), H);
  pool = addSpotted(pool, 'base', new Map([['0xAbC', ['DEGEN']]]), H);
  pool = addSpotted(pool, 'base', new Map([['0xabc', ['BRETT']]]), 2 * H);
  assert.deepEqual(pool.map((s) => [s.wallet, s.tokens]), [['0xabc', ['DEGEN', 'BRETT']], ['B', ['BONK', 'POPCAT']], ['A', ['WIF']]]);
  // A is forgotten after a day without being seen again; B is still remembered from its last sighting.
  const later = addSpotted(pool, 'solana', new Map(), SPOT_KEEP_MS + 30 * 60_000);
  assert.deepEqual(later.map((s) => s.wallet).sort(), ['0xabc', 'B']);
});

test('spotter: hands its traders to the full search, skips ones already copied, forgets checked ones', () => {
  let pool = addSpotted([], 'solana', new Map([['A', ['WIF']], ['B', ['BONK', 'POPCAT']], ['C', ['MEW']]]), 0);
  pool = addSpotted(pool, 'base', new Map([['0xdef', ['DEGEN']]]), 0);
  const forSol = spottedFor(pool, 'solana', new Set(['C']));
  assert.deepEqual([...forSol.keys()], ['B', 'A']);
  assert.deepEqual([...spottedFor(pool, 'base', new Set(['0xDEF'])).keys()], []); // already copied (any case)
  assert.deepEqual(mergeCaught(new Map([['A', ['JUP']]]), forSol), new Map([['A', ['JUP', 'WIF']], ['B', ['BONK', 'POPCAT']]]));
  pool = forgetSpotted(pool, 'solana', ['A', 'B']);
  assert.deepEqual(pool.map((s) => s.wallet).sort(), ['0xdef', 'C']);
});
