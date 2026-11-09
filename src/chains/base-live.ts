/**
 * Live trading on Base. Off unless you turn it on (Settings → Trading wallet) and add a Base key.
 *
 * Every transaction is checked before it's signed, the same idea as Solana's transaction guard:
 *   - a swap may only go to KyberSwap's router, with exactly the ETH we meant to spend (0 for a
 *     sell), and must pay out to your own wallet;
 *   - a spending approval may only be for the token being sold, for exactly the amount sold, and
 *     only for that router (never "unlimited");
 *   - the network fee must stay under your limit;
 *   - then the transaction is rehearsed on the network (eth_call) and only sent if it would succeed.
 * Base has no public waiting room for transactions (a single sequencer orders them), so trades
 * can't be seen and jumped ahead of the way they can elsewhere.
 */
import { privateKeyToAccount } from 'viem/accounts';
import type { Quote } from '../jupiter';
import { baseRpc } from './base';

export const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const KYBER_BUILD = 'https://aggregator-api.kyberswap.com/base/api/v1/route/build';
const BASE_CHAIN_ID = 8453;

const hex32 = (v: bigint | string) => (typeof v === 'string' ? v.toLowerCase().replace(/^0x/, '') : v.toString(16)).padStart(64, '0');
/** approve(spender, amount) call data. */
export const approveData = (spender: string, amount: bigint) => '0x095ea7b3' + hex32(spender) + hex32(amount);
/** allowance(owner, spender) call data. */
export const allowanceData = (owner: string, spender: string) => '0xdd62ed3e' + hex32(owner) + hex32(spender);

export type TxRequest = { to: string; data: string; value: bigint; gas: bigint; maxFeePerGas: bigint };
export type Expect = { kind: 'swap'; owner: string; value: bigint } | { kind: 'approve'; token: string; amount: bigint };

/** Is this transaction exactly what we meant to send? Returns why not, or null. Pure (unit-tested). */
export function checkBaseTx(tx: TxRequest, expect: Expect, maxFeeWei: bigint): string | null {
  const to = tx.to.toLowerCase();
  if (tx.gas * tx.maxFeePerGas > maxFeeWei) return `the network fee could reach ${(Number(tx.gas * tx.maxFeePerGas) / 1e18).toFixed(5)} ETH, above your limit of ${(Number(maxFeeWei) / 1e18).toFixed(5)} ETH`;
  if (expect.kind === 'approve') {
    if (to !== expect.token.toLowerCase()) return 'the approval is not for the token being sold';
    if (tx.value !== 0n) return 'an approval must not send ETH';
    if (tx.data.toLowerCase() !== approveData(KYBER_ROUTER, expect.amount)) return 'the approval is not for exactly the amount sold, to the KyberSwap router';
    return null;
  }
  if (to !== KYBER_ROUTER) return `the swap goes to ${to}, not the KyberSwap router`;
  if (tx.value !== expect.value) return `the swap would send ${Number(tx.value) / 1e18} ETH, not the ${Number(expect.value) / 1e18} ETH intended`;
  if (!/^0x[0-9a-f]{8,}$/i.test(tx.data)) return 'the swap has no instructions';
  if (!tx.data.toLowerCase().includes(expect.owner.toLowerCase().replace(/^0x/, ''))) return "the swap doesn't pay out to your wallet";
  return null;
}

/** The Base trading wallet, from its private key (0x + 64 hex characters). */
export function baseAccount(key: string) {
  const k = key.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) throw new Error('A Base private key is 64 hexadecimal characters (optionally starting with 0x).');
  return privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as `0x${string}`);
}

async function fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const [block, tip] = await Promise.all([baseRpc.call<any>('eth_getBlockByNumber', ['latest', false]), baseRpc.call<string>('eth_maxPriorityFeePerGas', []).catch(() => '0x186a0')]);
  const baseFee = BigInt(block?.baseFeePerGas ?? '0x0');
  const maxPriorityFeePerGas = BigInt(tip);
  return { maxFeePerGas: baseFee * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas };
}

async function waitReceipt(hash: string, timeoutMs = 60_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rc = await baseRpc.call<any>('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (rc) return rc;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Base transaction ${hash} wasn't confirmed within ${timeoutMs / 1000} s. It may still go through: check it on Basescan before trading this coin by hand.`);
}

/** The next transaction number: what the node reports, but never one Copybot already used (nodes can lag). */
export function nextNonce(pending: number, lastUsed: number | undefined): number {
  return lastUsed == null ? pending : Math.max(pending, lastUsed + 1);
}

const lastNonce = new Map<string, number>();
let queue: Promise<unknown> = Promise.resolve();
/** Base trades are sent one at a time, so two at once can't take the same transaction number. */
export function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Check, rehearse, sign and send one transaction; wait until it's confirmed. */
async function sendChecked(account: ReturnType<typeof baseAccount>, req: { to: string; data: string; value: bigint }, expect: Expect, maxFeeWei: bigint, gasHint?: bigint): Promise<string> {
  const from = account.address;
  // Rehearse first: a transaction that would fail is never sent (and costs nothing).
  await baseRpc.call('eth_call', [{ from, to: req.to, data: req.data, value: '0x' + req.value.toString(16) }, 'latest']).catch((e: Error) => {
    throw new Error(`The trade would fail, so it wasn't sent (${e.message.replace(/^Base RPC:? ?/, '')})`);
  });
  const est = await baseRpc.call<string>('eth_estimateGas', [{ from, to: req.to, data: req.data, value: '0x' + req.value.toString(16) }]).then((g) => BigInt(g)).catch(() => gasHint ?? 500_000n);
  const gas = (est * 13n) / 10n; // 30% headroom
  const f = await fees();
  const why = checkBaseTx({ ...req, gas, maxFeePerGas: f.maxFeePerGas }, expect, maxFeeWei);
  if (why) throw new Error(`Base transaction refused before signing: ${why}`);
  const nonce = nextNonce(Number(await baseRpc.call<string>('eth_getTransactionCount', [from, 'pending'])), lastNonce.get(from.toLowerCase()));
  const signed = await account.signTransaction({ chainId: BASE_CHAIN_ID, type: 'eip1559', to: req.to as `0x${string}`, data: req.data as `0x${string}`, value: req.value, gas, nonce, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas });
  const hash = await baseRpc.call<string>('eth_sendRawTransaction', [signed]);
  lastNonce.set(from.toLowerCase(), nonce);
  const rc = await waitReceipt(hash);
  if (rc.status !== '0x1') throw new Error(`Base transaction ${hash} failed on-chain.`);
  return hash;
}

/**
 * Execute a Base swap from a KyberSwap quote: approve the exact amount if selling a token,
 * then build, check, rehearse, sign and send the swap. Returns the swap's transaction hash.
 */
export function executeBaseSwap(key: string, quote: Quote, slippageBps: number, maxFeeEth: number, weth: string): Promise<string> {
  return oneAtATime(() => swapNow(key, quote, slippageBps, maxFeeEth, weth));
}

async function swapNow(key: string, quote: Quote, slippageBps: number, maxFeeEth: number, weth: string): Promise<string> {
  const account = baseAccount(key);
  const owner = account.address.toLowerCase();
  const maxFeeWei = BigInt(Math.round(maxFeeEth * 1e18));
  const selling = quote.inputMint.toLowerCase() !== weth.toLowerCase();
  const amountIn = BigInt(quote.inAmount);
  if (selling) {
    const allowance = BigInt(await baseRpc.call<string>('eth_call', [{ to: quote.inputMint, data: allowanceData(owner, KYBER_ROUTER) }, 'latest']).catch(() => '0x0'));
    if (allowance < amountIn) await sendChecked(account, { to: quote.inputMint, data: approveData(KYBER_ROUTER, amountIn), value: 0n }, { kind: 'approve', token: quote.inputMint, amount: amountIn }, maxFeeWei, 80_000n);
  }
  const res = await fetch(KYBER_BUILD, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': 'copybot' },
    body: JSON.stringify({ routeSummary: (quote as any).routeSummary, sender: owner, recipient: owner, slippageTolerance: slippageBps, deadline: Math.floor(Date.now() / 1000) + 120 }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: { routerAddress: string; data: string; transactionValue?: string; gas?: string } };
  if (!res.ok || j.code !== 0 || !j.data) throw new Error(`KyberSwap couldn't build the swap (${j.message ?? res.status})`);
  const value = BigInt(j.data.transactionValue ?? '0');
  return sendChecked(account, { to: j.data.routerAddress, data: j.data.data, value }, { kind: 'swap', owner, value: selling ? 0n : amountIn }, maxFeeWei, j.data.gas ? BigInt(j.data.gas) : undefined);
}
