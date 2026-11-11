import { Connection, Keypair } from '@solana/web3.js';
import { Config } from './config';
import { WSOL } from './decode';
import type { Quote } from './jupiter';
import { Position, State, saveState } from './state';
import { appendJsonl, getTx, short } from './util';
import { copyGapPct } from './rules';
import { ORDER_SOURCE, SCANNER_SOURCE } from './config';
import { getChain, type ChainAdapter } from './chains';

export type Trade = {
  t: number;
  chain?: import('./chains/types').ChainId; // missing on trades from before chains: Solana
  mode: 'paper' | 'live';
  side: 'buy' | 'sell';
  mint: string;
  sol: number;
  tokenRaw: string;
  source?: string; // buys: the wallet we copied
  sources?: string[]; // sells: the wallet(s) the position was copied from
  pnl?: number;
  reason?: string;
  sig: string;
  gapPct?: number; // copy gap vs the copied wallet's own fill (positive = we did worse)
  lagSec?: number; // seconds between their trade and ours
  entry?: import('./learn').Entry; // sells: the conditions the position was bought in (for learning)
};

/** The copied wallet's own fill, to measure how much copying late cost us. */
export type CopyRef = { theirSol: number; theirRaw: bigint; at: number | null };

type Fill = { sig: string; tokenRaw: bigint; sol: number };
/** Typical network fees per trade (the same estimate backtests use on Solana; Base gas is far cheaper). */
export const PAPER_FEE_SOL = 0.0002;
export const PAPER_FEE_BASE_ETH = 0.00002;

export type TraderHooks = { log: (msg: string, level?: string) => void; trade: (t: Trade) => void; name: (wallet: string) => string };

/**
 * Executes trades. Paper mode uses Jupiter's quoted amounts and sends nothing.
 * Live mode signs and sends the swap, then reads real amounts from the chain.
 */
export class Trader {
  constructor(
    private conn: Connection,
    private cfg: Config,
    private state: State,
    private kp: Keypair | null,
    private hooks: TraderHooks,
  ) {}

  private get live() {
    return this.cfg.mode === 'live';
  }

  /** All trades go through the chain's adapter (today: Solana). */
  chain: ChainAdapter = getChain('solana');

  /** Estimated network fee of one trade, in SOL: what a live trade would pay on top of the swap. */
  private async paperFeeSol(chain: ChainAdapter): Promise<number> {
    if (chain.meta.id === 'solana') return PAPER_FEE_SOL + this.cfg.execution.jitoTipLamports / 1e9;
    return chain.nativeToSol(PAPER_FEE_BASE_ETH).catch(() => 0);
  }

  /** Coins nobody would buy last time we tried to sell: when we first noticed, how often, when to try again. */
  private noRoute = new Map<string, { since: number; tries: number; nextAt: number; loggedAt: number }>();
  /** How long a coin may have no buyers at all before it's written off in the books. */
  static readonly WRITE_OFF_AFTER_MS = 2 * 3_600_000;

  /**
   * A sale found no route: nobody to sell to (liquidity pulled, or the coin is dead). Try again with
   * growing pauses (30 s up to 10 min), say so once an hour, and after 2 hours close it in the books
   * as a loss so it stops holding a slot and your budget. In live mode the coins stay in your wallet.
   */
  private noBuyers(p: Position, reason: string): number | null {
    const now = Date.now();
    const nr = this.noRoute.get(p.mint) ?? { since: now, tries: 0, nextAt: now, loggedAt: 0 };
    nr.tries++;
    nr.nextAt = now + Math.min(30_000 * 2 ** (nr.tries - 1), 10 * 60_000);
    this.noRoute.set(p.mint, nr);
    if (now - nr.since >= Trader.WRITE_OFF_AFTER_MS && nr.tries >= 5) {
      this.noRoute.delete(p.mint);
      const loss = -p.costSol;
      this.state.realizedPnlSol += loss;
      delete this.state.positions[p.mint];
      this.record({ t: now, chain: getChain(p).meta.id, mode: this.cfg.mode, side: 'sell', mint: p.mint, sol: 0, tokenRaw: '0', pnl: loss, reason: 'no buyers for 2 hours: written off', sources: [...p.sources], ...(p.entry ? { entry: p.entry } : {}), sig: 'NONE' });
      this.hooks.log(`${short(p.mint)}: no one has been willing to buy it for 2 hours (its liquidity is gone), so it was written off as a loss of ${p.costSol.toFixed(4)} SOL to free its slot.${this.live ? ' The coins are still in your wallet if a buyer ever appears.' : ''}`, 'error');
      return loss;
    }
    if (now - nr.loggedAt >= 3_600_000) {
      nr.loggedAt = now;
      this.hooks.log(`SELL ${short(p.mint)} can't happen right now: no one is buying it (no route; ${reason}). Copybot keeps trying every few minutes and writes it off after 2 hours.`, 'warn');
    }
    return null;
  }

  /** Coins with a sell that was sent but not confirmed yet: don't sell them again meanwhile. */
  private lateSells = new Set<string>();

  private async swap(q: Quote, chain: ChainAdapter = this.chain, late?: { onFill: (r: Fill) => void; mint: string; side: 'buy' | 'sell' }): Promise<Fill> {
    const toToken = q.outputMint !== chain.meta.native.wrapped;
    // Amounts in the chain's own coin, converted to SOL (Copybot's books are in SOL).
    const native = Number(toToken ? q.inAmount : q.outAmount) / 10 ** chain.meta.native.decimals;
    const quoted = { tokenRaw: BigInt(toToken ? q.outAmount : q.inAmount), sol: await chain.nativeToSol(native) };
    if (!this.live) {
      // Paper trades pay an estimated network fee too, so paper results aren't rosier than live ones.
      const fee = await this.paperFeeSol(chain);
      return { sig: 'PAPER', tokenRaw: quoted.tokenRaw, sol: toToken ? quoted.sol + fee : Math.max(0, quoted.sol - fee) };
    }
    if (!chain.liveTrading) throw new Error(`Live trading on ${chain.meta.name} is off (paper mode only).`);
    const kp = this.kp!;
    const x = this.cfg.execution;
    let sig: string;
    try {
      sig = await chain.executeSwap({ conn: this.conn, kp, cfg: this.cfg }, q, { dynamicSlippage: x.dynamicSlippage, mevProtect: x.mevProtect, onNote: (m) => this.hooks.log(m, 'warn') });
    } catch (e) {
      const hash = (e as { pendingHash?: string }).pendingHash;
      if (hash && late && chain.settleLate) this.watchLate(hash, chain, quoted, late);
      throw e;
    }
    return this.fill(sig, chain, quoted);
  }

  /** Follow a trade that was sent but not confirmed in time, and book it if it goes through. */
  private watchLate(hash: string, chain: ChainAdapter, quoted: { tokenRaw: bigint; sol: number }, late: { onFill: (r: Fill) => void; mint: string; side: 'buy' | 'sell' }) {
    if (late.side === 'sell') this.lateSells.add(late.mint);
    void chain.settleLate!(hash)
      .then(async (ok) => {
        if (!ok) return this.hooks.log(`The ${late.side} of ${short(late.mint)} (${short(hash)}) never went through, so nothing changed.`, 'warn');
        late.onFill(await this.fill(hash, chain, quoted));
      })
      .catch((e) => this.hooks.log(`Couldn't follow up the ${late.side} of ${short(late.mint)} (${short(hash)}): ${(e as Error).message}. Check it on ${chain.meta.name}'s explorer.`, 'warn'))
      .finally(() => this.lateSells.delete(late.mint));
  }

  /** What really happened, from the confirmed transaction (falls back to the quote). */
  private async fill(sig: string, chain: ChainAdapter, quoted: { tokenRaw: bigint; sol: number }): Promise<Fill> {
    const kp = this.kp!;
    // What really happened, from the confirmed transaction (falls back to the quote).
    if (chain.readFill) {
      const owner = chain.liveOwner?.();
      const fill = owner ? await chain.readFill(sig, owner).catch(() => null) : null;
      return fill ? { sig, tokenRaw: fill.tokenRaw, sol: await chain.nativeToSol(fill.native) } : { sig, ...quoted };
    }
    const tx = await getTx(sig);
    const s = tx && chain.decodeSwap(tx, kp.publicKey.toBase58());
    return s ? { sig, tokenRaw: s.tokenAmount, sol: s.quoteAmount } : { sig, ...quoted };
  }

  private record(t: Trade) {
    saveState(this.state, this.cfg.mode);
    appendJsonl('data/trades.jsonl', t);
    this.hooks.trade(t);
  }

  private gap(side: 'buy' | 'sell', ref: CopyRef | undefined, sol: number, raw: bigint) {
    if (!ref) return {};
    const g = copyGapPct(side, ref.theirSol, ref.theirRaw, sol, raw);
    return { ...(g === null ? {} : { gapPct: Math.round(g * 100) / 100 }), ...(ref.at ? { lagSec: Math.max(0, Math.round((Date.now() / 1000 - ref.at) * 10) / 10) } : {}) };
  }

  async buy(mint: string, decimals: number, q: Quote, source: string, ref?: CopyRef, chain: ChainAdapter = this.chain) {
    const book = (r: Fill, late = false) => {
      const p: Position = this.state.positions[mint] ?? { chain: chain.meta.id, mint, decimals, amountRaw: '0', costSol: 0, openedAt: Date.now(), sources: [] };
      p.amountRaw = (BigInt(p.amountRaw) + r.tokenRaw).toString();
      p.costSol += r.sol;
      if (!p.sources.includes(source)) p.sources.push(source);
      this.state.positions[mint] = p;
      const g = late ? {} : this.gap('buy', ref, r.sol, r.tokenRaw);
      this.record({ t: Date.now(), chain: chain.meta.id, mode: this.cfg.mode, side: 'buy', mint, sol: r.sol, tokenRaw: r.tokenRaw.toString(), source, sig: r.sig, ...g });
      const note = g.gapPct !== undefined ? `, ${g.gapPct >= 0 ? `${g.gapPct.toFixed(1)}% above` : `${(-g.gapPct).toFixed(1)}% below`} their price${g.lagSec !== undefined ? `, ${g.lagSec}s after them` : ''}` : '';
      this.hooks.log(`BUY ${short(mint)} for ${r.sol.toFixed(4)} SOL (${source === SCANNER_SOURCE ? 'market scanner' : source === ORDER_SOURCE ? 'your order' : `copying ${this.hooks.name(source)}${note}`})${late ? ' — confirmed late, now in your positions' : ''}`, 'buy');
    };
    book(await this.swap(q, chain, { side: 'buy', mint, onFill: (r) => book(r, true) }));
  }

  /** Sell `fraction` (0..1] of our position. Returns the realized P&L, or null if nothing was sold. */
  async sell(mint: string, fraction: number, reason: string, ref?: CopyRef): Promise<number | null> {
    const p = this.state.positions[mint];
    if (!p) return null;
    const held = BigInt(p.amountRaw);
    const all = fraction >= 0.95;
    const amount = all ? held : (held * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
    if (amount <= 0n) return null;

    if (this.lateSells.has(mint)) {
      this.hooks.log(`SELL ${short(mint)} waits: an earlier sell of this coin is still being confirmed (${reason})`, 'warn');
      return null;
    }
    const chain = getChain(p);
    // No buyers last time: wait before asking again (and don't fill the log).
    const nr = this.noRoute.get(mint);
    if (nr && Date.now() < nr.nextAt) return null;
    const q = await chain.quoteSell(mint, amount, this.cfg.safety.slippageBps);
    if (!q) return this.noBuyers(p, reason);
    this.noRoute.delete(mint);
    const book = (r: Fill, late = false): number => {
      const pos = this.state.positions[mint];
      const heldNow = pos ? BigInt(pos.amountRaw) : 0n;
      const soldFrac = heldNow > 0n ? Math.min(1, Number(r.tokenRaw) / Number(heldNow)) : 1;
      const costPortion = pos ? pos.costSol * soldFrac : 0;
      const pnl = r.sol - costPortion;
      this.state.realizedPnlSol += pnl;
      if (pos) {
        pos.amountRaw = (heldNow - r.tokenRaw > 0n ? heldNow - r.tokenRaw : 0n).toString();
        pos.costSol -= costPortion;
        if ((all && !late) || BigInt(pos.amountRaw) === 0n) delete this.state.positions[mint];
      }
      this.record({ t: Date.now(), chain: chain.meta.id, mode: this.cfg.mode, side: 'sell', mint, sol: r.sol, tokenRaw: r.tokenRaw.toString(), pnl, reason, sources: [...p.sources], ...(p.entry ? { entry: p.entry } : {}), sig: r.sig, ...(late ? {} : this.gap('sell', ref, r.sol, r.tokenRaw)) });
      this.hooks.log(`SELL ${short(mint)} ${(soldFrac * 100).toFixed(0)}% for ${r.sol.toFixed(4)} SOL, PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} (${reason})${late ? ' — confirmed late' : ''}`, 'sell');
      return pnl;
    };
    return book(await this.swap(q, chain, { side: 'sell', mint, onFill: (r) => book(r, true) }));
  }
}
