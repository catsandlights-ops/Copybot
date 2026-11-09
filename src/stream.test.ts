import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import WS from 'ws';
import { FastStream, heliusWsUrl, parseNotification } from './stream';

test('heliusWsUrl', () => {
  assert.equal(heliusWsUrl('https://mainnet.helius-rpc.com/?api-key=abc-123'), 'wss://mainnet.helius-rpc.com/?api-key=abc-123');
  assert.equal(heliusWsUrl('https://api.mainnet-beta.solana.com'), null);
  assert.equal(heliusWsUrl('https://mainnet.helius-rpc.com/'), null); // no key
  assert.equal(heliusWsUrl('https://helius-rpc.com.evil.example/?api-key=x'), null);
});

const meta = { err: null, fee: 5000, preBalances: [10, 0], postBalances: [5, 5], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: ['W1'], readonly: ['R1'] } };

test('parseNotification: jsonParsed and base64 transactions', () => {
  const a = parseNotification({ signature: 'S1', transaction: { transaction: { message: { accountKeys: [{ pubkey: 'K0' }, 'K1'] } }, meta } }, 2_000_000)!;
  assert.deepEqual(a.accountKeys, ['K0', 'K1']);
  assert.equal(a.blockTime, 2000);
  const payer = Keypair.generate().publicKey, to = Keypair.generate().publicKey;
  const vt = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports: 1 })] }).compileToV0Message());
  const b = parseNotification({ signature: 'S2', transaction: { transaction: [Buffer.from(vt.serialize()).toString('base64'), 'base64'], meta } })!;
  assert.deepEqual(b.accountKeys, [payer.toBase58(), to.toBase58(), SystemProgram.programId.toBase58(), 'W1', 'R1']);
  assert.equal(parseNotification({ signature: 'x' }), null);
  assert.equal(parseNotification({ signature: 'x', transaction: { transaction: ['!!notbase64', 'base64'], meta } }), null);
});

test('FastStream: subscribes, delivers transactions, and stops when the plan refuses', async () => {
  const wss = new WS.Server({ port: 0 });
  const port = (wss.address() as any).port;
  let refuse = false;
  const subs: any[] = [];
  wss.on('connection', (sock) => {
    sock.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method !== 'transactionSubscribe') return;
      subs.push(m.params[0]);
      if (refuse) return sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not available on your plan' } }));
      sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }));
      sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'transactionNotification', params: { subscription: 7, result: { signature: 'SIG', transaction: { transaction: { message: { accountKeys: ['W'] } }, meta } } } }));
    });
  });
  const got: string[] = [];
  const statuses: string[] = [];
  const s = new FastStream(`ws://127.0.0.1:${port}`, ['W'], (tx) => got.push(tx.signature), (st) => statuses.push(st));
  s.start();
  for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got, ['SIG']);
  assert.deepEqual(subs[0].accountInclude, ['W']);
  assert.ok(statuses.includes('connected'));
  s.stop();

  refuse = true;
  const s2 = new FastStream(`ws://127.0.0.1:${port}`, ['W'], () => {}, () => {});
  s2.start();
  for (let i = 0; i < 50 && s2.status !== 'unavailable'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(s2.status, 'unavailable');
  assert.match(s2.detail, /not available/);
  s2.stop();
  wss.close();
});
