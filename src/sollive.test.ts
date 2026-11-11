import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landOrExpire, SolPendingError } from './jupiter';

// A pretend Solana node: the trade lands after `landAfter` status checks, or never; the block height climbs.
const fakeConn = (o: { landAfter?: number; err?: unknown; height?: () => number; broken?: boolean }) => {
  let checks = 0, h = 100;
  return {
    checks: () => checks,
    getSignatureStatuses: async () => {
      if (o.broken) throw new Error('429 Too Many Requests');
      checks++;
      if (o.err) return { value: [{ err: o.err, confirmationStatus: 'processed' }] };
      return { value: [o.landAfter != null && checks >= o.landAfter ? { err: null, confirmationStatus: 'confirmed' } : null] };
    },
    getBlockHeight: async () => {
      if (o.broken) throw new Error('429');
      return o.height ? o.height() : (h += 10);
    },
    getSignatureStatus: async () => ({ value: null }),
  } as any;
};

test('Solana trades: re-sent until they land; expired means nothing was traded; busy nodes are followed up', async () => {
  let resends = 0;
  // Lands on the 3rd check, after being re-sent while waiting.
  const c1 = fakeConn({ landAfter: 3, height: () => 100 });
  await landOrExpire(c1, 'sig1', 1000, async () => resends++, 30_000);
  assert.ok(resends >= 2, 're-sent while waiting');
  // Never lands; the blockhash expires: a clear "nothing was traded".
  const c2 = fakeConn({});
  await assert.rejects(landOrExpire(c2, 'sig2', 120, null, 30_000), /didn't land before it expired.*nothing was traded/);
  // Fails on-chain: that's a real failure.
  await assert.rejects(landOrExpire(fakeConn({ err: { InstructionError: [0, 'Custom'] } }), 'sig3', 1000, null, 30_000), /failed on-chain/);
  // The node can't answer at all: not called a failure; followed up later instead.
  await assert.rejects(landOrExpire(fakeConn({ broken: true }), 'sig4', 1000, null, 2_500), (e: unknown) => e instanceof SolPendingError && (e as SolPendingError).pendingHash === 'sig4');
});
