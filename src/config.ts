import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';

/** sizeMultiplier scales every buy copied from this wallet; maxExposureSol caps SOL in its positions (0 = no cap). */
export type WalletCfg = { address: string; label: string; enabled: boolean; sizeMultiplier: number; maxExposureSol: number };

export type Config = {
  mode: 'paper' | 'live';
  wallets: WalletCfg[];
  buy: { sizing: 'fixed' | 'percent'; fixedSol: number; percentOfTarget: number; minSol: number; maxSol: number; minTargetBuySol: number };
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
  /** Market-data filters (Dexscreener). 0 turns a filter off. */
  filters: {
    minLiquidityUsd: number;
    maxTradePctOfLiquidity: number;
    minMarketCapUsd: number;
    maxMarketCapUsd: number;
    minTokenAgeMin: number;
    skipIfNoMarketData: boolean;
  };
  safety: {
    slippageBps: number;
    maxRoundTripLossPct: number;
    rejectFreezeAuthority: boolean;
    rejectMintAuthority: boolean;
    rejectToken2022: boolean;
    blacklist: string[];
  };
  execution: { priorityLevel: 'medium' | 'high' | 'veryHigh'; priorityFeeMaxLamports: number };
  monitor: { pollIntervalSec: number; exitCheckIntervalSec: number };
};

export const DEFAULT_CONFIG: Config = {
  mode: 'paper',
  wallets: [],
  buy: { sizing: 'fixed', fixedSol: 0.05, percentOfTarget: 5, minSol: 0.01, maxSol: 0.2, minTargetBuySol: 0.2 },
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
    pauseAfterLosses: 4,
    pauseMinutes: 60,
  },
  exits: { recoverCostAtPct: 100, tp1AtPct: 300, tp1SellPct: 50, tp2AtPct: 900, tp2SellPct: 50, trailingAfterPct: 50, trailingStopPct: 30 },
  filters: { minLiquidityUsd: 10_000, maxTradePctOfLiquidity: 2, minMarketCapUsd: 0, maxMarketCapUsd: 0, minTokenAgeMin: 0, skipIfNoMarketData: false },
  safety: {
    slippageBps: 300,
    maxRoundTripLossPct: 12,
    rejectFreezeAuthority: true,
    rejectMintAuthority: false,
    rejectToken2022: false,
    blacklist: [],
  },
  execution: { priorityLevel: 'veryHigh', priorityFeeMaxLamports: 1_000_000 },
  monitor: { pollIntervalSec: 4, exitCheckIntervalSec: 20 },
};

/** Allowed range for every numeric setting: [min, max, human name]. */
const NUMBERS: Record<string, [number, number, string, ((v: number) => string)?]> = {
  'buy.fixedSol': [0.001, 100, 'Amount per buy'],
  'buy.percentOfTarget': [0.1, 100, 'Percent of their buy'],
  'buy.minSol': [0.001, 100, 'Smallest buy'],
  'buy.maxSol': [0.001, 100, 'Largest buy'],
  'buy.minTargetBuySol': [0, 10_000, 'Ignore their buys under'],
  'risk.maxOpenPositions': [1, 100, 'Max tokens held at once'],
  'risk.maxTotalExposureSol': [0.001, 10_000, 'Max SOL in open positions'],
  'risk.stopLossPct': [1, 100, 'Stop-loss'],
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
  'filters.minLiquidityUsd': [0, 1e10, 'Minimum liquidity'],
  'filters.maxTradePctOfLiquidity': [0, 100, 'Max trade size vs liquidity'],
  'filters.minMarketCapUsd': [0, 1e13, 'Minimum market cap'],
  'filters.maxMarketCapUsd': [0, 1e13, 'Maximum market cap'],
  'filters.minTokenAgeMin': [0, 525_600, 'Minimum token age'],
  'safety.slippageBps': [10, 5_000, 'Max slippage', (v) => `${v / 100}%`],
  'safety.maxRoundTripLossPct': [0.1, 100, 'Max buy-then-sell loss'],
  'execution.priorityFeeMaxLamports': [0, 50_000_000, 'Max priority fee', (v) => `${v / 1e9} SOL`],
  'monitor.pollIntervalSec': [1, 300, 'Backup check interval'],
  'monitor.exitCheckIntervalSec': [5, 3_600, 'Stop-loss check interval'],
};
const BOOLEANS = ['sell.copySells', 'risk.skipIfAlreadyHolding', 'safety.rejectFreezeAuthority', 'safety.rejectMintAuthority', 'safety.rejectToken2022', 'filters.skipIfNoMarketData'];
const ENUMS: Record<string, string[]> = {
  mode: ['paper', 'live'],
  'buy.sizing': ['fixed', 'percent'],
  'execution.priorityLevel': ['medium', 'high', 'veryHigh'],
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
  for (const w of wallets.slice(0, 100)) {
    if (!isAddress(w?.address)) {
      fail(`Not a valid Solana address: ${cleanLabel(w?.address)}`);
      continue;
    }
    if (seen.has(w.address)) continue;
    seen.add(w.address);
    const num = (v: unknown, min: number, max: number, def: number, name: string) => {
      if (v === undefined) return def;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${name} must be between ${min} and ${max}`);
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
    };
    out.wallets.push({
      address: w.address,
      label: cleanLabel(w.label) || `trader-${out.wallets.length + 1}`,
      enabled: w.enabled !== false,
      sizeMultiplier: num(w.sizeMultiplier, 0.1, 10, 1, 'Size multiplier'),
      maxExposureSol: num(w.maxExposureSol, 0, 10_000, 0, 'Wallet budget'),
    });
  }

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
    return sanitizeConfig(raw, false);
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
