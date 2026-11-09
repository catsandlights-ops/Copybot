import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { checkInstructions, TxRejected } from './txguard';
import { WSOL } from './decode';

const me = Keypair.generate().publicKey;
const JUP = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TIP = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');
const conn = {} as Connection; // no lookup tables in these transactions, so it's never used
const jupIx = new TransactionInstruction({ programId: JUP, keys: [{ pubkey: me, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });
const tx = (...ixs: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: me, recentBlockhash: '11111111111111111111111111111111', instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs, jupIx] }).compileToV0Message());
const exp = (maxTipLamports?: number) => ({ wallet: me, inputMint: WSOL, inAmount: 50_000_000n, maxPriorityLamports: 1_000_000, maxTipLamports });

test('a plain Jupiter swap passes; a transfer to a stranger is rejected', async () => {
  await checkInstructions(conn, tx(), exp());
  await assert.rejects(checkInstructions(conn, tx(SystemProgram.transfer({ fromPubkey: me, toPubkey: Keypair.generate().publicKey, lamports: 1_000 })), exp(1_000_000)), TxRejected);
});

test('Jito tip: allowed only to an official tip account, within the limit, once', async () => {
  const tip = (lamports: number, to = TIP) => SystemProgram.transfer({ fromPubkey: me, toPubkey: to, lamports });
  const r = await checkInstructions(conn, tx(tip(500_000)), exp(1_000_000));
  assert.equal(r.tip, 500_000);
  assert.ok(r.priorityFee >= 500_000); // the tip counts toward what the simulation may spend
  await assert.rejects(checkInstructions(conn, tx(tip(500_000)), exp(0)), /unexpected SOL transfer/); // tips off
  await assert.rejects(checkInstructions(conn, tx(tip(2_000_000)), exp(1_000_000)), /unexpected SOL transfer/); // over the limit
  await assert.rejects(checkInstructions(conn, tx(tip(1_000, Keypair.generate().publicKey)), exp(1_000_000)), /unexpected SOL transfer/); // not a tip account
  await assert.rejects(checkInstructions(conn, tx(tip(100_000), tip(100_000)), exp(1_000_000)), /unexpected SOL transfer/); // two tips
});

test('priority fee above the limit is rejected', async () => {
  const big = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }); // 200k CU × 50 lamports = 10M lamports
  await assert.rejects(checkInstructions(conn, tx(big), exp()), /priority fee/);
});
