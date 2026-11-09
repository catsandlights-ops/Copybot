import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('second read of the same wallet comes from the cache, not the network', async () => {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-hist-')));
  let hits = 0;
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    hits++;
    const sig = JSON.parse(raw).params[0];
    res.writeHead(200, { 'content-type': 'application/json' });
    // A transaction that isn't a swap for this wallet (no balance changes).
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { blockTime: 1, transaction: { signatures: [sig], message: { accountKeys: ['So11111111111111111111111111111111111111112'] } }, meta: { err: null, fee: 0, preBalances: [0], postBalances: [0], preTokenBalances: [], postTokenBalances: [] } } }));
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  process.env.RPC_URL = `http://127.0.0.1:${(srv.address() as any).port}`;
  const { fetchSwaps } = await import('./analyze');
  const sigs = Array.from({ length: 30 }, (_, i) => ({ signature: `sig${i}`, blockTime: 1000 - i, err: null }));
  const conn = { getSignaturesForAddress: async () => sigs } as any;
  const W = 'So11111111111111111111111111111111111111112';
  const s1: any = { read: 0, failed: 0 };
  await fetchSwaps(conn, W, 30, undefined, { tries: 1, stats: s1 });
  assert.equal(hits, 30);
  assert.ok(fs.existsSync(`data/history/${W}.json`));
  const s2: any = { read: 0, failed: 0 };
  await fetchSwaps(conn, W, 30, undefined, { tries: 1, stats: s2 });
  assert.equal(hits, 30, 'no new downloads');
  assert.equal(s2.cached, 30);
  srv.close();
});
