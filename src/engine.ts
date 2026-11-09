import { EventEmitter } from 'node:events';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Config, exitConfigFor, loadConfig, SCANNER_SOURCE, walletRules } from './config';
import { overHeld } from './scanner';
import { loadKeypair, makeConnection } from './env';
import { decodeSwap, Swap } from './decode';
import { quoteBuy, quoteSell } from './jupiter';
import { checkToken } from './safety';
import { exposure, loadState, saveState, State } from './state';
import { getHolderStats, HolderStats } from './solscan';
import { hasSecret, onRpcSwitch, rpcUrl } from './env';
import { FastStream, heliusWsUrl } from './stream';
import type { RawTx } from './util';
import { paperFreeSol, trialFactor, walletLifecycle } from './rules';
import { saveConfig } from './config';
import { panicReason } from './rules';
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
    this.labels = new Map([[SCANNER_SOURCE, 'Market scanner'], ...this.cfg.wallets.map((w) => [w.address, w.label] as [string, string])]);
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
    if (!wallets.length && !sc.tradeCoins && !sc.findTraders) throw new Error('Add at least one wallet to copy first, or turn on the Market scanner.');
    if (this.cfg.mode === 'live' && !this.kp) throw new Error(this.keyError ?? 'Live mode needs a trading wallet (Settings → Trading wallet).');

    const gen = ++this.gen;
    this.running = true;
    this.startedAt = Date.now();
    this.emit('status');
    const scanning = [sc.tradeCoins && 'trading coins', sc.findTraders && 'finding traders'].filter(Boolean).join(' and ');
    this.log(`Bot started in ${this.cfg.mode.toUpperCase()} mode, watching ${wallets.length} wallet(s)${scanning ? `; market scanner ${scanning}` : ''}`, 'system');

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
    this.aiLoop(gen);
    const wsu = this.cfg.execution.fastStream ? heliusWsUrl(rpcUrl()) : null;
    if (wsu && wallets.length) {
      this.stream = new FastStream(wsu, wallets.map((w) => w.address), (tx) => this.onStreamTx(tx), (s, detail) => {
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
    for (const id of this.subs) await this.conn.removeOnLogsListener(id).catch(() => {});
    this.subs = [];
    this.log('Bot stopped', 'system');
    this.emit('status');
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
      let sold = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const mint of Object.keys(this.state.positions)) {
          await this.enqueue(async () => {
            if (!this.state.positions[mint]) return;
            const pnl = await this.trader.sell(mint, 1, `panic: ${reason}`);
            if (pnl !== null) sold++;
          });
        }
        if (!Object.keys(this.state.positions).length) break;
        await sleep(3000);
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
      if (decodeSwap(tx, w.address)) {
        this.remember(tx.signature);
        this.onTx(tx, w.address);
        return;
      }
    }
  }

  private onTx(tx: RawTx, wallet: string) {
    const swap = decodeSwap(tx, wallet);
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
  private async tokenChecks(mint: string, sol: number, wantInfo: boolean, quiet = false): Promise<string | { info: MarketInfo | null; holders: HolderStats | null; check: Extract<Awaited<ReturnType<typeof checkToken>>, { ok: true }> }> {
    const { cfg } = this;
    const f = cfg.filters;
    let info: MarketInfo | null = null;
    if (f.minLiquidityUsd > 0 || f.maxTradePctOfLiquidity > 0 || f.minMarketCapUsd > 0 || f.maxMarketCapUsd > 0 || f.minTokenAgeMin > 0) {
      try {
        info = await getMarketInfo(mint);
      } catch (e) {
        if (f.skipIfNoMarketData) return `couldn't check market data (${(e as Error).message})`;
        if (!quiet) this.log(`  note: couldn't check market data, continuing (${(e as Error).message})`, 'warn');
      }
      const solUsd = await getSolUsd();
      const why = marketSkipReason(info, f, solUsd ? sol * solUsd : null, Date.now());
      if (why) return why;
    }
    // Holder check (Solscan): skip tokens a few wallets control.
    let holders: HolderStats | null = null;
    if ((f.maxTopHolderPct > 0 || f.maxTop10HoldersPct > 0 || wantInfo) && hasSecret('SOLSCAN_API_KEY')) {
      try {
        const supply = await this.conn.getTokenSupply(new PublicKey(mint)).then((r) => BigInt(r.value.amount)).catch(() => null);
        holders = await getHolderStats(mint, supply);
      } catch (e) {
        if (f.skipIfNoMarketData) return `couldn't check holders (${(e as Error).message})`;
        if (!quiet) this.log(`  note: couldn't check holders, continuing (${(e as Error).message})`, 'warn');
      }
      const why = holderSkipReason(holders, f);
      if (why) return why;
    }
    const check = await checkToken(this.conn, cfg, mint, BigInt(Math.round(sol * 1e9)));
    if (!check.ok) return check.reason;
    return { info, holders, check };
  }

  private async onTargetBuy(s: Swap) {
    const { cfg, state } = this;
    const r = cfg.risk;
    const skip = (why: string) => this.log(`  skipped: ${why}`, 'skip');

    const blocked = buyBlockReason(this.guard, r, Date.now());
    if (blocked) return skip(blocked);
    const holding = state.positions[s.mint];
    if (holding && r.skipIfAlreadyHolding) return skip('already holding');
    if (!holding && Object.keys(state.positions).length >= r.maxOpenPositions) return skip('max open positions reached');
    const rules = walletRules(cfg, s.wallet);
    if (s.quote === 'SOL' && s.quoteAmount < rules.minTargetBuySol) return skip(`their buy is below ${rules.minTargetBuySol} SOL`);

    // Size: base amount × this wallet's multiplier, then the min/max limits.
    const w = cfg.wallets.find((x) => x.address === s.wallet);
    let sol = cfg.buy.sizing === 'percent' && s.quote === 'SOL' ? (s.quoteAmount * cfg.buy.percentOfTarget) / 100 : cfg.buy.fixedSol;
    if (w && !w.enabled) return skip(`${w.label} is paused${w.pausedReason ? ` (${w.pausedReason})` : ''}`);
    sol *= (w?.sizeMultiplier ?? 1) * trialFactor(w?.trialStage);
    sol = Math.min(cfg.buy.maxSol, Math.max(cfg.buy.minSol, sol));
    if (exposure(state) + sol > r.maxTotalExposureSol) return skip('max total exposure reached');
    if (cfg.mode === 'paper') {
      const free = paperFreeSol(cfg.paper.startSol, state.realizedPnlSol, exposure(state));
      if (free < sol) return skip(`paper wallet has only ${Math.max(0, free).toFixed(3)} SOL left (reset it on the Dashboard)`);
    }
    if (w && w.maxExposureSol > 0) {
      const used = walletExposureSol(Object.values(state.positions), w.address);
      if (used + sol > w.maxExposureSol) return skip(`${w.label}'s budget is used up (${used.toFixed(3)} of ${w.maxExposureSol} SOL)`);
    }
    if (this.kp && cfg.mode === 'live') {
      const bal = (await this.conn.getBalance(this.kp.publicKey)) / 1e9;
      if (bal - sol < r.solReserve) return skip(`wallet balance ${bal.toFixed(3)} SOL too low`);
    }

    // Market filters (liquidity, trade size vs pool, market cap, token age), holders, token safety.
    const useAi = cfg.ai.enabled && cfg.ai.decideBuys;
    const checked = await this.tokenChecks(s.mint, sol, useAi);
    if (typeof checked === 'string') return skip(checked);
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
      if (!info) info = await getMarketInfo(s.mint).catch(() => null);
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
        probe: { lamports: lamports.toString(), tokensOut: check.buyQuote.outAmount },
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
        const again = await checkToken(this.conn, cfg, s.mint, lamports);
        if (!again.ok) return skip(again.reason);
        check = again;
        drift = driftOf(check.buyQuote, lamports);
        const late = chased(drift);
        if (late) return skip(late);
      }
    }
    await this.trader.buy(s.mint, s.decimals, check.buyQuote, s.wallet, s.quote === 'SOL' ? { theirSol: s.quoteAmount, theirRaw: s.tokenAmount, at: s.blockTime } : undefined);
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
    const positions = Object.values(this.state.positions);
    const mine = positions.filter((p) => p.sources.includes(SCANNER_SOURCE)).length;
    if (mine >= sc.maxPositions) return `the scanner already holds ${mine} coin${mine > 1 ? 's' : ''} (its maximum)`;
    const left = sc.budgetSol - walletExposureSol(positions, SCANNER_SOURCE);
    const sol = Math.min(sc.buySol, this.cfg.buy.maxSol, left);
    if (sol < Math.max(0.001, sc.buySol / 2)) return `the scanner's budget is used up (${(sc.budgetSol - left).toFixed(3)} of ${sc.budgetSol} SOL)`;
    const room = this.roomFor(sig.mint, sol);
    if (room) return room;
    if (this.kp && this.cfg.mode === 'live') {
      const bal = (await this.conn.getBalance(this.kp.publicKey)) / 1e9;
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
        const info = await getMarketInfo(p.mint).catch(() => null);
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
      const q = await quoteBuy(d.mint, BigInt(d.probe.lamports), this.cfg.safety.slippageBps).catch(() => undefined);
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
    s.push([now, valueSol]);
    this.samples.set(p.mint, s);
    const info = pr.liquidityDropPct || pr.maxSellBuyRatio ? await getMarketInfo(p.mint).catch(() => null) : null;
    if (info?.liquidityUsd != null && info.liquidityUsd > (p.peakLiquidityUsd ?? 0)) p.peakLiquidityUsd = info.liquidityUsd;
    return dangerReason({ now, valueSol, samples: s, liquidityUsd: info?.liquidityUsd ?? null, peakLiquidityUsd: p.peakLiquidityUsd ?? null, buys5m: info?.buys5m ?? null, sells5m: info?.sells5m ?? null }, pr);
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
      stream: !this.cfg.execution.fastStream ? null : !heliusWsUrl(rpcUrl()) ? 'needs a Helius RPC' : this.stream ? ({ connecting: 'connecting…', connected: 'on', unavailable: 'not on your Helius plan', reconnecting: 'reconnecting…', off: 'off' } as const)[this.stream.status] : 'starts with the bot',
      mode: this.cfg.mode,
      realizedPnlSol: this.state.realizedPnlSol,
      unrealizedPnlSol: unrealized,
      exposureSol: exposure(this.state),
      positions,
      paper: this.cfg.mode === 'paper' ? { startSol: this.cfg.paper.startSol, freeSol: paperFreeSol(this.cfg.paper.startSol, this.state.realizedPnlSol, exposure(this.state)) } : null,
      guard: { blocked: buyBlockReason(this.guard, this.cfg.risk, Date.now()), dayPnlSol: this.guard.dayPnlSol, lossStreak: this.guard.lossStreak },
      panicking: this.panicking,
      wallet: this.kp ? { address: this.kp.publicKey.toBase58(), balance: this.walletBalance } : null,
    };
  }
}
