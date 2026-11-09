import { EventEmitter } from 'node:events';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Config, exitConfigFor, loadConfig, ORDER_SOURCE, SCANNER_SOURCE, walletRules } from './config';
import { afterAttempt, describeOrder, MAX_ACTIVE_ORDERS, orderDue, type Order } from './orders';
import * as markets from './markets';
import { downsample, pushPoint, type Pt } from './series';
import { overHeld } from './scanner';
import { loadKeypair, makeConnection } from './env';
import type { Swap } from './decode';
import type { CheckResult } from './safety';
import { chainOf, getChain, type ChainAdapter, type ChainId } from './chains';
import { skipCategory, type SignalStats } from './readiness';
import { consensusWallets, fallingShare, moodFrom, recordFactor, type Mood, type RecentBuy } from './smart';
import { exposure, loadState, saveState, State } from './state';
import { getHolderStats, HolderStats } from './solscan';
import { hasSecret, onRpcSwitch, rpcUrl } from './env';
import { FastStream, heliusWsUrl } from './stream';
import type { RawTx } from './util';
import { paperFreeSol, trialFactor, walletLifecycle } from './rules';
import { saveConfig } from './config';
import { panicReason } from './rules';
import { perTokenValue } from './rules';
import { buyBlockReason, dangerReason, holderSkipReason, ExitStep, freshGuard, GuardState, localDay, MarketInfo, marketSkipReason, planExit, priceDriftPct, recordSell, rollDay, walletExposureSol, walletRecords } from './rules';
import { getMarketInfo, getSolUsd } from './market';
import * as ai from './ai';
import fs from 'node:fs';
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
  private lastJupWarn = 0;
  private lastBaseWarn = 0;
  keyError: string | null = null;
  private stream: FastStream | null = null;

  constructor() {
    super();
    onRpcSwitch((to, why) => this.log(to === 'backup' ? `Switched to your backup RPC: ${why}.` : `Back on your main RPC (${why}).`, to === 'backup' ? 'warn' : 'system'));
    this.reload();
  }

  /** Errors from background work: collapse RPC rate limits into one warning per minute. */
  private logError(e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (/^Base RPC/.test(msg)) {
      if (Date.now() - this.lastBaseWarn < 60_000) return;
      this.lastBaseWarn = Date.now();
      return this.log(`The Base network node is busy or limiting Copybot (${msg.replace(/^Base RPC:? ?/, '')}), so some Base trades may be missed. A free Base RPC from Alchemy or QuickNode (Settings → Connection) fixes this.`, 'warn');
    }
    if (/Jupiter is busy/.test(msg)) {
      if (Date.now() - this.lastJupWarn < 60_000) return;
      this.lastJupWarn = Date.now();
      return this.log('Jupiter (the swap service) is busy right now, so some price checks and trades are delayed. Copybot keeps retrying; a Jupiter API key (Settings → Connection) raises the limit.', 'warn');
    }
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
    this.orders = this.loadOrders();
    this.loadSigStats();
    const { state, warning } = loadState(this.cfg.mode);
    this.state = state;
    if (warning) this.log(warning, 'error');
    this.conn = makeConnection();
    this.values = {};
    this.trader = new Trader(this.conn, this.cfg, this.state, this.kp, {
      log: (m, l) => this.log(m, l),
      trade: (t: Trade) => {
        if (t.side === 'sell' && typeof t.pnl === 'number') {
          this.afterSell(t.pnl);
          this.walletProgress(t.sources ?? []);
        }
        this.emit('trade', t);
        this.emit('status');
        setTimeout(() => this.valuePositions(), 1500); // price new positions right away
      },
      name: (w) => this.labels.get(w) ?? short(w),
    });
    this.setLabels();
  }

  private setLabels() {
    this.labels = new Map([[SCANNER_SOURCE, 'Market scanner'], [ORDER_SOURCE, 'Your order'], ...this.cfg.wallets.map((w) => [w.address, w.label] as [string, string])]);
  }

  /** The chain the bot trades on (today: Solana), and what its adapter needs. */
  chain: ChainAdapter = getChain('solana');
  private ctx() {
    return { conn: this.conn, kp: this.kp, cfg: this.cfg };
  }

  /** Track processed signatures without growing memory forever. */
  private remember(sig: string) {
    this.seen.add(sig);
    if (this.seen.size > 50_000) this.seen = new Set([...this.seen].slice(-20_000));
  }

  private enqueue(fn: () => Promise<unknown>) {
    this.queue = this.queue.then(fn).then(() => {}).catch((e) => this.logError(e));
    return this.queue;
  }

  async start() {
    if (this.running) return;
    this.reload();
    const wallets = this.cfg.wallets.filter((w) => w.enabled);
    const sc = this.cfg.scanner;
    const hasOrders = this.orders.some((o) => o.status === 'active');
    if (!wallets.length && !sc.tradeCoins && !sc.findTraders && !hasOrders) throw new Error('Add at least one wallet to copy first, turn on the Market scanner, or place an order.');
    if (this.cfg.mode === 'live' && !this.kp) throw new Error(this.keyError ?? 'Live mode needs a trading wallet (Settings → Trading wallet).');

    const gen = ++this.gen;
    this.running = true;
    this.startedAt = Date.now();
    this.emit('status');
    const scanning = [sc.tradeCoins && 'trading coins', sc.findTraders && 'finding traders'].filter(Boolean).join(' and ');
    this.log(`Bot started in ${this.cfg.mode.toUpperCase()} mode, watching ${wallets.length} wallet(s)${scanning ? `; market scanner ${scanning}` : ''}${hasOrders ? `; ${this.orders.filter((o) => o.status === 'active').length} open order(s)` : ''}`, 'system');

    // Wallets on other chains (Base): watched by their chain's adapter. Paper mode only where live isn't ready.
    const byChain = new Map<string, typeof wallets>();
    for (const w of wallets) if (chainOf(w) !== 'solana') byChain.set(chainOf(w), [...(byChain.get(chainOf(w)) ?? []), w]);
    for (const [id, ws] of byChain) {
      const c = getChain(id as ChainId);
      if (this.cfg.mode === 'live' && !c.liveTrading) {
        this.log(`${ws.length} ${c.meta.name} wallet(s) not watched: ${c.meta.name} runs in paper mode only for now.`, 'warn');
        continue;
      }
      if (!c.watch) continue;
      this.watchers.push(c.watch(ws.map((w) => w.address), (s) => this.onChainSwap(s, gen), (e) => this.logError(e)));
      for (const w of ws) this.log(`Watching ${this.labels.get(w.address)} (${c.meta.name})`, 'system');
    }
    for (const w of wallets.filter((x) => chainOf(x) === 'solana')) {
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
    this.orderLoop(gen);
    this.moodLoop(gen);
    (async () => { while (gen === this.gen) { await sleep(120_000); this.saveSigStats(); } })();
    this.balanceLoop(gen);
    this.aiLoop(gen);
    const wsu = this.cfg.execution.fastStream ? heliusWsUrl(rpcUrl()) : null;
    const solWallets = wallets.filter((x) => chainOf(x) === 'solana');
    if (wsu && solWallets.length) {
      this.stream = new FastStream(wsu, solWallets.map((w) => w.address), (tx) => this.onStreamTx(tx), (s, detail) => {
        if (s === 'connected') this.log('Fast trade detection is on (Helius stream).', 'system');
        if (s === 'unavailable') this.log(`Fast trade detection isn't available on your Helius plan (${detail}). Using the normal method.`, 'warn');
        this.emit('status');
      });
      this.stream.start();
    }
  }

  async stop() {
    if (!this.running) return;
    this.gen++;
    this.running = false;
    this.stream?.stop();
    this.stream = null;
    for (const w of this.watchers) w.stop();
    this.watchers = [];
    this.saveSigStats();
    for (const id of this.subs) await this.conn.removeOnLogsListener(id).catch(() => {});
    this.subs = [];
    this.log('Bot stopped', 'system');
    this.emit('status');
  }

  // ---------- the user's own orders: limit buys and sells, DCA ----------
  orders: Order[] = [];
  private ordersFile = () => `data/orders-${this.cfg.mode}.json`;

  private loadOrders(): Order[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.ordersFile(), 'utf8'));
      return Array.isArray(j) ? j.filter((o) => o && typeof o.id === 'string' && typeof o.mint === 'string') : [];
    } catch {
      return [];
    }
  }

  private saveOrders() {
    // Keep every active order and the 100 most recent finished ones.
    const active = this.orders.filter((o) => o.status === 'active');
    const done = this.orders.filter((o) => o.status !== 'active').slice(-100);
    this.orders = [...done, ...active].sort((a, b) => a.createdAt - b.createdAt);
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(this.ordersFile() + '.tmp', JSON.stringify(this.orders, null, 2));
    fs.renameSync(this.ordersFile() + '.tmp', this.ordersFile());
    this.emit('status');
  }

  addOrder(o: Order) {
    if (this.orders.filter((x) => x.status === 'active').length >= MAX_ACTIVE_ORDERS) throw new Error(`At most ${MAX_ACTIVE_ORDERS} open orders. Cancel one first.`);
    this.orders.push(o);
    this.saveOrders();
    this.log(`New order: ${describeOrder(o)}.${this.running ? '' : ' It starts when you start the bot.'}`, 'system');
  }

  cancelOrder(id: string): boolean {
    const o = this.orders.find((x) => x.id === id && x.status === 'active');
    if (!o) return false;
    Object.assign(o, { status: 'cancelled', note: 'cancelled by you', updatedAt: Date.now() });
    this.saveOrders();
    this.log(`Order cancelled: ${describeOrder(o)}.`, 'system');
    return true;
  }

  private ordersBusy = false;

  /** Checks prices for open orders every 15 seconds and acts on the ones that are due. */
  private async orderLoop(gen: number) {
    while (gen === this.gen) {
      if (!this.ordersBusy && this.orders.some((o) => o.status === 'active')) {
        this.ordersBusy = true;
        await this.checkOrders(gen).catch((e) => this.logError(e));
        this.ordersBusy = false;
      }
      await sleep(15_000);
    }
  }

  private async checkOrders(gen: number) {
    const active = this.orders.filter((o) => o.status === 'active');
    const mints = [...new Set(active.map((o) => o.mint))];
    const prices = new Map<string, number | null>();
    for (let i = 0; i < mints.length; i += 30) {
      const list = await markets.tokens(mints.slice(i, i + 30)).catch(() => []);
      for (const t of list as { mint: string | null; priceUsd: number | null }[]) {
        if (!t.mint) continue;
        prices.set(t.mint, t.priceUsd ?? null);
        if (t.priceUsd) this.orderPrices.set(t.mint, pushPoint(this.orderPrices.get(t.mint) ?? [], [Date.now(), t.priceUsd], 480));
      }
    }
    let changed = false;
    for (const o of active) {
      if (gen !== this.gen) return;
      const now = Date.now();
      const act = orderDue(o, prices.get(o.mint) ?? null, !!this.state.positions[o.mint], now);
      if (!act) continue;
      changed = true;
      const replace = (n: Order) => (this.orders = this.orders.map((x) => (x.id === o.id ? n : x)));
      if ('expire' in act) {
        replace({ ...o, status: 'expired', note: 'expired before the price was reached', updatedAt: now });
        this.log(`Order expired: ${describeOrder(o)}.`, 'system');
      } else if ('skip' in act) {
        // A sell order waits while there's nothing to sell; a DCA round is skipped.
        replace(o.kind === 'dca' ? afterAttempt(o, false, act.skip, now) : { ...o, note: act.skip, updatedAt: now });
        if (o.kind === 'dca') this.log(`Order: skipped a round of "${describeOrder(o)}": ${act.skip}.`, 'skip');
      } else if ('buySol' in act) {
        this.log(`Order: ${describeOrder(o)}${o.kind === 'dca' ? ` (buy ${o.done + 1} of ${o.times})` : ''}`, 'signal');
        const why = await new Promise<string | null>((resolve) => {
          this.enqueue(async () => resolve(await this.orderBuyNow(o.mint, act.buySol).catch((e) => (e as Error).message)));
        });
        if (why) this.log(`  skipped: ${why}`, 'skip');
        replace(afterAttempt(o, !why, why ?? `bought ${act.buySol} SOL`, Date.now()));
      } else if ('sellFraction' in act) {
        const pnl = await new Promise<number | null>((resolve) => {
          this.enqueue(async () => resolve(await this.trader.sell(o.mint, act.sellFraction, `your order: ${describeOrder(o)}`).catch(() => null)));
        });
        replace(afterAttempt(o, pnl !== null, pnl === null ? 'the sell did not go through' : `sold, profit ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`, Date.now()));
      }
    }
    if (changed) this.saveOrders();
  }

  /** An order's buy: the same limits and safety checks as every other buy. Returns why not, or null. */
  private async orderBuyNow(mint: string, sol: number): Promise<string | null> {
    if (!this.running) return 'the bot stopped';
    const room = this.roomFor(mint, sol);
    if (room) return room;
    if (this.kp && this.cfg.mode === 'live') {
      const bal = await this.chain.balance(this.ctx(), this.kp.publicKey.toBase58());
      if (bal - sol < this.cfg.risk.solReserve) return `wallet balance ${bal.toFixed(3)} SOL too low`;
    }
    const checked = await this.tokenChecks(mint, sol, false);
    if (typeof checked === 'string') return checked;
    if (!this.running) return 'the bot stopped';
    await this.trader.buy(mint, checked.check.decimals, checked.check.buyQuote, ORDER_SOURCE);
    return null;
  }

  // ---------- panic: sell everything and stop ----------
  panicking = false;

  /**
   * Sell every open position in full, then stop the bot. Works whether or not the bot is running.
   * Each sell is tried twice; anything that still can't be sold is reported (and stays open).
   */
  async panic(reason: string): Promise<{ sold: number; failed: string[] }> {
    if (this.panicking) throw new Error('Already selling everything.');
    this.panicking = true;
    this.emit('status');
    try {
      this.log(`PANIC: selling everything and stopping (${reason}).`, 'warn');
      this.emit('guard', `Selling everything and stopping: ${reason}`);
      // Stop first so nothing new is bought while selling; exits for anything left are retried below.
      if (this.running) await this.stop();
      const open = this.orders.filter((o) => o.status === 'active');
      if (open.length) {
        const now = Date.now();
        this.orders = this.orders.map((o) => (o.status === 'active' ? { ...o, status: 'cancelled' as const, note: 'cancelled by Sell everything', updatedAt: now } : o));
        this.saveOrders();
        this.log(`Cancelled ${open.length} open order${open.length === 1 ? '' : 's'}.`, 'warn');
      }
      let sold = 0;
      // Keep trying for about half a minute: a busy swap service or RPC shouldn't leave positions open.
      for (let attempt = 0; attempt < 5; attempt++) {
        for (const mint of Object.keys(this.state.positions)) {
          await this.enqueue(async () => {
            if (!this.state.positions[mint]) return;
            const pnl = await this.trader.sell(mint, 1, `panic: ${reason}`);
            if (pnl !== null) sold++;
          });
        }
        if (!Object.keys(this.state.positions).length) break;
        if (attempt < 4) this.log(`Still selling ${Object.keys(this.state.positions).length} position(s); trying again…`, 'warn');
        await sleep(3000 * (attempt + 1));
      }
      const failed = Object.keys(this.state.positions);
      if (failed.length) this.log(`Couldn't sell ${failed.length} position(s): ${failed.map(short).join(', ')}. Sell them by hand on the Dashboard.`, 'error');
      else this.log(sold ? `Everything sold (${sold} position${sold === 1 ? '' : 's'}). The bot is stopped.` : 'No open positions left to sell. The bot is stopped.', 'system');
      return { sold, failed };
    } finally {
      this.panicking = false;
      this.emit('status');
    }
  }

  // ---------- circuit breaker ----------
  private get guard(): GuardState {
    return rollDay(this.state.guard ?? freshGuard(Date.now()), Date.now());
  }

  private afterSell(pnl: number) {
    const { guard, event } = recordSell(this.guard, pnl, this.cfg.risk, Date.now());
    this.state.guard = guard;
    saveState(this.state, this.cfg.mode);
    if (event) {
      this.log(event, 'warn');
      this.emit('guard', event);
    }
  }

  /** Trial step-ups and auto-pauses for the wallets a sell was copied from. Saved without a restart. */
  private walletProgress(sources: string[]) {
    const trades = this.readTrades();
    let changed = false;
    // The market scanner stops buying after the same losing streak that pauses a wallet.
    const n = this.cfg.trial.pauseAfterLosses;
    if (sources.includes(SCANNER_SOURCE) && this.cfg.scanner.tradeCoins && n > 0) {
      const pnls = trades.filter((t: any) => t.mode === this.cfg.mode && t.side === 'sell' && typeof t.pnl === 'number' && t.sources?.includes(SCANNER_SOURCE) && t.t >= this.scannerSince).map((t: any) => t.pnl as number);
      if (pnls.length >= n && pnls.slice(-n).every((p) => p < 0)) {
        this.cfg.scanner.tradeCoins = false;
        this.log(`Market scanner stopped buying coins: ${n} losing trades in a row. Its open coins still follow their exits. Turn it back on in Scanner.`, 'warn');
        changed = true;
      }
    }
    for (const addr of sources) {
      const w = this.cfg.wallets.find((x) => x.address === addr);
      if (!w || !w.enabled) continue;
      const pnls = trades
        .filter((t: any) => t.mode === this.cfg.mode && t.side === 'sell' && typeof t.pnl === 'number' && t.sources?.includes(addr) && t.t >= (w.since ?? 0))
        .map((t: any) => t.pnl as number);
      const { stepUp, pause } = walletLifecycle(w, pnls, this.cfg.trial);
      if (pause) {
        w.enabled = false;
        w.pausedReason = pause;
        this.log(`Paused ${w.label}: ${pause}. Open positions from it still follow its sells. Turn it back on in Wallets.`, 'warn');
        changed = true;
      } else if (stepUp) {
        w.trialStage = w.trialStage === 0 ? 1 : undefined;
        if (w.trialStage === undefined) delete w.trialStage;
        w.since = Date.now();
        this.log(`${w.label} passed its trial step: now copying at ${w.trialStage === 1 ? 'half' : 'full'} size.`, 'system');
        changed = true;
      }
    }
    if (changed) {
      saveConfig(this.cfg);
      this.setLabels();
      this.emit('config', this.cfg);
      this.emit('status');
    }
  }

  /** Let the bot buy again today despite the daily limit / losing-streak pause. */
  resumeBuying() {
    this.state.guard = { ...this.guard, pausedUntil: 0, lossStreak: 0, resumedDay: localDay(Date.now()) };
    saveState(this.state, this.cfg.mode);
    this.log('Buying resumed by you. The daily loss limit is off for the rest of today.', 'system');
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
    this.onTx(tx, wallet);
  }

  /** A transaction from the fast stream: already complete, no fetch needed. */
  private onStreamTx(tx: RawTx) {
    if (!this.running || this.seen.has(tx.signature) || tx.meta?.err) return;
    for (const w of this.cfg.wallets) {
      if (!w.enabled || !tx.accountKeys.includes(w.address)) continue;
      if (this.chain.decodeSwap(tx, w.address)) {
        this.remember(tx.signature);
        this.onTx(tx, w.address);
        return;
      }
    }
  }

  // ---------- signal counts per wallet (seen, copied, skip reasons), saved per mode ----------
  sigStats: SignalStats = {};
  private sigDirty = false;
  private sigFile = () => `data/signal-stats-${this.cfg.mode}.json`;
  loadSigStats() {
    try {
      const j = JSON.parse(fs.readFileSync(this.sigFile(), 'utf8'));
      this.sigStats = j && typeof j === 'object' ? j : {};
    } catch {
      this.sigStats = {};
    }
  }
  saveSigStats() {
    if (!this.sigDirty) return;
    this.sigDirty = false;
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(this.sigFile(), JSON.stringify(this.sigStats));
  }

  /** Watchers for wallets on other chains. */
  private watchers: { stop(): void }[] = [];

  /** A swap seen by another chain's watcher (already decoded). */
  private onChainSwap(swap: Swap, gen: number) {
    if (!this.running || gen !== this.gen || this.seen.has(swap.signature)) return;
    this.remember(swap.signature);
    const age = swap.blockTime ? Date.now() / 1000 - swap.blockTime : 0;
    const c = getChain(swap);
    const amount = swap.nativeAmount != null ? `${swap.nativeAmount.toFixed(4)} ${c.meta.native.symbol} (≈ ${swap.quoteAmount.toFixed(3)} SOL)` : `${swap.quoteAmount.toFixed(2)} ${swap.quote}`;
    this.log(`${this.labels.get(swap.wallet) ?? short(swap.wallet)} ${swap.side === 'buy' ? 'bought' : 'sold'} ${short(swap.mint)} on ${c.meta.name} for ${amount} (${age.toFixed(1)}s ago)`, 'signal');
    if (age > this.cfg.risk.maxSignalAgeSec) return this.log('  skipped: signal too old', 'skip');
    this.enqueue(() => (swap.side === 'buy' ? this.onTargetBuy(swap) : this.onTargetSell(swap)));
  }

  private onTx(tx: RawTx, wallet: string) {
    const swap = this.chain.decodeSwap(tx, wallet);
    if (!swap) return;
    const age = swap.blockTime ? Date.now() / 1000 - swap.blockTime : 0;
    this.log(`${this.labels.get(wallet)} ${swap.side === 'buy' ? 'bought' : 'sold'} ${short(swap.mint)} for ${swap.quoteAmount.toFixed(3)} ${swap.quote} (${age.toFixed(1)}s ago)`, 'signal');
    if (age > this.cfg.risk.maxSignalAgeSec) return this.log('  skipped: signal too old', 'skip');
    this.enqueue(() => (swap.side === 'buy' ? this.onTargetBuy(swap) : this.onTargetSell(swap)));
  }

  /** Losing streak resets for the scanner when the user turns it back on. */
  scannerSince = Date.now();

  /** Limits every buy must fit: daily loss guard, open positions, total exposure, paper wallet. */
  private roomFor(mint: string, sol: number): string | null {
    const { cfg, state } = this;
    const r = cfg.risk;
    const blocked = buyBlockReason(this.guard, r, Date.now());
    if (blocked) return blocked;
    if (!state.positions[mint] && Object.keys(state.positions).length >= r.maxOpenPositions) return 'max open positions reached';
    if (exposure(state) + sol > r.maxTotalExposureSol) return 'max total exposure reached';
    if (cfg.mode === 'paper') {
      const free = paperFreeSol(cfg.paper.startSol, state.realizedPnlSol, exposure(state));
      if (free < sol) return `paper wallet has only ${Math.max(0, free).toFixed(3)} SOL left (reset it on the Dashboard)`;
    }
    return null;
  }

  /** Market filters, the holder check and the token safety check (route, honeypot, authorities). */
  /**
   * Market filters, holder check, rug memory and token safety (route, honeypot, authorities).
   * All lookups start at the same time (they don't depend on each other), then the answers are
   * checked in the usual order. This takes about as long as the slowest lookup instead of all of them added up.
   */
  private async tokenChecks(mint: string, sol: number, wantInfo: boolean, quiet = false, chain: ChainAdapter = this.chain): Promise<string | { info: MarketInfo | null; holders: HolderStats | null; check: Extract<CheckResult, { ok: true }> }> {
    const { cfg } = this;
    const f = cfg.filters;
    const started = Date.now();
    if (cfg.safety.rugMemory && this.rugs.mints.includes(mint)) return 'this coin rugged you before (rug memory)';
    const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }));
    const wantMarket = f.minLiquidityUsd > 0 || f.maxTradePctOfLiquidity > 0 || f.minMarketCapUsd > 0 || f.maxMarketCapUsd > 0 || f.minTokenAgeMin > 0;
    const wantHolders = chain.meta.id === 'solana' && (f.maxTopHolderPct > 0 || f.maxTop10HoldersPct > 0 || wantInfo) && hasSecret('SOLSCAN_API_KEY');
    const wantCreator = cfg.safety.rugMemory && this.rugs.creators.length > 0;
    const nativeRaw = await chain.solToNativeRaw(sol);
    const [market, solUsd, hold, check, creator] = await Promise.all([
      wantMarket ? settle(getMarketInfo(mint, chain.meta.dexscreenerId)) : null,
      wantMarket ? getSolUsd().catch(() => null) : null,
      wantHolders ? settle(this.cachedHolders(mint)) : null,
      chain.checkToken(this.ctx(), mint, nativeRaw).catch((e) => ({ ok: false as const, reason: (e as Error).message })),
      // Who made this coin? Only waited for briefly, so it never slows a buy by more than 1.5 s.
      wantCreator && chain.tokenCreator ? Promise.race([chain.tokenCreator(this.ctx(), mint).catch(() => null), sleep(1500).then(() => null)]) : null,
    ]);
    let info: MarketInfo | null = null;
    if (market) {
      if (market.ok) info = market.v;
      else if (f.skipIfNoMarketData) return `couldn't check market data (${market.e.message})`;
      else if (!quiet) this.log(`  note: couldn't check market data, continuing (${market.e.message})`, 'warn');
      const why = marketSkipReason(info, f, solUsd ? sol * solUsd : null, Date.now());
      if (why) return why;
    }
    let holders: HolderStats | null = null;
    if (hold) {
      if (hold.ok) holders = hold.v;
      else if (f.skipIfNoMarketData) return `couldn't check holders (${hold.e.message})`;
      else if (!quiet) this.log(`  note: couldn't check holders, continuing (${hold.e.message})`, 'warn');
      const why = holderSkipReason(holders, f);
      if (why) return why;
    }
    if (creator && this.rugs.creators.includes(creator)) return `made by ${short(creator)}, whose coin rugged you before (rug memory)`;
    if (!check.ok) return check.reason;
    this.lastCheckMs = Date.now() - started;
    return { info, holders, check };
  }
  /** How long the last full set of checks took (shown in the log, to see the speed-up). */
  lastCheckMs = 0;

  private holderCache = new Map<string, { at: number; h: HolderStats | null }>();
  private async cachedHolders(mint: string): Promise<HolderStats | null> {
    const hit = this.holderCache.get(mint);
    if (hit && Date.now() - hit.at < 3 * 60_000) return hit.h;
    const supply = await this.conn.getTokenSupply(new PublicKey(mint)).then((r) => BigInt(r.value.amount)).catch(() => null);
    const h = await getHolderStats(mint, supply);
    this.holderCache.set(mint, { at: Date.now(), h });
    if (this.holderCache.size > 300) this.holderCache.delete(this.holderCache.keys().next().value!);
    return h;
  }

  // ---------- rug memory ----------
  rugs: { mints: string[]; creators: string[] } = (() => {
    try {
      const j = JSON.parse(fs.readFileSync('data/rugs.json', 'utf8'));
      return { mints: Array.isArray(j.mints) ? j.mints.slice(-2000) : [], creators: Array.isArray(j.creators) ? j.creators.slice(-2000) : [] };
    } catch {
      return { mints: [], creators: [] };
    }
  })();
  private saveRugs() {
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync('data/rugs.json', JSON.stringify(this.rugs));
  }
  /** A coin rugged us: never buy it again, nor coins from whoever created it. */
  private rememberRug(mint: string, why: string) {
    if (!this.cfg.safety.rugMemory) return;
    if (!this.rugs.mints.includes(mint)) this.rugs.mints.push(mint);
    this.saveRugs();
    (this.chain.tokenCreator ? this.chain.tokenCreator(this.ctx(), mint) : Promise.resolve(null))
      .then((c) => {
        if (c && !this.rugs.creators.includes(c)) {
          this.rugs.creators.push(c);
          this.saveRugs();
          this.log(`Rug memory: won't buy ${short(mint)} again, nor other coins made by ${short(c)} (${why}).`, 'system');
        } else this.log(`Rug memory: won't buy ${short(mint)} again (${why}).`, 'system');
      })
      .catch(() => this.log(`Rug memory: won't buy ${short(mint)} again (${why}).`, 'system'));
  }

  // ---------- market mood ----------
  mood: Mood = { level: 'unknown', factor: 1, why: 'not checked yet' };
  private async moodLoop(gen: number) {
    while (gen === this.gen) {
      if (this.cfg.risk.moodFilter) {
        const [sol, pools] = await Promise.all([markets.solChange().catch(() => null), markets.scoutPools().catch(() => null)]);
        const next = moodFrom({ solH1Pct: sol?.h1 ?? null, solH24Pct: sol?.h24 ?? null, fallingShare: pools ? fallingShare(pools) : null });
        if (next.level !== this.mood.level && next.level !== 'unknown' && this.mood.level !== 'unknown') {
          this.log(next.level === 'bad' ? `Market mood is bad (${next.why}): no new buys from signals until it improves.` : next.level === 'cautious' ? `Market mood is cautious (${next.why}): buying at half size.` : `Market mood is back to normal (${next.why}).`, next.level === 'good' ? 'system' : 'warn');
        }
        this.mood = next;
        this.emit('status');
      }
      await sleep(3 * 60_000);
    }
  }

  // ---------- who bought what recently (for "wallets agree") ----------
  private recentBuys: RecentBuy[] = [];
  private records: { at: number; recs: Record<string, { closed: number; wins: number; pnlSol: number }>; gaps: Record<string, number> } | null = null;
  /** Each wallet's record with you and median copy gap, refreshed at most once a minute (cheap on every buy). */
  private walletEdges() {
    if (this.records && Date.now() - this.records.at < 60_000) return this.records;
    const trades = this.readTrades();
    const recs = walletRecords(trades, this.cfg.mode);
    const per: Record<string, number[]> = {};
    for (const t of trades as any[]) if (t.mode === this.cfg.mode && t.side === 'buy' && t.source && typeof t.gapPct === 'number') (per[t.source] ??= []).push(t.gapPct);
    const gaps: Record<string, number> = {};
    for (const [w, g] of Object.entries(per)) if (g.length >= 3) gaps[w] = [...g].sort((a, b) => a - b)[Math.floor(g.length / 2)];
    this.records = { at: Date.now(), recs, gaps };
    return this.records;
  }

  private async onTargetBuy(s: Swap) {
    const { cfg, state } = this;
    const r = cfg.risk;
    // Count every signal and why it was skipped (for the "ready for live?" report).
    const st = (this.sigStats[s.wallet] ??= { seen: 0, copied: 0, skips: {} });
    st.seen++;
    this.sigDirty = true;
    const skip = (why: string) => {
      const c = skipCategory(why);
      st.skips[c] = (st.skips[c] ?? 0) + 1;
      this.log(`  skipped: ${why}`, 'skip');
    };

    const now = Date.now();
    const b = cfg.buy;
    const chain = getChain(s);
    if (cfg.mode === 'live' && !chain.liveTrading) return skip(`${chain.meta.name} runs in paper mode only for now`);
    // Remember every buy we see (even ones we skip), to spot several wallets agreeing.
    this.recentBuys = [...this.recentBuys.filter((x) => now - x.t < 4 * 3_600_000), { mint: s.mint, wallet: s.wallet, t: now }].slice(-500);
    const agree = consensusWallets(this.recentBuys, s.mint, now, b.consensusWindowMin);

    const blocked = buyBlockReason(this.guard, r, now);
    if (blocked) return skip(blocked);
    const holding = state.positions[s.mint];
    // A second wallet confirming a coin we hold: buy more, once (if turned on).
    const addOn = !!holding && b.consensusAddOn && b.consensusBoost > 1 && agree.length >= 2 && !holding.addedOn && !holding.sources.includes(s.wallet);
    if (holding && r.skipIfAlreadyHolding && !addOn) return skip('already holding');
    if (!holding && Object.keys(state.positions).length >= r.maxOpenPositions) return skip('max open positions reached');
    const rules = walletRules(cfg, s.wallet);
    if (s.quote === 'SOL' && s.quoteAmount < rules.minTargetBuySol) return skip(`their buy is below ${rules.minTargetBuySol} SOL`);
    if (b.soloMinTheirSol > 0 && agree.length < 2 && s.quote === 'SOL' && s.quoteAmount < b.soloMinTheirSol) return skip(`only one wallet bought it, with less than ${b.soloMinTheirSol} SOL`);
    if (cfg.risk.moodFilter && this.mood.level === 'bad') return skip(`market mood is bad (${this.mood.why})`);

    // Size: base amount × this wallet's multiplier × the smart factors, then the min/max limits.
    const w = cfg.wallets.find((x) => x.address === s.wallet);
    let sol = b.sizing === 'percent' && s.quote === 'SOL' ? (s.quoteAmount * b.percentOfTarget) / 100 : b.fixedSol;
    if (w && !w.enabled) return skip(`${w.label} is paused${w.pausedReason ? ` (${w.pausedReason})` : ''}`);
    sol *= (w?.sizeMultiplier ?? 1) * trialFactor(w?.trialStage);
    const why: string[] = [];
    if (agree.length >= 2 && b.consensusBoost > 1) {
      sol *= b.consensusBoost;
      why.push(`×${b.consensusBoost}: ${agree.length} of your wallets bought it within ${b.consensusWindowMin} min`);
    }
    if (b.sizeByRecord) {
      const e = this.walletEdges();
      const rf = recordFactor(e.recs[s.wallet], e.gaps[s.wallet] ?? null);
      if (rf.factor !== 1) {
        sol *= rf.factor;
        why.push(`×${rf.factor}: ${rf.why}`);
      }
    }
    if (cfg.risk.moodFilter && this.mood.level === 'cautious') {
      sol *= this.mood.factor;
      why.push(`×${this.mood.factor}: market mood cautious (${this.mood.why})`);
    }
    sol = Math.min(b.maxSol, Math.max(b.minSol, sol));
    if (why.length) this.log(`  size ${sol.toFixed(3)} SOL (${why.join('; ')})`, 'info');
    if (exposure(state) + sol > r.maxTotalExposureSol) return skip('max total exposure reached');
    if (cfg.mode === 'paper') {
      const free = paperFreeSol(cfg.paper.startSol, state.realizedPnlSol, exposure(state));
      if (free < sol) return skip(`paper wallet has only ${Math.max(0, free).toFixed(3)} SOL left (reset it on the Dashboard)`);
    }
    if (w && w.maxExposureSol > 0) {
      const used = walletExposureSol(Object.values(state.positions), w.address);
      if (used + sol > w.maxExposureSol) return skip(`${w.label}'s budget is used up (${used.toFixed(3)} of ${w.maxExposureSol} SOL)`);
    }
    // Market filters, holders, rug memory and token safety, with the wallet balance check, all at once.
    const useAi = cfg.ai.enabled && cfg.ai.decideBuys;
    const [bal, checked] = await Promise.all([
      this.kp && cfg.mode === 'live' && chain.meta.id === 'solana' ? chain.balance(this.ctx(), this.kp.publicKey.toBase58()) : null,
      this.tokenChecks(s.mint, sol, useAi, false, chain),
    ]);
    if (bal != null && bal - sol < r.solReserve) return skip(`wallet balance ${bal.toFixed(3)} SOL too low`);
    if (typeof checked === 'string') return skip(checked);
    this.log(`  checks passed in ${(this.lastCheckMs / 1000).toFixed(1)} s`, 'info');
    let { info, check } = checked;
    const { holders } = checked;
    let lamports = BigInt(Math.round(sol * 1e9));

    // Don't chase: compare our price with what the copied wallet paid.
    const driftOf = (q: { outAmount: string }, lam: bigint) => (s.quote === 'SOL' ? priceDriftPct(s.quoteAmount, s.tokenAmount, lam, BigInt(q.outAmount)) : null);
    const maxDrift = rules.risk.maxPriceDriftPct;
    const chased = (drift: number | null) => (maxDrift > 0 && drift != null && drift > maxDrift ? `price is already ${drift.toFixed(0)}% above their entry (max ${maxDrift}%)` : null);
    let drift = driftOf(check.buyQuote, lamports);
    const chasing = chased(drift);
    if (chasing) return skip(chasing);

    // Autopilot: Claude decides buy/skip and the size, inside every limit checked above.
    if (useAi) {
      if (!info) info = await getMarketInfo(s.mint, chain.meta.dexscreenerId).catch(() => null);
      const label = w?.label ?? short(s.wallet);
      const record = walletRecords(this.readTrades(), cfg.mode)[s.wallet] ?? null;
      const g = this.guard;
      this.log(`  asking Claude…`, 'ai');
      const d = await ai.decideBuy(cfg, {
        mint: s.mint,
        symbol: info?.symbol ?? null,
        name: info?.name ?? null,
        wallet: { label, theirSol: s.quoteAmount, record },
        ourSol: sol,
        driftPct: drift,
        priceImpactPct: Number(check.buyQuote.priceImpactPct ?? NaN) * 100 || null,
        market: info && { liquidityUsd: info.liquidityUsd, marketCapUsd: info.marketCapUsd, ageMin: info.createdAt ? Math.round((Date.now() - info.createdAt) / 60_000) : null, volume24hUsd: info.volume24hUsd, change1hPct: info.change1hPct, buys1h: info.buys1h, sells1h: info.sells1h },
        holders: holders && { holderCount: holders.holderCount, largestWalletPct: +holders.largestPct.toFixed(2), top10WalletsPct: +holders.top10Pct.toFixed(1), largestIsTheCopiedWallet: holders.largestOwner === s.wallet },
        portfolio: { openPositions: Object.keys(state.positions).length, maxPositions: r.maxOpenPositions, exposureSol: exposure(state), maxExposureSol: r.maxTotalExposureSol, dayPnlSol: g.dayPnlSol },
        probe: { lamports: check.buyQuote.inAmount, tokensOut: check.buyQuote.outAmount, chain: chain.meta.id },
      });
      if (!this.running) return;
      if (!d) {
        this.log(`  Claude unavailable: ${ai.aiStatus(cfg).lastError ?? 'no answer'} Following the rules: buy.`, 'warn');
      } else {
        if (!d.buy) return this.log(`  skipped by Claude: ${d.reason}`, 'skip');
        this.log(`  Claude says buy${d.size !== 1 ? ` (size ×${d.size})` : ''}: ${d.reason}`, 'ai');
        // Resize within the limits, then re-check: the price may have moved while Claude thought.
        const resized = Math.min(cfg.buy.maxSol, Math.max(cfg.buy.minSol, sol * d.size));
        const cap = Math.min(r.maxTotalExposureSol - exposure(state), w && w.maxExposureSol > 0 ? w.maxExposureSol - walletExposureSol(Object.values(state.positions), w.address) : Infinity);
        sol = Math.min(resized, cap);
        if (sol < cfg.buy.minSol) return skip('no room left under your limits');
        lamports = BigInt(Math.round(sol * 1e9));
        const again = await chain.checkToken(this.ctx(), s.mint, await chain.solToNativeRaw(sol));
        if (!again.ok) return skip(again.reason);
        check = again;
        drift = driftOf(check.buyQuote, lamports);
        const late = chased(drift);
        if (late) return skip(late);
      }
    }
    await this.trader.buy(s.mint, s.decimals, check.buyQuote, s.wallet, s.quote === 'SOL' ? { theirSol: s.quoteAmount, theirRaw: s.tokenAmount, at: s.blockTime } : undefined, chain);
    st.copied++;
    if (addOn && state.positions[s.mint]) {
      state.positions[s.mint].addedOn = true;
      saveState(state, cfg.mode);
      this.log(`  bought more: ${agree.length} of your wallets now hold it`, 'info');
    }
  }

  /**
   * A coin the market scanner picked: buy it with the scanner's own size and budget, through the
   * same limits and safety checks as a copied buy. Returns why it wasn't bought, or null.
   */
  scannerBuy(sig: { mint: string; symbol: string; why: string }): Promise<string | null> {
    return new Promise((resolve) => {
      this.enqueue(async () => {
        const out = await this.scannerBuyNow(sig).catch((e) => (e as Error).message);
        if (out) this.log(`  skipped: ${out}`, 'skip');
        resolve(out);
      });
    });
  }

  private async scannerBuyNow(sig: { mint: string; symbol: string; why: string }): Promise<string | null> {
    const sc = this.cfg.scanner;
    if (!this.running || !sc.tradeCoins) return 'the scanner is off';
    this.log(`Market scanner: ${sig.symbol || short(sig.mint)} is ${sig.why}`, 'signal');
    if (this.state.positions[sig.mint]) return 'already holding';
    if (this.cfg.risk.moodFilter && this.mood.level === 'bad') return `market mood is bad (${this.mood.why})`;
    const positions = Object.values(this.state.positions);
    const mine = positions.filter((p) => p.sources.includes(SCANNER_SOURCE)).length;
    if (mine >= sc.maxPositions) return `the scanner already holds ${mine} coin${mine > 1 ? 's' : ''} (its maximum)`;
    const left = sc.budgetSol - walletExposureSol(positions, SCANNER_SOURCE);
    const sol = Math.min(sc.buySol, this.cfg.buy.maxSol, left);
    if (sol < Math.max(0.001, sc.buySol / 2)) return `the scanner's budget is used up (${(sc.budgetSol - left).toFixed(3)} of ${sc.budgetSol} SOL)`;
    const room = this.roomFor(sig.mint, sol);
    if (room) return room;
    if (this.kp && this.cfg.mode === 'live') {
      const bal = await this.chain.balance(this.ctx(), this.kp.publicKey.toBase58());
      if (bal - sol < this.cfg.risk.solReserve) return `wallet balance ${bal.toFixed(3)} SOL too low`;
    }
    const checked = await this.tokenChecks(sig.mint, sol, false);
    if (typeof checked === 'string') return checked;
    if (!this.running || !this.cfg.scanner.tradeCoins) return 'the scanner was turned off';
    await this.trader.buy(sig.mint, checked.check.decimals, checked.check.buyQuote, SCANNER_SOURCE);
    return null;
  }

  /** Our trade history (for per-wallet results). */
  readTrades(): ai.TradeRow[] {
    try {
      return fs.readFileSync('data/trades.jsonl', 'utf8').trim().split('\n').flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  // ---------- autopilot: position reviews + checking skipped buys ----------
  private lastReview = 0;
  aiBusy = false;

  private async aiLoop(gen: number) {
    while (gen === this.gen) {
      await sleep(60_000);
      if (gen !== this.gen) return;
      const a = this.cfg.ai;
      if (!a.enabled) continue;
      await this.checkSkippedOutcomes().catch((e) => this.logError(e));
      if (a.reviewPositions && Date.now() - this.lastReview >= a.reviewEveryMin * 60_000 && Object.keys(this.state.positions).length) {
        await this.reviewPositionsNow().catch((e) => this.logError(e));
      }
    }
  }

  /** Ask Claude about every open position; sells it recommends go through the normal sell path. */
  async reviewPositionsNow() {
    if (this.aiBusy) throw new Error('Claude is already reviewing.');
    const list = Object.values(this.state.positions);
    if (!list.length) throw new Error('No open positions to review.');
    this.aiBusy = true;
    this.lastReview = Date.now();
    try {
      await this.valuePositions();
      const view: ai.ReviewPosition[] = [];
      for (const p of list) {
        const v = this.values[p.mint];
        const info = await getMarketInfo(p.mint, getChain(p).meta.dexscreenerId).catch(() => null);
        view.push({
          mint: p.mint,
          symbol: info?.symbol ?? null,
          costSol: p.costSol,
          valueSol: v?.valueSol ?? null,
          pnlPct: v ? v.pnlPct : null,
          peakPct: p.peakMultiple ? (p.peakMultiple - 1) * 100 : null,
          heldMin: Math.round((Date.now() - p.openedAt) / 60_000),
          stepsTaken: p.steps ?? [],
          copiedFrom: p.sources.map((x) => this.labels.get(x) ?? short(x)),
          market: info && { liquidityUsd: info.liquidityUsd, marketCapUsd: info.marketCapUsd, ageMin: info.createdAt ? Math.round((Date.now() - info.createdAt) / 60_000) : null, volume24hUsd: info.volume24hUsd, change1hPct: info.change1hPct, buys1h: info.buys1h, sells1h: info.sells1h },
        });
      }
      this.log(`Claude is reviewing ${view.length} open position(s)…`, 'ai');
      const actions = await ai.reviewPositions(this.cfg, view);
      if (!actions) return this.log(`Claude review unavailable: ${ai.aiStatus(this.cfg).lastError ?? 'no answer'}`, 'warn');
      if (!actions.length) return this.log('Claude: hold everything for now.', 'ai');
      for (const act of actions) {
        if (this.exiting.has(act.mint) || !this.state.positions[act.mint]) continue;
        this.exiting.add(act.mint);
        this.enqueue(async () => {
          try {
            await this.trader.sell(act.mint, act.fraction, `Claude: ${act.reason}`);
          } finally {
            this.exiting.delete(act.mint);
          }
        });
      }
    } finally {
      this.aiBusy = false;
    }
  }

  /** For buys Claude skipped an hour ago: what would the same buy be worth now? */
  private async checkSkippedOutcomes() {
    for (const d of ai.pendingOutcomes().slice(0, 10)) {
      if (!d.probe || !d.mint) continue;
      const q = await getChain({ chain: d.probe.chain }).quoteBuy(d.mint, BigInt(d.probe.lamports), this.cfg.safety.slippageBps).catch(() => undefined);
      if (q === undefined) continue; // network trouble: try again next round
      // Fewer tokens for the same SOL = the price went up. No route at all usually means the token died.
      ai.setOutcome(d.id, q ? (Number(d.probe.tokensOut) / Number(q.outAmount) - 1) * 100 : -100);
    }
  }

  private async onTargetSell(s: Swap) {
    if (!this.cfg.sell.copySells) return;
    const p = this.state.positions[s.mint];
    if (!p || !p.sources.includes(s.wallet)) return;
    const fraction = s.tokenPost === 0n || s.tokenPre === 0n ? 1 : Number(s.tokenAmount) / Number(s.tokenPre);
    await this.trader.sell(s.mint, fraction, `copied ${this.labels.get(s.wallet)} selling ${(fraction * 100).toFixed(0)}%`, s.quote === 'SOL' ? { theirSol: s.quoteAmount, theirRaw: s.tokenAmount, at: s.blockTime } : undefined);
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

  private exiting = new Set<string>(); // mints with an exit already queued

  /** Values open positions and runs the exit plan: stop-loss, trailing stop, staged take-profits. */
  private async exitLoop(gen: number) {
    while (gen === this.gen) {
      await this.valuePositions();
      let changed = false;
      for (const p of Object.values(this.state.positions)) {
        const v = this.values[p.mint];
        if (!v || gen !== this.gen || this.exiting.has(p.mint)) continue;
        const plan = planExit(p, v.valueSol, exitConfigFor(this.cfg, p.sources));
        const { peakMultiple } = plan;
        let { action } = plan;
        // Scanner coins are quick trades: sell what's left once the hold limit is reached.
        if (!action && p.sources.length === 1 && p.sources[0] === SCANNER_SOURCE && overHeld(p.openedAt, Date.now(), this.cfg.scanner.maxHoldHours)) {
          action = { fraction: 1, reason: `held ${this.cfg.scanner.maxHoldHours} h (the scanner's limit)` };
        }
        if (peakMultiple !== p.peakMultiple) {
          p.peakMultiple = peakMultiple;
          changed = true;
        }
        if (!action) {
          const peakBefore = p.peakLiquidityUsd;
          const why = await this.checkDanger(p, v.valueSol).catch(() => null);
          if (p.peakLiquidityUsd !== peakBefore) changed = true;
          if (why && gen === this.gen && !this.exiting.has(p.mint)) {
            changed = true;
            this.log(`${short(p.mint)}: ${why}. Selling everything.`, 'warn');
            if (/liquidity fell|price fell/.test(why)) this.rememberRug(p.mint, why);
            this.exiting.add(p.mint);
            this.enqueue(async () => {
              try {
                await this.trader.sell(p.mint, 1, why);
              } finally {
                this.exiting.delete(p.mint);
              }
            });
          }
          continue;
        }
        this.exiting.add(p.mint);
        this.enqueue(async () => {
          try {
            const pnl = await this.trader.sell(p.mint, action.fraction, action.reason);
            const still = this.state.positions[p.mint];
            if (pnl !== null && action.step && still) {
              still.steps = [...(still.steps ?? []), action.step as ExitStep];
              saveState(this.state, this.cfg.mode);
            }
          } finally {
            this.exiting.delete(p.mint);
          }
        });
      }
      if (changed) saveState(this.state, this.cfg.mode);
      // Automatic panic: today's closed + open result past the user's limit.
      const unrealized = Object.values(this.state.positions).reduce((a, p) => a + (this.values[p.mint] ? this.values[p.mint].valueSol - p.costSol : 0), 0);
      const why = gen === this.gen && !this.panicking ? panicReason(this.guard.dayPnlSol, unrealized, this.cfg.risk.panicLossSol) : null;
      if (why) {
        this.panic(why).catch((e) => this.logError(e));
        return;
      }
      await sleep(this.cfg.monitor.exitCheckIntervalSec * 1000);
    }
  }

  /** Recent value samples per position, for the crash check. */
  private samples = new Map<string, [number, number][]>();

  /** Rug/dump protection: liquidity drain, fast crash, heavy selling. Updates the liquidity high. */
  private async checkDanger(p: import('./state').Position, valueSol: number): Promise<string | null> {
    const pr = this.cfg.protect;
    if (!pr.liquidityDropPct && !pr.crashPct && !pr.maxSellBuyRatio) return null;
    const now = Date.now();
    const s = (this.samples.get(p.mint) ?? []).filter(([t]) => now - t <= Math.max(pr.crashWindowMin, 1) * 60_000);
    const unit = perTokenValue(valueSol, p.amountRaw);
    s.push([now, unit]);
    this.samples.set(p.mint, s);
    const info = pr.liquidityDropPct || pr.maxSellBuyRatio ? await getMarketInfo(p.mint, getChain(p).meta.dexscreenerId).catch(() => null) : null;
    if (info?.liquidityUsd != null && info.liquidityUsd > (p.peakLiquidityUsd ?? 0)) p.peakLiquidityUsd = info.liquidityUsd;
    return dangerReason({ now, valueSol: unit, samples: s, liquidityUsd: info?.liquidityUsd ?? null, peakLiquidityUsd: p.peakLiquidityUsd ?? null, buys5m: info?.buys5m ?? null, sells5m: info?.sells5m ?? null }, pr);
  }

  async valuePositions() {
    for (const p of Object.values(this.state.positions)) {
      try {
        const q = await getChain(p).quoteSell(p.mint, BigInt(p.amountRaw), this.cfg.safety.slippageBps);
        if (!q) continue;
        const pc = getChain(p);
        const valueSol = await pc.nativeToSol(Number(q.outAmount) / 10 ** pc.meta.native.decimals);
        const now = Date.now();
        this.values[p.mint] = { valueSol, pnlPct: (valueSol / p.costSol - 1) * 100, at: now };
        // Live chart: value as a multiple of what it cost (1 = break-even).
        if (p.costSol > 0) p.trail = pushPoint(p.trail ?? [], [now, Math.round((valueSol / p.costSol) * 10_000) / 10_000], 300);
      } catch {
        /* ignore */
      }
    }
    if (Date.now() - this.trailSaved > 60_000 && Object.keys(this.state.positions).length) {
      this.trailSaved = Date.now();
      saveState(this.state, this.cfg.mode);
    }
    this.emit('status');
  }
  private trailSaved = 0;

  /** Live prices seen for orders' tokens (every 15 s while the bot runs), for the order charts. */
  orderPrices = new Map<string, Pt[]>();

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
      this.walletBalance = await this.chain.balance(this.ctx(), this.kp.publicKey.toBase58());
      this.emit('status');
    } catch {
      /* keep the last known balance */
    }
  }

  snapshot() {
    const positions = Object.values(this.state.positions).map((p) => ({ ...p, ...this.values[p.mint], trail: downsample(p.trail ?? [], 40), label: p.sources.map((s) => this.labels.get(s) ?? short(s)) }));
    const unrealized = positions.reduce((a, p) => a + (p.valueSol !== undefined ? p.valueSol - p.costSol : 0), 0);
    return {
      running: this.running,
      startedAt: this.startedAt,
      stream: !this.cfg.execution.fastStream ? null : !heliusWsUrl(rpcUrl()) ? 'needs a Helius RPC' : this.stream ? ({ connecting: 'connecting…', connected: 'on', unavailable: 'not on your Helius plan', reconnecting: 'reconnecting…', off: 'off' } as const)[this.stream.status] : 'starts with the bot',
      mode: this.cfg.mode,
      realizedPnlSol: this.state.realizedPnlSol,
      unrealizedPnlSol: unrealized,
      exposureSol: exposure(this.state),
      positions,
      paper: this.cfg.mode === 'paper' ? { startSol: this.cfg.paper.startSol, freeSol: paperFreeSol(this.cfg.paper.startSol, this.state.realizedPnlSol, exposure(this.state)) } : null,
      guard: { blocked: buyBlockReason(this.guard, this.cfg.risk, Date.now()), dayPnlSol: this.guard.dayPnlSol, lossStreak: this.guard.lossStreak },
      panicking: this.panicking,
      mood: this.cfg.risk.moodFilter ? this.mood : null,
      rugs: { coins: this.rugs.mints.length, creators: this.rugs.creators.length },
      orders: [...this.orders.filter((o) => o.status === 'active'), ...this.orders.filter((o) => o.status !== 'active').slice(-15).reverse()],
      wallet: this.kp ? { address: this.kp.publicKey.toBase58(), balance: this.walletBalance } : null,
    };
  }
}
