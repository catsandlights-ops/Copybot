/**
 * The user's own orders: buy or sell when a price is reached, and DCA (buy a little on a schedule).
 * Pure rules here; the engine checks prices while the bot runs and buys or sells through the usual
 * limits and safety checks.
 */
import { isAddress } from './config';

export type OrderKind = 'buy' | 'sell' | 'dca';
export type Order = {
  id: string;
  chain?: import('./chains/types').ChainId; // missing on orders from before chains: Solana
  kind: OrderKind;
  mint: string;
  symbol: string;
  cond?: 'below' | 'above'; // buy/sell: fire when the price is at or below / at or above priceUsd
  priceUsd?: number;
  sol?: number; // buy and dca: SOL per buy
  sellPct?: number; // sell: % of the holding
  everyHours?: number; // dca
  times?: number; // dca: how many buys in total
  maxPriceUsd?: number; // dca: skip a round when the price is above this (0/undefined = no cap)
  done: number; // dca: buys made so far
  nextAt?: number; // dca: when the next buy is due
  expiresAt?: number; // buy/sell: give up after this (undefined = never)
  attempts: number; // failed tries in a row (a safety check said no)
  status: 'active' | 'filled' | 'cancelled' | 'failed' | 'expired';
  note?: string; // last thing that happened
  createdAt: number;
  updatedAt: number;
};

export const MAX_ACTIVE_ORDERS = 20;
const MAX_ATTEMPTS = 3;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** A clean order from form input, or an error message for the user. */
export function makeOrder(b: any, now: number, id: string): Order | string {
  const kind: OrderKind | undefined = (['buy', 'sell', 'dca'] as const).find((k) => k === b?.kind);
  if (!kind) return 'Pick an order type';
  const onBase = typeof b?.mint === 'string' && /^0x[0-9a-fA-F]{40}$/.test(b.mint);
  if (!onBase && !isAddress(b.mint)) return 'Enter a valid token address';
  const symbol = String(b.symbol ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 20);
  const o: Order = { id, chain: onBase ? 'base' : 'solana', kind, mint: onBase ? b.mint.toLowerCase() : b.mint, symbol, done: 0, attempts: 0, status: 'active', createdAt: now, updatedAt: now };
  const hours = num(b.expiresInHours);
  if (kind === 'buy' || kind === 'sell') {
    if (b.cond !== 'below' && b.cond !== 'above') return 'Pick "at or below" or "at or above"';
    const price = num(b.priceUsd);
    if (!(price > 0)) return 'Enter the price (USD) that should trigger the order';
    o.cond = b.cond;
    o.priceUsd = price;
    if (Number.isFinite(hours) && hours > 0) {
      if (hours > 24 * 90) return 'Orders can wait at most 90 days';
      o.expiresAt = now + hours * 3_600_000;
    }
  }
  if (kind === 'buy' || kind === 'dca') {
    const sol = num(b.sol);
    if (!(sol >= 0.001 && sol <= 100)) return 'SOL per buy must be between 0.001 and 100';
    o.sol = sol;
  }
  if (kind === 'sell') {
    const pct = num(b.sellPct);
    if (!(pct >= 1 && pct <= 100)) return 'Sell between 1% and 100% of the holding';
    o.sellPct = pct;
  }
  if (kind === 'dca') {
    const every = num(b.everyHours);
    const times = num(b.times);
    if (!(every >= 0.25 && every <= 24 * 30)) return 'Buy every 15 minutes to 30 days';
    if (!(Number.isInteger(times) && times >= 1 && times <= 500)) return 'Number of buys must be a whole number from 1 to 500';
    o.everyHours = every;
    o.times = times;
    const cap = num(b.maxPriceUsd);
    if (Number.isFinite(cap) && cap > 0) o.maxPriceUsd = cap;
    o.nextAt = now; // the first buy goes straight away
  }
  return o;
}

export type OrderAction = { buySol: number } | { sellFraction: number } | { skip: string } | { expire: true } | null;

/**
 * What an active order should do now. priceUsd = the token's current price (null = unknown);
 * holding = whether we hold the token (sell orders need something to sell).
 */
export function orderDue(o: Order, priceUsd: number | null, holding: boolean, now: number): OrderAction {
  if (o.status !== 'active') return null;
  if (o.expiresAt && now >= o.expiresAt) return { expire: true };
  if (o.kind === 'dca') {
    if ((o.nextAt ?? 0) > now) return null;
    if (o.maxPriceUsd && (priceUsd == null || priceUsd > o.maxPriceUsd)) return { skip: priceUsd == null ? 'no price right now' : `price $${fmtPrice(priceUsd)} is above your cap $${fmtPrice(o.maxPriceUsd)}` };
    return { buySol: o.sol! };
  }
  if (priceUsd == null) return null;
  const hit = o.cond === 'below' ? priceUsd <= o.priceUsd! : priceUsd >= o.priceUsd!;
  if (!hit) return null;
  if (o.kind === 'buy') return { buySol: o.sol! };
  if (!holding) return { skip: "you don't hold this token" };
  return { sellFraction: o.sellPct! / 100 };
}

/** The order after an attempt. ok = the trade went through; why = what stopped it. */
export function afterAttempt(o: Order, ok: boolean, why: string | null, now: number): Order {
  const n: Order = { ...o, updatedAt: now };
  if (ok) {
    n.attempts = 0;
    if (o.kind === 'dca') {
      n.done = o.done + 1;
      n.note = `bought ${n.done} of ${o.times}`;
      if (n.done >= o.times!) n.status = 'filled';
      else n.nextAt = now + o.everyHours! * 3_600_000;
    } else {
      n.status = 'filled';
      n.note = why ?? 'filled';
    }
    return n;
  }
  n.note = why ?? 'not filled';
  if (o.kind === 'dca') {
    // A skipped round waits for the next one; it doesn't count as a buy.
    n.nextAt = now + o.everyHours! * 3_600_000;
    return n;
  }
  n.attempts = o.attempts + 1;
  if (n.attempts >= MAX_ATTEMPTS) n.status = 'failed';
  return n;
}

export function fmtPrice(p: number): string {
  if (p >= 1) return p.toFixed(4).replace(/\.?0+$/, '');
  const digits = Math.max(2, -Math.floor(Math.log10(p)) + 3);
  return p.toFixed(Math.min(12, digits)).replace(/0+$/, '');
}

/** One-line description for lists and the log. */
export function describeOrder(o: Order): string {
  const name = o.symbol || `${o.mint.slice(0, 4)}…${o.mint.slice(-4)}`;
  if (o.kind === 'buy') return `Buy ${o.sol} SOL of ${name} when the price is at or ${o.cond} $${fmtPrice(o.priceUsd!)}`;
  if (o.kind === 'sell') return `Sell ${o.sellPct}% of ${name} when the price is at or ${o.cond} $${fmtPrice(o.priceUsd!)}`;
  const every = o.everyHours! < 1 ? `${Math.round(o.everyHours! * 60)} min` : `${+o.everyHours!.toFixed(2)} h`;
  return `Buy ${o.sol} SOL of ${name} every ${every}, ${o.times} times${o.maxPriceUsd ? ` (only under $${fmtPrice(o.maxPriceUsd)})` : ''}`;
}
