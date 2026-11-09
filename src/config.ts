import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { strategyById } from './presets';
import { DEFAULT_CHAIN, KNOWN_CHAINS } from './chains/types';

/** sizeMultiplier scales every buy copied from this wallet; maxExposureSol caps SOL in its positions (0 = no cap). */
export type ExitOverrides = Partial<{
  stopLossPct: number;
  recoverCostAtPct: number;
  tp1AtPct: number;
  tp1SellPct: number;
  tp2AtPct: number;
  tp2SellPct: number;
  trailingAfterPct: number;
  trailingStopPct: number;
}>;
/** `exits` overrides the global exit settings for positions copied from this wallet. */
/**
 * trialStage: 0 = quarter size, 1 = half size, absent = full size (new wallets start on trial).
 * since: when the current trial stage, or the wallet's last resume, began (results before it don't count).
 */
export type WalletCfg = {
  chain?: import('./chains/types').ChainId; // which blockchain this wallet trades on (missing = Solana)
  address: string;
  label: string;
  enabled: boolean;
  sizeMultiplier: number;
  maxExposureSol: number;
  exits?: ExitOverrides;
  strategy?: string; // a ready-made strategy just for this wallet (its exit overrides still win)
  trialStage?: 0 | 1;
  since?: number;
  pausedReason?: string;
};
const EXIT_KEYS: Record<keyof Required<ExitOverrides>, string> = {
  stopLossPct: 'risk.stopLossPct',
  recoverCostAtPct: 'exits.recoverCostAtPct',
  tp1AtPct: 'exits.tp1AtPct',
  tp1SellPct: 'exits.tp1SellPct',
  tp2AtPct: 'exits.tp2AtPct',
  tp2SellPct: 'exits.tp2SellPct',
  trailingAfterPct: 'exits.trailingAfterPct',
  trailingStopPct: 'exits.trailingStopPct',
};

/**
 * The rules for one wallet: global settings, then the wallet's own strategy (its exits, stop-loss,
 * minimum buy size and "don't chase"), then the wallet's own exit overrides.
 */
/** Positions the market scanner opened (not copied from a wallet) carry this as their source. */
export const SCANNER_SOURCE = 'scanner';
/** Positions bought by the user's own limit and DCA orders. */
export const ORDER_SOURCE = 'order';

/** The scanner's own quick exits: stop-loss, take-profit, and a trailing stop once it's up. */
export function scannerRules(cfg: Pick<Config, 'risk' | 'exits'> & { scanner?: Config['scanner'] }): { risk: Config['risk']; exits: Config['exits'] } {
  const s = cfg.scanner ?? DEFAULT_CONFIG.scanner;
  return {
    risk: { ...cfg.risk, stopLossPct: s.stopLossPct, takeProfitPct: s.takeProfitPct },
    exits: { recoverCostAtPct: 0, tp1AtPct: 0, tp1SellPct: 50, tp2AtPct: 0, tp2SellPct: 50, trailingAfterPct: s.trailingAfterPct, trailingStopPct: s.trailingStopPct },
  };
}

export function walletRules(cfg: Pick<Config, 'risk' | 'exits' | 'wallets' | 'buy'> & { scanner?: Config['scanner'] }, address: string | undefined): { risk: Config['risk']; exits: Config['exits']; minTargetBuySol: number } {
  if (address === SCANNER_SOURCE) return { ...scannerRules(cfg), minTargetBuySol: 0 };
  const w = cfg.wallets.find((x) => x.address === address);
  let risk = cfg.risk;
  let exits = cfg.exits;
  let minTargetBuySol = cfg.buy.minTargetBuySol;
  const s = w?.strategy ? strategyById(w.strategy) : null;
  if (s) {
    risk = { ...risk, ...s.patch.risk };
    exits = { ...exits, ...s.patch.exits };
    if (s.patch.buy?.minTargetBuySol !== undefined) minTargetBuySol = s.patch.buy.minTargetBuySol;
  }
  const o = w?.exits;
  if (o && Object.keys(o).length) {
    const { stopLossPct, ...ex } = o;
    if (stopLossPct !== undefined) risk = { ...risk, stopLossPct };
    exits = { ...exits, ...ex };
  }
  return { risk, exits, minTargetBuySol };
}

/** Exit settings for a position: those of the wallet that opened it (see walletRules). */
export function exitConfigFor(cfg: Pick<Config, 'risk' | 'exits' | 'wallets'> & Partial<Pick<Config, 'buy' | 'scanner'>>, sources: string[]): Pick<Config, 'risk' | 'exits'> {
  const r = walletRules({ ...cfg, buy: cfg.buy ?? ({ minTargetBuySol: 0 } as Config['buy']) }, sources[0]);
  return { risk: r.risk, exits: r.exits };
}

export type Config = {
  mode: 'paper' | 'live';
  wallets: WalletCfg[];
  buy: {
    sizing: 'fixed' | 'percent';
    fixedSol: number;
    percentOfTarget: number;
    minSol: number;
    maxSol: number;
    minTargetBuySol: number;
    consensusBoost: number; // size × when 2+ copied wallets buy the same coin (1 = off)
    consensusWindowMin: number;
    consensusAddOn: boolean; // buy more of a coin you hold when a second wallet confirms it (once)
    soloMinTheirSol: number; // skip a coin only one wallet bought, if they spent less than this (0 = off)
    sizeByRecord: boolean; // bigger buys for wallets that make you money, smaller for losers / late copies
  };
  sell: { copySells: boolean };
  risk: {
    maxOpenPositions: number;
    maxTotalExposureSol: number;
    stopLossPct: number;
    takeProfitPct: number;
    skipIfAlreadyHolding: boolean;
    maxSignalAgeSec: number;
    solReserve: number;
    maxPriceDriftPct: number; // don't chase: skip if our price is this much above the copied wallet's entry (0 = off)
    panicLossSol: number;
    moodFilter: boolean; // buy less (or nothing) from signals when SOL is dropping or most coins are falling // sell everything and stop when today's closed + open result reaches −this (0 = off)
    dailyLossLimitSol: number; // stop new buys for the day after losing this much (0 = off)
    pauseAfterLosses: number; // pause new buys after this many losing sells in a row (0 = off)
    pauseMinutes: number;
  };
  /** Staged exits. Percentages are gains over our entry price (100 = 2x). 0 turns a step off. */
  exits: {
    recoverCostAtPct: number; // sell enough to get the original SOL back
    tp1AtPct: number;
    tp1SellPct: number; // % of what's left
    tp2AtPct: number;
    tp2SellPct: number;
    trailingAfterPct: number; // trailing stop arms once the position has been up this much
    trailingStopPct: number; // then sells everything if it falls this much from its peak
  };
  /** Rug and dump protection for open positions. 0 turns a check off. */
  protect: {
    liquidityDropPct: number; // sell if the pool's liquidity falls this much from its high since we bought
    crashPct: number; // sell if the position loses this much within crashWindowMin
    crashWindowMin: number;
    maxSellBuyRatio: number; // sell if sells outnumber buys this many times over in the last 5 minutes (20+ sells)
  };
  /** Market-data filters (Dexscreener). 0 turns a filter off. */
  filters: {
    minLiquidityUsd: number;
    maxTradePctOfLiquidity: number;
    minMarketCapUsd: number;
    maxMarketCapUsd: number;
    minTokenAgeMin: number;
    skipIfNoMarketData: boolean;
    maxTopHolderPct: number; // Solscan holder check: skip if one wallet owns more than this % (0 = off)
    maxTop10HoldersPct: number; // ...or the 10 largest wallets together own more than this %
  };
  safety: {
    slippageBps: number;
    maxRoundTripLossPct: number;
    rejectFreezeAuthority: boolean;
    rejectMintAuthority: boolean;
    rejectToken2022: boolean;
    blacklist: string[];
    rugMemory: boolean; // after a rug pull, never buy that coin again, nor coins from the same creator
  };
  execution: {
    priorityLevel: 'medium' | 'high' | 'veryHigh';
    priorityFeeMaxLamports: number;
    jitoTipLamports: number; // 0 = off; otherwise pay this Jito tip instead of a priority fee
    fastStream: boolean; // Helius enhanced websocket for faster signals (needs a Helius RPC)
    dynamicSlippage: boolean; // live: let Jupiter set the slippage per trade (never above your max)
    mevProtect: boolean; // live, with a Jito tip: send privately through Jito only (no front-running)
    baseLive: boolean; // allow real trades on Base (needs a Base trading key); off = Base stays paper-only
    baseMaxFeeEth: number; // most a single Base transaction may pay in network fees
  };
  /** Weekly check of your exit settings against the last 7 days; suggests better ones. */
  tune: { weekly: boolean };
  monitor: { pollIntervalSec: number; exitCheckIntervalSec: number };
  /** New wallets start small and grow as they prove themselves; any wallet pauses after a losing streak. */
  trial: { enabled: boolean; winsToStepUp: number; pauseAfterLosses: number };
  /** Paper mode: a pretend wallet so experiments feel real (buys stop when it runs out). */
  paper: { startSol: number };
  /** The ready-made strategy last applied ('' = none); the UI shows "modified" once settings differ. */
  strategy: string;
  /** Which events are sent to Telegram/Discord (when a channel is set up in Settings → Alerts). */
  alerts: { trades: boolean; errors: boolean; guard: boolean; autopilot: boolean };
  /**
   * Market scanner, while the bot runs. findTraders: keep looking at new and older coins for
   * winning traders, backtest them and add the best on a trial. tradeCoins: buy rising coins on
   * its own, with its own budget and quick exits, through every safety check.
   */
  scanner: {
    findTraders: boolean;
    traderEveryHours: number;
    maxWallets: number; // stop adding once this many wallets are being copied
    picksPerRun: number;
    tradeCoins: boolean;
    rules: 'normal' | 'strict' | 'loose'; // entry rules: the defaults, pickier, or looser
    trackSignals: boolean; // while the bot runs, note every coin signal and check later how it did (no buying)
    newCoins: boolean; // 1 hour to 7 days old
    oldCoins: boolean; // over 7 days old
    baseCoins: boolean; // also scan coins on Base (paper mode only for now)
    buySol: number;
    budgetSol: number; // most SOL in scanner positions at once
    maxPositions: number;
    stopLossPct: number;
    takeProfitPct: number;
    trailingAfterPct: number;
    trailingStopPct: number;
    maxHoldHours: number; // sell whatever is left after this long (0 = never)
  };
  /** Claude autopilot. Off until the user turns it on and adds an Anthropic API key. */
  ai: {
    enabled: boolean;
    decideBuys: boolean;
    reviewPositions: boolean;
    reviewEveryMin: number;
    manageWallets: boolean;
    walletReviewHours: number;
    maxWallets: number;
    scoutEveryHours: number; // wallet scout: search for new wallets this often (0 = only when asked)
    scoutMaxPicks: number; // most new wallets added per scout run
    dailyBudgetUsd: number;
    guidance: string; // the user's own instructions for Claude
  };
};

export const DEFAULT_CONFIG: Config = {
  mode: 'paper',
  wallets: [],
  buy: { sizing: 'fixed', fixedSol: 0.05, percentOfTarget: 5, minSol: 0.01, maxSol: 0.2, minTargetBuySol: 0.2, consensusBoost: 1.5, consensusWindowMin: 10, consensusAddOn: true, soloMinTheirSol: 0, sizeByRecord: true },
  sell: { copySells: true },
  risk: {
    maxOpenPositions: 5,
    maxTotalExposureSol: 1,
    stopLossPct: 40,
    takeProfitPct: 0,
    skipIfAlreadyHolding: true,
    maxSignalAgeSec: 30,
    solReserve: 0.05,
    maxPriceDriftPct: 15,
    dailyLossLimitSol: 0.3,
    panicLossSol: 0,
    moodFilter: true,
    pauseAfterLosses: 4,
    pauseMinutes: 60,
  },
  exits: { recoverCostAtPct: 100, tp1AtPct: 300, tp1SellPct: 50, tp2AtPct: 900, tp2SellPct: 50, trailingAfterPct: 50, trailingStopPct: 30 },
  protect: { liquidityDropPct: 50, crashPct: 35, crashWindowMin: 5, maxSellBuyRatio: 3 },
  filters: { minLiquidityUsd: 10_000, maxTradePctOfLiquidity: 2, minMarketCapUsd: 0, maxMarketCapUsd: 0, minTokenAgeMin: 0, skipIfNoMarketData: false, maxTopHolderPct: 15, maxTop10HoldersPct: 50 },
  safety: {
    slippageBps: 300,
    maxRoundTripLossPct: 12,
    rejectFreezeAuthority: true,
    rejectMintAuthority: false,
    rejectToken2022: false,
    blacklist: [],
    rugMemory: true,
  },
  execution: { priorityLevel: 'veryHigh', priorityFeeMaxLamports: 1_000_000, jitoTipLamports: 0, fastStream: true, dynamicSlippage: true, mevProtect: false, baseLive: false, baseMaxFeeEth: 0.002 },
  tune: { weekly: true },
  monitor: { pollIntervalSec: 4, exitCheckIntervalSec: 20 },
  trial: { enabled: true, winsToStepUp: 3, pauseAfterLosses: 5 },
  strategy: '',
  paper: { startSol: 10 },
  alerts: { trades: true, errors: true, guard: true, autopilot: true },
  scanner: { findTraders: false, traderEveryHours: 6, maxWallets: 8, picksPerRun: 2, tradeCoins: false, rules: 'normal', trackSignals: true, newCoins: true, oldCoins: true, baseCoins: false, buySol: 0.05, budgetSol: 0.3, maxPositions: 3, stopLossPct: 20, takeProfitPct: 50, trailingAfterPct: 15, trailingStopPct: 12, maxHoldHours: 12 },
  ai: { enabled: false, decideBuys: true, reviewPositions: true, reviewEveryMin: 15, manageWallets: true, walletReviewHours: 24, maxWallets: 8, scoutEveryHours: 24, scoutMaxPicks: 2, dailyBudgetUsd: 3, guidance: '' },
};

/** Allowed range for every numeric setting: [min, max, human name]. */
const NUMBERS: Record<string, [number, number, string, ((v: number) => string)?]> = {
  'buy.fixedSol': [0.001, 100, 'Amount per buy'],
  'buy.percentOfTarget': [0.1, 100, 'Percent of their buy'],
  'buy.minSol': [0.001, 100, 'Smallest buy'],
  'buy.maxSol': [0.001, 100, 'Largest buy'],
  'buy.minTargetBuySol': [0, 10_000, 'Ignore their buys under'],
  'buy.consensusBoost': [1, 3, 'Size when wallets agree'],
  'execution.baseMaxFeeEth': [0.0001, 0.05, 'Max Base fee per transaction'],
  'buy.consensusWindowMin': [1, 240, 'Agreement window'],
  'buy.soloMinTheirSol': [0, 10_000, 'Single-wallet minimum'],
  'risk.maxOpenPositions': [1, 100, 'Max tokens held at once'],
  'risk.maxTotalExposureSol': [0.001, 10_000, 'Max SOL in open positions'],
  'risk.stopLossPct': [1, 100, 'Stop-loss'],
  'risk.panicLossSol': [0, 10_000, 'Panic limit'],
  'risk.takeProfitPct': [0, 100_000, 'Sell everything at'],
  'risk.maxSignalAgeSec': [1, 600, 'Ignore trades older than'],
  'risk.solReserve': [0, 100, 'Always keep in wallet'],
  'risk.maxPriceDriftPct': [0, 1_000, "Don't chase"],
  'risk.dailyLossLimitSol': [0, 10_000, 'Daily loss limit'],
  'risk.pauseAfterLosses': [0, 50, 'Pause after losses in a row'],
  'risk.pauseMinutes': [1, 10_080, 'Pause length'],
  'exits.recoverCostAtPct': [0, 100_000, 'Take back my cost at'],
  'exits.tp1AtPct': [0, 100_000, 'Take-profit 1 at'],
  'exits.tp1SellPct': [1, 100, 'Take-profit 1 sell amount'],
  'exits.tp2AtPct': [0, 100_000, 'Take-profit 2 at'],
  'exits.tp2SellPct': [1, 100, 'Take-profit 2 sell amount'],
  'exits.trailingAfterPct': [0, 100_000, 'Arm trailing stop after'],
  'exits.trailingStopPct': [0, 99, 'Trailing stop'],
  'protect.liquidityDropPct': [0, 99, 'Liquidity drain limit'],
  'protect.crashPct': [0, 99, 'Crash limit'],
  'protect.crashWindowMin': [1, 60, 'Crash window'],
  'protect.maxSellBuyRatio': [0, 100, 'Sell pressure limit'],
  'filters.minLiquidityUsd': [0, 1e10, 'Minimum liquidity'],
  'filters.maxTradePctOfLiquidity': [0, 100, 'Max trade size vs liquidity'],
  'filters.minMarketCapUsd': [0, 1e13, 'Minimum market cap'],
  'filters.maxMarketCapUsd': [0, 1e13, 'Maximum market cap'],
  'filters.minTokenAgeMin': [0, 525_600, 'Minimum token age'],
  'filters.maxTopHolderPct': [0, 100, 'Largest holder limit'],
  'filters.maxTop10HoldersPct': [0, 100, 'Top 10 holders limit'],
  'safety.slippageBps': [10, 5_000, 'Max slippage', (v) => `${v / 100}%`],
  'safety.maxRoundTripLossPct': [0.1, 100, 'Max buy-then-sell loss'],
  'execution.priorityFeeMaxLamports': [0, 50_000_000, 'Max priority fee', (v) => `${v / 1e9} SOL`],
  'execution.jitoTipLamports': [0, 10_000_000, 'Jito tip', (v) => `${v / 1e9} SOL`],
  'monitor.pollIntervalSec': [1, 300, 'Backup check interval'],
  'monitor.exitCheckIntervalSec': [5, 3_600, 'Stop-loss check interval'],
  'paper.startSol': [0.1, 100_000, 'Paper wallet start'],
  'trial.winsToStepUp': [1, 50, 'Profitable copies to step up'],
  'trial.pauseAfterLosses': [0, 50, 'Pause a wallet after losses in a row'],
  'scanner.traderEveryHours': [1, 168, 'Look for traders every'],
  'scanner.maxWallets': [1, 50, 'Most wallets to copy'],
  'scanner.picksPerRun': [1, 5, 'New traders per search'],
  'scanner.buySol': [0.001, 100, 'Scanner amount per buy'],
  'scanner.budgetSol': [0.001, 10_000, 'Scanner budget'],
  'scanner.maxPositions': [1, 20, 'Scanner coins at once'],
  'scanner.stopLossPct': [3, 90, 'Scanner stop-loss'],
  'scanner.takeProfitPct': [0, 1_000, 'Scanner take-profit'],
  'scanner.trailingAfterPct': [0, 1_000, 'Scanner trailing stop starts at'],
  'scanner.trailingStopPct': [0, 90, 'Scanner trailing stop'],
  'scanner.maxHoldHours': [0, 168, 'Scanner max hold'],
  'ai.reviewEveryMin': [5, 1_440, 'Review positions every'],
  'ai.walletReviewHours': [1, 720, 'Review wallets every'],
  'ai.maxWallets': [1, 50, 'Max wallets for the AI'],
  'ai.scoutEveryHours': [0, 720, 'Search for new wallets every'],
  'ai.scoutMaxPicks': [1, 5, 'New wallets per search'],
  'ai.dailyBudgetUsd': [0.1, 1_000, 'Daily AI budget', (v) => `$${v}`],
};
const BOOLEANS = ['sell.copySells', 'risk.skipIfAlreadyHolding', 'safety.rejectFreezeAuthority', 'safety.rejectMintAuthority', 'safety.rejectToken2022', 'filters.skipIfNoMarketData', 'execution.fastStream', 'trial.enabled', 'alerts.trades', 'alerts.errors', 'alerts.guard', 'alerts.autopilot', 'buy.consensusAddOn', 'buy.sizeByRecord', 'risk.moodFilter', 'safety.rugMemory', 'execution.dynamicSlippage', 'execution.mevProtect', 'execution.baseLive', 'tune.weekly', 'scanner.findTraders', 'scanner.tradeCoins', 'scanner.trackSignals', 'scanner.newCoins', 'scanner.oldCoins', 'scanner.baseCoins', 'ai.enabled', 'ai.decideBuys', 'ai.reviewPositions', 'ai.manageWallets'];
const ENUMS: Record<string, string[]> = {
  mode: ['paper', 'live'],
  'buy.sizing': ['fixed', 'percent'],
  'execution.priorityLevel': ['medium', 'high', 'veryHigh'],
  'scanner.rules': ['normal', 'strict', 'loose'],
};

const get = (o: any, path: string) => path.split('.').reduce((a, k) => a?.[k], o);
const set = (o: any, path: string, v: unknown) => {
  const ks = path.split('.');
  const last = ks.pop()!;
  ks.reduce((a, k) => a[k], o)[last] = v;
};

export function isAddress(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

const cleanLabel = (s: unknown) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 40);

/**
 * Build a clean config from untrusted input, keeping only known settings.
 * strict=true  → throw a readable error on the first bad value (used for saves from the UI).
 * strict=false → silently fall back to defaults / clamp (used when loading the file).
 */
export function sanitizeConfig(input: any, strict: boolean): Config {
  const out: Config = structuredClone(DEFAULT_CONFIG);
  const fail = (msg: string) => {
    if (strict) throw new Error(msg);
  };

  for (const [path, allowed] of Object.entries(ENUMS)) {
    const v = get(input, path);
    if (allowed.includes(v)) set(out, path, v);
    else if (v !== undefined) fail(`Invalid value for ${path}`);
  }
  for (const [path, [min, max, name, fmt = String]] of Object.entries(NUMBERS)) {
    const v = get(input, path);
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      fail(`${name} must be a number`);
      continue;
    }
    if (v < min || v > max) fail(`${name} must be between ${fmt(min)} and ${fmt(max)}`);
    set(out, path, Math.min(max, Math.max(min, v)));
  }
  for (const path of BOOLEANS) {
    const v = get(input, path);
    if (typeof v === 'boolean') set(out, path, v);
    else if (v !== undefined) fail(`Invalid value for ${path}`);
  }
  if (out.buy.minSol > out.buy.maxSol) fail('Smallest buy cannot be larger than largest buy');
  const f = out.filters;
  if (f.maxMarketCapUsd > 0 && f.minMarketCapUsd > f.maxMarketCapUsd) fail('Minimum market cap cannot be above the maximum');
  const x = out.exits;
  if (x.tp1AtPct > 0 && x.tp2AtPct > 0 && x.tp2AtPct <= x.tp1AtPct) fail('Take-profit 2 must be higher than take-profit 1');

  const wallets = Array.isArray(input?.wallets) ? input.wallets : [];
  if (wallets.length > 100) fail('At most 100 wallets');
  const seen = new Set<string>();
  for (let w of wallets.slice(0, 100)) {
    // Each chain has its own address format: Solana (base58) or Base and other EVM chains (0x…, stored lowercase).
    // No chain given (e.g. a wallet added by the finder): tell from the address format.
    const chain = (KNOWN_CHAINS as readonly string[]).includes(w?.chain) ? w.chain : typeof w?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w.address) ? 'base' : DEFAULT_CHAIN;
    const evm = chain !== 'solana';
    if (evm ? !(typeof w?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w.address)) : !isAddress(w?.address)) {
      fail(`Not a valid ${evm ? 'Base (0x…)' : 'Solana'} address: ${cleanLabel(w?.address)}`);
      continue;
    }
    if (evm) w = { ...w, address: w.address.toLowerCase() };
    if (seen.has(w.address)) continue;
    seen.add(w.address);
    const num = (v: unknown, min: number, max: number, def: number, name: string) => {
      if (v === undefined) return def;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${name} must be between ${min} and ${max}`);
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
    };
    const exits: ExitOverrides = {};
    if (w.exits && typeof w.exits === 'object') {
      for (const [k, path] of Object.entries(EXIT_KEYS) as [keyof ExitOverrides, string][]) {
        const v = w.exits[k];
        if (v === undefined || v === null || v === '') continue;
        const [min, max, name] = NUMBERS[path];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
          fail(`${cleanLabel(w.label) || 'Wallet'}: ${name} must be between ${min} and ${max}`);
          continue;
        }
        exits[k] = v;
      }
      if (exits.tp1AtPct && exits.tp2AtPct && exits.tp2AtPct <= exits.tp1AtPct) fail(`${cleanLabel(w.label) || 'Wallet'}: take-profit 2 must be higher than take-profit 1`);
    }
    out.wallets.push({
      chain,
      address: w.address,
      label: cleanLabel(w.label) || `trader-${out.wallets.length + 1}`,
      enabled: w.enabled !== false,
      sizeMultiplier: num(w.sizeMultiplier, 0.1, 10, 1, 'Size multiplier'),
      maxExposureSol: num(w.maxExposureSol, 0, 10_000, 0, 'Wallet budget'),
      ...(Object.keys(exits).length ? { exits } : {}),
      ...(typeof w.strategy === 'string' && strategyById(w.strategy) ? { strategy: w.strategy } : {}),
      ...(w.trialStage === 0 || w.trialStage === 1 ? { trialStage: w.trialStage } : {}),
      ...(typeof w.since === 'number' && Number.isFinite(w.since) && w.since > 0 ? { since: w.since } : {}),
      ...(typeof w.pausedReason === 'string' && w.pausedReason && w.enabled === false ? { pausedReason: w.pausedReason.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 120) } : {}),
    });
  }

  if (typeof input?.strategy === 'string' && /^[a-z]{1,20}$/.test(input.strategy)) out.strategy = input.strategy;

  const g = input?.ai?.guidance;
  if (typeof g === 'string') {
    if (g.length > 1000) fail('Your instructions for Claude can be at most 1000 characters');
    out.ai.guidance = g.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, 1000);
  } else if (g !== undefined) fail('Invalid value for ai.guidance');

  const bl = Array.isArray(input?.safety?.blacklist) ? input.safety.blacklist : [];
  for (const m of bl.slice(0, 1000)) {
    if (isAddress(m)) out.safety.blacklist.push(m);
    else fail(`Not a valid token address in blacklist: ${cleanLabel(m)}`);
  }
  return out;
}

export const CONFIG_PATH = 'config.json';

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Upgrade from before staged exits: the old all-or-nothing take-profit default (150%) would fire
    // before the new steps, so turn it off. A value the user chose themselves is kept.
    if (!raw.exits && raw.risk?.takeProfitPct === 150) raw.risk.takeProfitPct = 0;
    const cfg = sanitizeConfig(raw, false);
    // Upgrade to wallet trials/auto-pause: existing wallets are judged on results from now on.
    if (cfg.wallets.some((w) => !w.since)) {
      for (const w of cfg.wallets) w.since ??= Date.now();
      saveConfig(cfg);
    }
    return cfg;
  } catch {
    // Unreadable file: keep a copy for the user and start from defaults.
    fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.broken-${Date.now()}`);
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(cfg: Config) {
  fs.writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH);
}
