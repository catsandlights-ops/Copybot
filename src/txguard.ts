/**
 * Transaction guard: inspects every swap transaction returned by the Jupiter API
 * BEFORE the bot signs it. A compromised API, a malicious JUPITER_API_URL or a
 * man-in-the-middle could otherwise hand us a transaction that drains the wallet.
 *
 * Two layers:
 *  1. Static checks: only expected programs, only safe instructions from them,
 *     signed only by us, priority fee within the configured limit.
 *  2. Simulation: run the transaction against current chain state and confirm
 *     our SOL balance drops by no more than the swap input + fees.
 */
import { AddressLookupTableAccount, Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { WSOL } from './decode';

const P = {
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
};

/** Jito's official tip accounts (getTipAccounts). A tip may only go to one of these, up to your limit. */
export const JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

const BASE_FEE = 5_000; // lamports per signature
const RENT_MARGIN = 3 * 2_039_280; // up to three new token accounts (refundable rent)
const DEFAULT_CU_LIMIT = 1_400_000;

export class TxRejected extends Error {}

export type SwapExpectation = {
  wallet: PublicKey;
  inputMint: string;
  inAmount: bigint;
  maxPriorityLamports: number;
  maxTipLamports?: number; // Jito tip allowed (0/undefined = none)
};

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
const u64 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true);

function wsolAccount(wallet: PublicKey) {
  return PublicKey.findProgramAddressSync([wallet.toBuffer(), new PublicKey(P.token).toBuffer(), new PublicKey(WSOL).toBuffer()], new PublicKey(P.ata))[0];
}

async function lookupTables(conn: Connection, tx: VersionedTransaction): Promise<AddressLookupTableAccount[]> {
  return Promise.all(
    tx.message.addressTableLookups.map(async (l) => {
      const t = (await conn.getAddressLookupTable(l.accountKey)).value;
      if (!t) throw new TxRejected('transaction references an unknown address lookup table');
      return t;
    }),
  );
}

/** Layer 1: reject anything a normal Jupiter swap wouldn't contain. */
export async function checkInstructions(conn: Connection, tx: VersionedTransaction, exp: SwapExpectation) {
  const msg = tx.message;
  const me = exp.wallet.toBase58();
  if (msg.header.numRequiredSignatures !== 1 || msg.staticAccountKeys[0].toBase58() !== me) {
    throw new TxRejected('transaction must be paid for and signed only by your wallet');
  }
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: await lookupTables(conn, tx) });
  const key = (i: number) => keys.get(i)?.toBase58();
  const myWsol = wsolAccount(exp.wallet).toBase58();

  let cuLimit = DEFAULT_CU_LIMIT;
  let cuPrice = 0n; // micro-lamports per compute unit
  let wrapped = 0n;
  let tip = 0n;
  let sawJupiter = false;

  for (const ix of msg.compiledInstructions) {
    const program = key(ix.programIdIndex);
    const d = ix.data;
    const acct = (n: number) => key(ix.accountKeyIndexes[n]);
    switch (program) {
      case P.computeBudget:
        if (d[0] === 2) cuLimit = u32(d, 1);
        else if (d[0] === 3) cuPrice = u64(d, 1);
        break;
      case P.system: {
        // Only allowed: wrapping our own SOL into our own WSOL account, or one Jito tip within the limit.
        const isTransfer = d.length >= 12 && u32(d, 0) === 2;
        if (isTransfer && acct(0) === me && acct(1) === myWsol) {
          wrapped += u64(d, 4);
          break;
        }
        if (isTransfer && acct(0) === me && JITO_TIP_ACCOUNTS.has(acct(1) ?? '') && tip === 0n && exp.maxTipLamports && u64(d, 4) <= BigInt(exp.maxTipLamports)) {
          tip = u64(d, 4);
          break;
        }
        throw new TxRejected('unexpected SOL transfer in swap transaction');
      }
      case P.token:
      case P.token2022:
        // Only allowed: SyncNative (17), and CloseAccount (9) that refunds to us.
        if (d[0] === 17) break;
        if (d[0] === 9 && acct(1) === me && acct(2) === me) break;
        throw new TxRejected('unexpected token instruction (possible transfer/approval) in swap transaction');
      case P.ata:
        // Create (idempotent) associated token account: we pay and we own it.
        if ((d.length === 0 || d[0] === 0 || d[0] === 1) && acct(0) === me && acct(2) === me) break;
        throw new TxRejected('unexpected token-account instruction in swap transaction');
      case P.jupiter:
        sawJupiter = true;
        break;
      default:
        throw new TxRejected(`unexpected program ${program} in swap transaction`);
    }
  }
  if (!sawJupiter) throw new TxRejected('not a Jupiter swap');
  const maxWrap = exp.inputMint === WSOL ? exp.inAmount : 0n;
  if (wrapped > maxWrap) throw new TxRejected('transaction wraps more SOL than the trade size');

  const priorityFee = (BigInt(cuLimit) * cuPrice + 999_999n) / 1_000_000n;
  if (priorityFee > BigInt(Math.ceil(exp.maxPriorityLamports * 1.1) + 10_000)) {
    throw new TxRejected(`priority fee ${Number(priorityFee) / 1e9} SOL is above your limit`);
  }
  return { priorityFee: Number(priorityFee) + Number(tip), tip: Number(tip) };
}

/** Layer 2: simulate and make sure we don't lose more SOL than expected. */
export async function checkSimulation(conn: Connection, tx: VersionedTransaction, exp: SwapExpectation, priorityFee: number) {
  const before = await conn.getBalance(exp.wallet, 'confirmed');
  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses: [exp.wallet.toBase58()] },
  });
  if (sim.value.err) throw new TxRejected(`swap would fail: ${JSON.stringify(sim.value.err)}`);
  const after = sim.value.accounts?.[0]?.lamports;
  if (after == null) throw new TxRejected('could not verify the swap by simulation');
  const spent = before - after;
  const allowed = (exp.inputMint === WSOL ? Number(exp.inAmount) : 0) + priorityFee + BASE_FEE + RENT_MARGIN;
  if (spent > allowed) {
    throw new TxRejected(`swap would take ${(spent / 1e9).toFixed(4)} SOL from your wallet, expected at most ${(allowed / 1e9).toFixed(4)}`);
  }
}

export async function verifySwapTransaction(conn: Connection, tx: VersionedTransaction, exp: SwapExpectation) {
  const { priorityFee } = await checkInstructions(conn, tx, exp);
  await checkSimulation(conn, tx, exp, priorityFee);
}
