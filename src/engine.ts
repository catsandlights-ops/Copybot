import { EventEmitter } from 'node:events';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Config, loadConfig } from './config';
import { loadKeypair, makeConnection } from './env';
import { decodeSwap, Swap } from './decode';
import { quoteSell } from './jupiter';
import { checkToken } from './safety';
import { exposure, loadState, State } from './state';
import { Trade, Trader } from './trader';
import { getTx, short, sleep, withRetry } from './util';

export type LogEntry = { t: number; level: string; msg: string };
export type PositionValue = { valueSol: number; pnlPct: number; at: number };

/**
 * The copy-trading bot. Emits:
 *   'log'    LogEntry
 *   'trade'  Trade
 *   'status' (running state / positions changed)
 */
export class BotEngine extends EventEmitter {
  running = false;
  startedAt = 0;
  cfg!: Config;
  state!: State;
  kp: Keypair | null = null;
  walletBalance: number | null = null;
  values: Record<string, PositionValue> = {};
  logs: LogEntry[] = [];

  private conn!: Connection;
  private trader!: Trader;
  private gen = 0; // bumps on every start/stop so old loops exit
  private seen = new Set<string>();
  private subs: number[] = [];
  private labels = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private lastRateWarn = 0;
  keyError: string | null = null;

  constructor() {
    super();
    this.reload();
  }

  /** Errors from background work: collapse RPC rate limits into one warning per minute. */
  private logError(e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (/429|rate|Too Many/i.test(msg)) {
      if (Date.now() - this.lastRateWarn < 60_000) return;
      this.lastRateWarn = Date.now();
      return this.log('RPC is rate-limiting the bot, so some trades may be missed. A private RPC (e.g. Helius) fixes this.', 'warn');
    }
    this.log(`Error: ${msg}`, 'error');
  }

  log(msg: string, level = 'info') {
    const e = { t: Date.now(), level, msg };
    this.logs.push(e);
    if (this.logs.length > 500) this.logs.shift();
    console.log(new Date(e.t).toISOString().slice(11, 19), msg);
    this.emit('log', e);
  }

  /** (Re)load config, keys and the state file for the current mode. Safe while stopped. */
  reload() {
    this.cfg = loadConfig();
    try {
      this.kp = loadKeypair();
      this.keyError = null;
    } catch (e) {
      this.kp = null;
      this.keyError = (e as Error).message;
      this.log(this.keyError, 'error');
    }
    const { state, warning } = loadState(this.cfg.mode);
    this.state = state;
    if (warning) this.log(warning, 'error');
    this.conn = makeConnection();
    this.values = {};
    this.trader = new Trader(this.conn, this.cfg, this.state, this.kp, {
      log: (m, l) => this.log(m, l),
      trade: (t: Trade) => {
        this.emit('trade', t);
        this.emit('status');
        setTimeout(() => this.valuePositions(), 1500); // price new positions right away
      },
      name: (w) => this.labels.get(w) ?? short(w),
    });
    this.labels = new Map(this.cfg.wallets.map((w) => [w.address, w.label]));
  }

  /** Track processed signatures without growing memory forever. */
  private remember(sig: string) {
    this.seen.add(sig);
    if (this.seen.size > 50_000) this.seen = new Set([...this.seen].slice(-20_000));
  }

  private enqueue(fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((e) => this.logError(e));
    return this.queue;
  }

  async start() {
    if (this.running) return;
    this.reload();
    const wallets = this.cfg.wallets.filter((w) => w.enabled);
    if (!wallets.length) throw new Error('Add at least one wallet to copy first.');
    if (this.cfg.mode === 'live' && !this.kp) throw new Error(this.keyError ?? 'Live mode needs a trading wallet (Settings → Trading wallet).');

    const gen = ++this.gen;
    this.running = true;
    this.startedAt = Date.now();
    this.emit('status');
    this.log(`Bot started in ${this.cfg.mode.toUpperCase()} mode, watching ${wallets.length} wallet(s)`, 'system');

    for (const w of wallets) {
      try {
        const pk = new PublicKey(w.address);
        const recent = await withRetry(() => this.conn.getSignaturesForAddress(pk, { limit: 50 }), 4);
        recent.forEach((s) => this.remember(s.signature));
        if (gen !== this.gen) return;
        this.subs.push(
          this.conn.onLogs(pk, (l) => {
            if (!l.err && gen === this.gen) this.onSignature(l.signature, w.address).catch((e) => this.logError(e));
          }, 'confirmed'),
        );
        this.pollLoop(w.address, gen);
        this.log(`Watching ${this.labels.get(w.address)}`, 'system');
      } catch (e) {
        this.log(`Could not watch ${w.address}: ${(e as Error).message}`, 'error');
      }
    }
    this.exitLoop(gen);
    this.balanceLoop(gen);
  }

  async stop() {
    if (!this.running) return;
    this.gen++;
    this.running = false;
    for (const id of this.subs) await this.conn.removeOnLogsListener(id).catch(() => {});
    this.subs = [];
    this.log('Bot stopped', 'system');
    this.emit('status');
  }

  async manualSell(mint: string, fraction: number) {
    await this.enqueue(() => this.trader.sell(mint, fraction, 'manual'));
  }

  private async onSignature(sig: string, wallet: string) {
    if (this.seen.has(sig)) return;
    this.remember(sig);
    let tx;
    try {
      tx = await getTx(sig);
    } catch (e) {
      this.seen.delete(sig); // let the next poll retry
      throw e;
    }
    if (!tx || !this.running) return;
    const swap = decodeSwap(tx, wallet);
    if (!swap) return;
    const age = swap.blockTime ? Date.now() / 1000 - swap.blockTime : 0;
    this.log(`${this.labels.get(wallet)} ${swap.side === 'buy' ? 'bought' : 'sold'} ${short(swap.mint)} for ${swap.quoteAmount.toFixed(3)} ${swap.quote} (${age.toFixed(1)}s ago)`, 'signal');
    if (age > this.cfg.risk.maxSignalAgeSec) return this.log('  skipped: signal too old', 'skip');
    this.enqueue(() => (swap.side === 'buy' ? this.onTargetBuy(swap) : this.onTargetSell(swap)));
  }

  private async onTargetBuy(s: Swap) {
    const { cfg, state } = this;
    const r = cfg.risk;
    const skip = (why: string) => this.log(`  skipped: ${why}`, 'skip');
    const holding = state.positions[s.mint];
    if (holding && r.skipIfAlreadyHolding) return skip('already holding');
    if (!holding && Object.keys(state.positions).length >= r.maxOpenPositions) return skip('max open positions reached');
    if (s.quote === 'SOL' && s.quoteAmount < cfg.buy.minTargetBuySol) return skip(`their buy is below ${cfg.buy.minTargetBuySol} SOL`);

    let sol = cfg.buy.sizing === 'percent' && s.quote === 'SOL' ? (s.quoteAmount * cfg.buy.percentOfTarget) / 100 : cfg.buy.fixedSol;
    sol = Math.min(cfg.buy.maxSol, Math.max(cfg.buy.minSol, sol));
    if (exposure(state) + sol > r.maxTotalExposureSol) return skip('max total exposure reached');
    if (this.kp && cfg.mode === 'live') {
      const bal = (await this.conn.getBalance(this.kp.publicKey)) / 1e9;
      if (bal - sol < r.solReserve) return skip(`wallet balance ${bal.toFixed(3)} SOL too low`);
    }
    const check = await checkToken(this.conn, cfg, s.mint, BigInt(Math.round(sol * 1e9)));
    if (!check.ok) return skip(check.reason);
    await this.trader.buy(s.mint, s.decimals, check.buyQuote, s.wallet);
  }

  private async onTargetSell(s: Swap) {
    if (!this.cfg.sell.copySells) return;
    const p = this.state.positions[s.mint];
    if (!p || !p.sources.includes(s.wallet)) return;
    const fraction = s.tokenPost === 0n || s.tokenPre === 0n ? 1 : Number(s.tokenAmount) / Number(s.tokenPre);
    await this.trader.sell(s.mint, fraction, `copied ${this.labels.get(s.wallet)} selling ${(fraction * 100).toFixed(0)}%`);
  }

  private async pollLoop(wallet: string, gen: number) {
    const pk = new PublicKey(wallet);
    while (gen === this.gen) {
      try {
        const sigs = await withRetry(() => this.conn.getSignaturesForAddress(pk, { limit: 15 }), 3);
        for (const s of sigs.reverse()) if (!s.err && gen === this.gen) this.onSignature(s.signature, wallet).catch((e) => this.logError(e));
      } catch {
        /* rate limited; try again next round */
      }
      await sleep(this.cfg.monitor.pollIntervalSec * 1000);
    }
  }

  /** Values open positions and runs stop-loss / take-profit. */
  private async exitLoop(gen: number) {
    while (gen === this.gen) {
      await this.valuePositions();
      for (const p of Object.values(this.state.positions)) {
        const v = this.values[p.mint];
        if (!v || gen !== this.gen) continue;
        if (v.pnlPct <= -this.cfg.risk.stopLossPct) this.enqueue(() => this.trader.sell(p.mint, 1, `stop-loss ${v.pnlPct.toFixed(0)}%`));
        else if (v.pnlPct >= this.cfg.risk.takeProfitPct) this.enqueue(() => this.trader.sell(p.mint, 1, `take-profit +${v.pnlPct.toFixed(0)}%`));
      }
      await sleep(this.cfg.monitor.exitCheckIntervalSec * 1000);
    }
  }

  async valuePositions() {
    for (const p of Object.values(this.state.positions)) {
      try {
        const q = await quoteSell(p.mint, BigInt(p.amountRaw), this.cfg.safety.slippageBps);
        if (!q) continue;
        const valueSol = Number(q.outAmount) / 1e9;
        this.values[p.mint] = { valueSol, pnlPct: (valueSol / p.costSol - 1) * 100, at: Date.now() };
      } catch {
        /* ignore */
      }
    }
    this.emit('status');
  }

  private async balanceLoop(gen: number) {
    while (gen === this.gen) {
      await this.refreshBalance();
      await sleep(30_000);
    }
  }

  async refreshBalance() {
    if (!this.kp) {
      this.walletBalance = null;
      return;
    }
    try {
      this.walletBalance = (await this.conn.getBalance(this.kp.publicKey)) / 1e9;
      this.emit('status');
    } catch {
      /* keep the last known balance */
    }
  }

  snapshot() {
    const positions = Object.values(this.state.positions).map((p) => ({ ...p, ...this.values[p.mint], label: p.sources.map((s) => this.labels.get(s) ?? short(s)) }));
    const unrealized = positions.reduce((a, p) => a + (p.valueSol !== undefined ? p.valueSol - p.costSol : 0), 0);
    return {
      running: this.running,
      startedAt: this.startedAt,
      mode: this.cfg.mode,
      realizedPnlSol: this.state.realizedPnlSol,
      unrealizedPnlSol: unrealized,
      exposureSol: exposure(this.state),
      positions,
      wallet: this.kp ? { address: this.kp.publicKey.toBase58(), balance: this.walletBalance } : null,
    };
  }
}
