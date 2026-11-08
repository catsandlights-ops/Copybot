import { EventEmitter } from 'node:events';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Config, loadConfig } from './config';
import { loadKeypair, makeConnection } from './env';
import { decodeSwap, Swap } from './decode';
import { quoteBuy, quoteSell } from './jupiter';
import { checkToken } from './safety';
import { exposure, loadState, saveState, State } from './state';
import { getHolderStats, HolderStats } from './solscan';
import { hasSecret } from './env';
import { buyBlockReason, holderSkipReason, ExitStep, freshGuard, GuardState, localDay, MarketInfo, marketSkipReason, planExit, priceDriftPct, recordSell, rollDay, walletExposureSol, walletRecords } from './rules';
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
        if (t.side === 'sell' && typeof t.pnl === 'number') this.afterSell(t.pnl);
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

  private enqueue(fn: () => Promise<unknown>) {
    this.queue = this.queue.then(fn).then(() => {}).catch((e) => this.logError(e));
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
    this.aiLoop(gen);
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

  // ---------- circuit breaker ----------
  private get guard(): GuardState {
    return rollDay(this.state.guard ?? freshGuard(Date.now()), Date.now());
  }

  private afterSell(pnl: number) {
    const { guard, event } = recordSell(this.guard, pnl, this.cfg.risk, Date.now());
    this.state.guard = guard;
    saveState(this.state, this.cfg.mode);
    if (event) this.log(event, 'warn');
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

    const blocked = buyBlockReason(this.guard, r, Date.now());
    if (blocked) return skip(blocked);
    const holding = state.positions[s.mint];
    if (holding && r.skipIfAlreadyHolding) return skip('already holding');
    if (!holding && Object.keys(state.positions).length >= r.maxOpenPositions) return skip('max open positions reached');
    if (s.quote === 'SOL' && s.quoteAmount < cfg.buy.minTargetBuySol) return skip(`their buy is below ${cfg.buy.minTargetBuySol} SOL`);

    // Size: base amount × this wallet's multiplier, then the min/max limits.
    const w = cfg.wallets.find((x) => x.address === s.wallet);
    let sol = cfg.buy.sizing === 'percent' && s.quote === 'SOL' ? (s.quoteAmount * cfg.buy.percentOfTarget) / 100 : cfg.buy.fixedSol;
    sol *= w?.sizeMultiplier ?? 1;
    sol = Math.min(cfg.buy.maxSol, Math.max(cfg.buy.minSol, sol));
    if (exposure(state) + sol > r.maxTotalExposureSol) return skip('max total exposure reached');
    if (w && w.maxExposureSol > 0) {
      const used = walletExposureSol(Object.values(state.positions), w.address);
      if (used + sol > w.maxExposureSol) return skip(`${w.label}'s budget is used up (${used.toFixed(3)} of ${w.maxExposureSol} SOL)`);
    }
    if (this.kp && cfg.mode === 'live') {
      const bal = (await this.conn.getBalance(this.kp.publicKey)) / 1e9;
      if (bal - sol < r.solReserve) return skip(`wallet balance ${bal.toFixed(3)} SOL too low`);
    }

    // Market filters: liquidity, trade size vs pool, market cap, token age.
    const f = cfg.filters;
    const useAi = cfg.ai.enabled && cfg.ai.decideBuys;
    let info: MarketInfo | null = null;
    if (f.minLiquidityUsd > 0 || f.maxTradePctOfLiquidity > 0 || f.minMarketCapUsd > 0 || f.maxMarketCapUsd > 0 || f.minTokenAgeMin > 0) {
      try {
        info = await getMarketInfo(s.mint);
      } catch (e) {
        if (f.skipIfNoMarketData) return skip(`couldn't check market data (${(e as Error).message})`);
        this.log(`  note: couldn't check market data, continuing (${(e as Error).message})`, 'warn');
      }
      const solUsd = await getSolUsd();
      const why = marketSkipReason(info, f, solUsd ? sol * solUsd : null, Date.now());
      if (why) return skip(why);
    }

    // Holder check (Solscan): skip tokens a few wallets control.
    let holders: HolderStats | null = null;
    if ((f.maxTopHolderPct > 0 || f.maxTop10HoldersPct > 0 || useAi) && hasSecret('SOLSCAN_API_KEY')) {
      try {
        const supply = await this.conn.getTokenSupply(new PublicKey(s.mint)).then((r) => BigInt(r.value.amount)).catch(() => null);
        holders = await getHolderStats(s.mint, supply);
      } catch (e) {
        if (f.skipIfNoMarketData) return skip(`couldn't check holders (${(e as Error).message})`);
        this.log(`  note: couldn't check holders, continuing (${(e as Error).message})`, 'warn');
      }
      const why = holderSkipReason(holders, f);
      if (why) return skip(why);
    }

    let lamports = BigInt(Math.round(sol * 1e9));
    let check = await checkToken(this.conn, cfg, s.mint, lamports);
    if (!check.ok) return skip(check.reason);

    // Don't chase: compare our price with what the copied wallet paid.
    const driftOf = (q: { outAmount: string }, lam: bigint) => (s.quote === 'SOL' ? priceDriftPct(s.quoteAmount, s.tokenAmount, lam, BigInt(q.outAmount)) : null);
    const chased = (drift: number | null) => (r.maxPriceDriftPct > 0 && drift != null && drift > r.maxPriceDriftPct ? `price is already ${drift.toFixed(0)}% above their entry (max ${r.maxPriceDriftPct}%)` : null);
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
        check = await checkToken(this.conn, cfg, s.mint, lamports);
        if (!check.ok) return skip(check.reason);
        drift = driftOf(check.buyQuote, lamports);
        const late = chased(drift);
        if (late) return skip(late);
      }
    }
    await this.trader.buy(s.mint, s.decimals, check.buyQuote, s.wallet);
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

  private exiting = new Set<string>(); // mints with an exit already queued

  /** Values open positions and runs the exit plan: stop-loss, trailing stop, staged take-profits. */
  private async exitLoop(gen: number) {
    while (gen === this.gen) {
      await this.valuePositions();
      let changed = false;
      for (const p of Object.values(this.state.positions)) {
        const v = this.values[p.mint];
        if (!v || gen !== this.gen || this.exiting.has(p.mint)) continue;
        const { action, peakMultiple } = planExit(p, v.valueSol, this.cfg);
        if (peakMultiple !== p.peakMultiple) {
          p.peakMultiple = peakMultiple;
          changed = true;
        }
        if (!action) continue;
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
      guard: { blocked: buyBlockReason(this.guard, this.cfg.risk, Date.now()), dayPnlSol: this.guard.dayPnlSol, lossStreak: this.guard.lossStreak },
      wallet: this.kp ? { address: this.kp.publicKey.toBase58(), balance: this.walletBalance } : null,
    };
  }
}
