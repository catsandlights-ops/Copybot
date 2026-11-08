import { Connection, Keypair } from '@solana/web3.js';
import { Config } from './config';
import { decodeSwap, WSOL } from './decode';
import { Quote, executeSwap, quoteSell } from './jupiter';
import { Position, State, saveState } from './state';
import { appendJsonl, getTx, short } from './util';
import { copyGapPct } from './rules';

export type Trade = {
  t: number;
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
};

/** The copied wallet's own fill, to measure how much copying late cost us. */
export type CopyRef = { theirSol: number; theirRaw: bigint; at: number | null };

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

  private async swap(q: Quote): Promise<{ sig: string; tokenRaw: bigint; sol: number }> {
    const toToken = q.outputMint !== WSOL;
    const quoted = { tokenRaw: BigInt(toToken ? q.outAmount : q.inAmount), sol: Number(toToken ? q.inAmount : q.outAmount) / 1e9 };
    if (!this.live) return { sig: 'PAPER', ...quoted };
    const kp = this.kp!;
    const sig = await executeSwap(this.conn, kp, q, this.cfg.execution.priorityLevel, this.cfg.execution.priorityFeeMaxLamports);
    const tx = await getTx(sig);
    const s = tx && decodeSwap(tx, kp.publicKey.toBase58());
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

  async buy(mint: string, decimals: number, q: Quote, source: string, ref?: CopyRef) {
    const r = await this.swap(q);
    const p: Position = this.state.positions[mint] ?? { mint, decimals, amountRaw: '0', costSol: 0, openedAt: Date.now(), sources: [] };
    p.amountRaw = (BigInt(p.amountRaw) + r.tokenRaw).toString();
    p.costSol += r.sol;
    if (!p.sources.includes(source)) p.sources.push(source);
    this.state.positions[mint] = p;
    const g = this.gap('buy', ref, r.sol, r.tokenRaw);
    this.record({ t: Date.now(), mode: this.cfg.mode, side: 'buy', mint, sol: r.sol, tokenRaw: r.tokenRaw.toString(), source, sig: r.sig, ...g });
    const note = g.gapPct !== undefined ? `, ${g.gapPct >= 0 ? `${g.gapPct.toFixed(1)}% above` : `${(-g.gapPct).toFixed(1)}% below`} their price${g.lagSec !== undefined ? `, ${g.lagSec}s after them` : ''}` : '';
    this.hooks.log(`BUY ${short(mint)} for ${r.sol.toFixed(4)} SOL (copying ${this.hooks.name(source)}${note})`, 'buy');
  }

  /** Sell `fraction` (0..1] of our position. Returns the realized P&L, or null if nothing was sold. */
  async sell(mint: string, fraction: number, reason: string, ref?: CopyRef): Promise<number | null> {
    const p = this.state.positions[mint];
    if (!p) return null;
    const held = BigInt(p.amountRaw);
    const all = fraction >= 0.95;
    const amount = all ? held : (held * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
    if (amount <= 0n) return null;

    const q = await quoteSell(mint, amount, this.cfg.safety.slippageBps);
    if (!q) {
      this.hooks.log(`SELL ${short(mint)} skipped: no route (${reason})`, 'warn');
      return null;
    }
    const r = await this.swap(q);
    const soldFrac = Math.min(1, Number(r.tokenRaw) / Number(held));
    const costPortion = p.costSol * soldFrac;
    const pnl = r.sol - costPortion;
    this.state.realizedPnlSol += pnl;
    p.amountRaw = (held - r.tokenRaw > 0n ? held - r.tokenRaw : 0n).toString();
    p.costSol -= costPortion;
    if (all || BigInt(p.amountRaw) === 0n) delete this.state.positions[mint];
    this.record({ t: Date.now(), mode: this.cfg.mode, side: 'sell', mint, sol: r.sol, tokenRaw: r.tokenRaw.toString(), pnl, reason, sources: [...p.sources], sig: r.sig, ...this.gap('sell', ref, r.sol, r.tokenRaw) });
    this.hooks.log(`SELL ${short(mint)} ${(soldFrac * 100).toFixed(0)}% for ${r.sol.toFixed(4)} SOL, PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} (${reason})`, 'sell');
    return pnl;
  }
}
