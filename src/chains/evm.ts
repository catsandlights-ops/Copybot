/**
 * Shared pieces for Ethereum-style chains (Base first): a small JSON-RPC client and the swap decoder.
 * The decoder is pure and unit-tested; it works from a transaction's token Transfer events, so it
 * understands any DEX or aggregator without knowing each one's contracts.
 */

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'; // WETH unwrap
export const NATIVE_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // "the chain's own coin" in aggregator APIs

export const isEvmAddress = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
/** An address as a 32-byte log topic. */
export const addrTopic = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const topicAddr = (t: string) => '0x' + t.slice(-40).toLowerCase();

export type EvmLog = { address: string; topics: string[]; data: string };
export type EvmTx = { hash: string; from: string; value: bigint; blockNumber: number; blockTime: number | null; status: boolean; logs: EvmLog[]; fee?: bigint };

export type EvmSwap = {
  hash: string;
  wallet: string;
  side: 'buy' | 'sell';
  token: string; // lowercase address
  tokenRaw: bigint; // how much of it was bought or sold, in its smallest unit
  quote: 'native' | 'stable';
  quoteRaw: bigint; // ETH (wei) or stablecoin (its smallest unit) spent or received
  stable?: string; // which stablecoin, when quote = stable
  blockNumber: number;
  blockTime: number | null;
};

/**
 * Did `wallet` buy or sell a token in this transaction? Looks at the token Transfer events to and
 * from the wallet, plus the ETH it sent (the transaction value) or got back (WETH unwrapped for it).
 * Returns null for anything that isn't one token swapped against ETH/WETH or a stablecoin.
 */
export function decodeEvmSwap(tx: EvmTx, walletIn: string, weth: string, stables: Record<string, string>, nativeDelta?: bigint): EvmSwap | null {
  if (!tx.status) return null;
  const wallet = walletIn.toLowerCase();
  const wethL = weth.toLowerCase();
  const stableSet = new Set(Object.keys(stables).map((s) => s.toLowerCase()));
  const net = new Map<string, bigint>(); // token -> change in the wallet's balance
  let unwrapped = 0n;
  for (const l of tx.logs) {
    const token = l.address.toLowerCase();
    if (l.topics[0] === WITHDRAWAL_TOPIC && token === wethL) unwrapped += BigInt(l.data);
    if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
    const from = topicAddr(l.topics[1]);
    const to = topicAddr(l.topics[2]);
    if (from !== wallet && to !== wallet) continue;
    const amount = BigInt(l.data === '0x' ? 0 : l.data);
    const d = (to === wallet ? amount : 0n) - (from === wallet ? amount : 0n);
    net.set(token, (net.get(token) ?? 0n) + d);
  }
  const tokens = [...net.entries()].filter(([t, v]) => v !== 0n && t !== wethL && !stableSet.has(t));
  if (tokens.length !== 1) return null; // nothing traded, or several tokens at once (not a simple swap)
  const [token, change] = tokens[0];
  const wethNet = net.get(wethL) ?? 0n;
  const stableMoves = [...net.entries()].filter(([t, v]) => stableSet.has(t) && v !== 0n);
  const sentByWallet = tx.from.toLowerCase() === wallet;
  const base = { hash: tx.hash, wallet, token, tokenRaw: change < 0n ? -change : change, blockNumber: tx.blockNumber, blockTime: tx.blockTime };
  if (change > 0n) {
    // Bought: paid with ETH (sent with the transaction), WETH, or a stablecoin.
    let eth = (sentByWallet ? tx.value : 0n) + (wethNet < 0n ? -wethNet : 0n);
    // Pools that take plain ETH leave no trace in the logs: use the wallet's ETH balance change.
    if (eth === 0n && nativeDelta != null && nativeDelta < 0n) eth = -nativeDelta;
    if (eth > 0n) return { ...base, side: 'buy', quote: 'native', quoteRaw: eth };
    const paid = stableMoves.find(([, v]) => v < 0n);
    if (paid) return { ...base, side: 'buy', quote: 'stable', quoteRaw: -paid[1], stable: stables[Object.keys(stables).find((k) => k.toLowerCase() === paid[0])!] };
    return null;
  }
  // Sold: received WETH, ETH (WETH unwrapped by the router for a swap the wallet sent), or a stablecoin.
  let eth = (wethNet > 0n ? wethNet : 0n) + (sentByWallet && wethNet <= 0n ? unwrapped : 0n);
  if (eth === 0n && nativeDelta != null && nativeDelta > 0n) eth = nativeDelta; // plain ETH paid out
  if (eth > 0n) return { ...base, side: 'sell', quote: 'native', quoteRaw: eth };
  const got = stableMoves.find(([, v]) => v > 0n);
  if (got) return { ...base, side: 'sell', quote: 'stable', quoteRaw: got[1], stable: stables[Object.keys(stables).find((k) => k.toLowerCase() === got[0])!] };
  return null;
}

// ---------------- a small JSON-RPC client ----------------

export class EvmRpc {
  private id = 0;
  private pick = 0; // which node is in use; moves on when one is busy
  /** urls(): your own node first (if set), then free public ones as fallbacks. */
  constructor(private urls: () => string[]) {}

  async call<T = any>(method: string, params: unknown[]): Promise<T> {
    const list = this.urls();
    for (let attempt = 0; ; attempt++) {
      const url = list[this.pick % list.length];
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(12_000),
        });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`Base RPC busy (HTTP ${res.status})`), { retry: true });
        const j = (await res.json()) as { result?: T; error?: { code?: number; message: string } };
        if (j.error) {
          const limited = j.error.code === -32011 || j.error.code === -32005 || /limit|rate|too many|specify an address/i.test(j.error.message);
          throw Object.assign(new Error(limited ? `Base RPC busy (${j.error.message})` : `Base RPC: ${j.error.message}`), { retry: limited });
        }
        return j.result as T;
      } catch (e: any) {
        const retry = e.retry || e.name === 'TimeoutError' || e.name === 'TypeError';
        if (!retry || attempt >= Math.max(2, list.length)) throw e;
        if (list.length > 1) this.pick++; // try the next node
        else await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }

  blockNumber = async () => Number(await this.call<string>('eth_blockNumber', []));
  /** A wallet's ETH balance change in one block, excluding the fee it paid (for swaps paid in plain ETH). */
  async nativeDelta(addr: string, block: number, fee: bigint): Promise<bigint | undefined> {
    const at = (b: number) => this.call<string>('eth_getBalance', [addr, '0x' + b.toString(16)]).then((x) => BigInt(x));
    const [before, after] = await Promise.all([at(block - 1), at(block)]).catch(() => [null, null]);
    return before == null || after == null ? undefined : after - before + fee;
  }
  balance = async (addr: string) => BigInt(await this.call<string>('eth_getBalance', [addr, 'latest']));

  /** ERC-20 view calls. */
  async decimals(token: string): Promise<number> {
    const r = await this.call<string>('eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
    return Number(BigInt(r));
  }
  async balanceOf(token: string, owner: string, block: number | 'latest' = 'latest'): Promise<bigint> {
    const r = await this.call<string>('eth_call', [{ to: token, data: '0x70a08231' + owner.toLowerCase().replace(/^0x/, '').padStart(64, '0') }, typeof block === 'number' ? '0x' + block.toString(16) : block]);
    return BigInt(r === '0x' ? 0 : r);
  }

  /** A transaction with its receipt logs and block time, ready for decodeEvmSwap. */
  async fullTx(hash: string, blockTimes: Map<number, number>): Promise<EvmTx | null> {
    const [tx, rc] = await Promise.all([this.call<any>('eth_getTransactionByHash', [hash]), this.call<any>('eth_getTransactionReceipt', [hash])]);
    if (!tx || !rc) return null;
    const blockNumber = Number(rc.blockNumber);
    let blockTime = blockTimes.get(blockNumber) ?? null;
    if (blockTime == null) {
      const b = await this.call<any>('eth_getBlockByNumber', [rc.blockNumber, false]).catch(() => null);
      if (b) {
        blockTime = Number(b.timestamp);
        blockTimes.set(blockNumber, blockTime);
        if (blockTimes.size > 500) blockTimes.delete(blockTimes.keys().next().value!);
      }
    }
    // What the sender paid in fees: gas, plus Base's L1 data fee when reported.
    const fee = BigInt(rc.gasUsed ?? 0) * BigInt(rc.effectiveGasPrice ?? 0) + BigInt(rc.l1Fee ?? 0);
    return { hash, from: tx.from, value: BigInt(tx.value ?? 0), blockNumber, blockTime, status: rc.status === '0x1', logs: rc.logs ?? [], fee };
  }
}
