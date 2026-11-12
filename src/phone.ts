/**
 * What the phone page shows, worked out from the app's own data. Pure (unit-tested). The phone never
 * gets wallet addresses or keys: wallets are named by their label and an opaque id.
 */
import crypto from 'node:crypto';
import type { WalletRecord } from './rules';
import type { ShadowStats } from './shadow';

/** An id for a wallet that doesn't reveal its address (used to pause it from the phone). */
export const phoneWalletId = (address: string) => crypto.createHash('sha256').update(`copybot-phone:${address}`).digest('base64url').slice(0, 12);

type W = { address: string; label: string; enabled: boolean; chain?: string; shadow?: boolean; pausedReason?: string; trialStage?: 0 | 1 };
export type PhoneWallet = { id: string; label: string; chain: 'solana' | 'base'; state: 'copying' | 'trial' | 'shadow' | 'paused' | 'off'; note: string; pnlSol: number; closed: number; wins: number };

/** Each wallet's status in plain words, and its results in the current mode. */
export function phoneWallets(wallets: W[], records: Record<string, WalletRecord>, shadow: Record<string, (ShadowStats & { verdict: string; why: string }) | undefined>): PhoneWallet[] {
  const order = { copying: 0, trial: 1, shadow: 2, paused: 3, off: 4 };
  return wallets
    .map((w) => {
      const r = records[w.address] ?? { closed: 0, wins: 0, pnlSol: 0 };
      const chain = w.chain === 'base' || /^0x[0-9a-fA-F]{40}$/.test(w.address) ? 'base' : 'solana';
      let state: PhoneWallet['state'];
      let note: string;
      if (w.shadow && !w.enabled) {
        state = 'shadow';
        const s = shadow[w.address];
        note = s ? `${s.closed} virtual trades, ${s.pnlSol >= 0 ? '+' : ''}${s.pnlSol.toFixed(3)} SOL · ${s.verdict === 'promote' ? 'proven: joins when a slot is free' : s.why}` : 'copied virtually (no money)';
      } else if (!w.enabled) {
        state = w.pausedReason ? 'paused' : 'off';
        note = w.pausedReason ? `paused: ${w.pausedReason}` : 'off';
      } else if (w.trialStage !== undefined) {
        state = 'trial';
        note = `on trial · ${w.trialStage === 0 ? '¼' : '½'} size`;
      } else {
        state = 'copying';
        note = 'copying';
      }
      return { id: phoneWalletId(w.address), label: w.label, chain, state, note, pnlSol: r.pnlSol, closed: r.closed, wins: r.wins } as PhoneWallet;
    })
    .sort((a, b) => order[a.state] - order[b.state] || b.pnlSol - a.pnlSol);
}

type T = { t: number; mode: string; side: string; pnl?: number; chain?: string; mint?: string };

/** Today's closed results (since local midnight), in total and per chain. */
export function todayByChain(trades: T[], mode: string, dayStart: number) {
  const out = { pnlSol: 0, closed: 0, wins: 0, solana: { pnlSol: 0, closed: 0 }, base: { pnlSol: 0, closed: 0 } };
  for (const t of trades) {
    if (t.mode !== mode || t.side !== 'sell' || typeof t.pnl !== 'number' || t.t < dayStart) continue;
    const c = t.chain === 'base' || (t.mint && /^0x[0-9a-fA-F]{40}$/.test(t.mint)) ? out.base : out.solana;
    out.pnlSol += t.pnl;
    out.closed++;
    if (t.pnl > 0) out.wins++;
    c.pnlSol += t.pnl;
    c.closed++;
  }
  return out;
}

/** Local midnight of the day `now` falls in. */
export const localDayStart = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
