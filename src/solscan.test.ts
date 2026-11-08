import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { holderStats } from './solscan';
import { holderSkipReason } from './rules';

test('holderStats: pools excluded, same owner merged, % from supply', () => {
  const pools = new Set(['POOL']);
  const s = holderStats(
    [
      { owner: 'POOL', amount_str: '600000' }, // liquidity pool: ignored
      { owner: 'whale', amount_str: '120000' },
      { owner: 'whale', amount_str: '30000' }, // second token account of the same wallet
      { owner: 'b', amount_str: '50000' },
      { owner: 'c', percentage: 2.5 }, // no amount: fall back to Solscan's percentage
      { owner: 42 },
    ],
    1_000_000n,
    1234,
    (o) => !pools.has(o),
  );
  assert.deepEqual(s, { holderCount: 1234, largestPct: 15, largestOwner: 'whale', top10Pct: 22.5 });
});

test('holderStats: real pool addresses (PDAs) are not counted as wallets', () => {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve')], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
  const wallet = Keypair.generate().publicKey.toBase58();
  const s = holderStats([{ owner: pda.toBase58(), amount_str: '800' }, { owner: wallet, amount_str: '100' }], 1000n, null);
  assert.equal(s.largestOwner, wallet);
  assert.equal(s.largestPct, 10);
});

test('holderSkipReason', () => {
  const f = { maxTopHolderPct: 15, maxTop10HoldersPct: 50 };
  assert.equal(holderSkipReason(null, f), null);
  assert.equal(holderSkipReason({ largestPct: 9, top10Pct: 40 }, f), null);
  assert.match(holderSkipReason({ largestPct: 31.2, top10Pct: 40 }, f)!, /one wallet owns 31.2%/);
  assert.match(holderSkipReason({ largestPct: 9, top10Pct: 62 }, f)!, /10 largest wallets own 62%/);
  assert.equal(holderSkipReason({ largestPct: 99, top10Pct: 99 }, { maxTopHolderPct: 0, maxTop10HoldersPct: 0 }), null);
});
