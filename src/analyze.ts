/**
 * Score wallets on their actual on-chain trading record.
 *   npm run analyze -- <wallet> [<wallet> ...] [--txs 300]
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { makeConnection } from './env';
import { decodeSwap, Swap } from './decode';
import { getTx, mapLimit, short, withRetry, getTxBatch, BatchUnsupported, batchingOn, setBatching, type RawTx } from './util';
import { historyCache } from './history';


export type Report = {
  wallet: string;
  swaps: number;
  days: number;
  tradesPerDay: number;
  tokens: number;
  closedTokens: number;
  winRate: number;
  realizedPnlSol: number;
  spentOnClosedSol: number;
  roiPct: number;
  medianBuySol: number;
  medianHoldMin: number;
  notes: string[];
};

const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

export type FetchStats = { read: number; failed: number; cached?: number; truncated?: boolean; oldestMs?: number | null };

/**
 * A wallet's SOL swaps, newest first in the chain's order.
 *  - by count: the last `maxTxs` transactions
 *  - by date (`since`/`until`, ms): every transaction in that window, up to `maxTxs`
 * `stats.failed` counts transactions that couldn't be read (RPC errors); `stats.truncated` is set
 * when the date window had more than `maxTxs` transactions (then `stats.oldestMs` is how far back it got).
 */
export async function fetchSwaps(
  conn: Connection,
  wallet: string,
  maxTxs: number,
  onProgress?: (n: number, total: number) => void,
  opts: { tries?: number; stats?: FetchStats; since?: number; until?: number; onScan?: (n: number) => void; deadline?: number } = {},
): Promise<Swap[]> {
  // Base wallets (0x…) read their history from Alchemy instead.
  if (/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    const { fetchBaseSwaps } = await import('./chains/base');
    return fetchBaseSwaps(wallet.toLowerCase(), maxTxs, { since: opts.since, until: opts.until, stats: opts.stats, onProgress });
  }
  const pk = new PublicKey(wallet);
  const sigs: string[] = [];
  const byDate = opts.since !== undefined;
  let before: string | undefined;
  let scanned = 0;
  let reachedStart = false;
  // Bots can send hundreds of thousands of (mostly failed) transactions; never read further back than this.
  const maxScan = Math.max(maxTxs * 10, 50_000);
  while (sigs.length < maxTxs && scanned < maxScan) {
    const page = await withRetry(() => conn.getSignaturesForAddress(pk, { limit: byDate ? 1000 : Math.min(1000, maxTxs - sigs.length), before }));
    if (!page.length) {
      reachedStart = true;
      break;
    }
    scanned += page.length;
    opts.onScan?.(scanned);
    for (const s of page) {
      if (s.err) continue;
      const t = s.blockTime ? s.blockTime * 1000 : null;
      if (byDate && t !== null && (t < opts.since! || (opts.until !== undefined && t > opts.until))) continue;
      if (sigs.length < maxTxs) sigs.push(s.signature);
    }
    before = page[page.length - 1].signature;
    const oldest = page[page.length - 1].blockTime;
    if (opts.stats) opts.stats.oldestMs = oldest ? oldest * 1000 : null;
    if (byDate && oldest && oldest * 1000 < opts.since!) {
      reachedStart = true;
      break;
    }
    if (page.length < 1000) {
      reachedStart = true;
      break;
    }
  }
  if (opts.stats && byDate) opts.stats.truncated = !reachedStart;
  // Transactions read before come from the on-disk cache; only new ones are downloaded.
  let done = 0;
  let fresh = 0;
  const found = new Map<string, Swap | null>();
  for (const sig of sigs) {
    const cached = historyCache.get(wallet, sig);
    if (!cached) continue;
    found.set(sig, cached.swap);
    if (opts.stats) {
      opts.stats.read++;
      opts.stats.cached = (opts.stats.cached ?? 0) + 1;
    }
    onProgress?.(++done, sigs.length);
  }
  // One downloaded transaction: decoded, cached (errors and not-found aren't, so they're retried next time).
  const settle = (sig: string, tx: RawTx | null | undefined) => {
    if (opts.stats) {
      opts.stats.read++;
      if (tx === undefined) opts.stats.failed++;
    }
    onProgress?.(++done, sigs.length);
    if (!tx) return;
    const swap = decodeSwap(tx, wallet);
    historyCache.set(wallet, sig, swap);
    found.set(sig, swap);
    fresh++;
  };
  // Out of time: give up on this wallet (a half-read history would misjudge it).
  const inTime = () => {
    if (opts.deadline && Date.now() > opts.deadline) throw new Error('out of time');
  };
  const one = async (sig: string) => {
    inTime();
    settle(sig, await getTx(sig, opts.tries ?? 2).catch(() => undefined));
  };
  const todo = sigs.filter((sig) => !found.has(sig));
  if (batchingOn() && todo.length > 1) {
    const chunks: string[][] = [];
    for (let i = 0; i < todo.length; i += 10) chunks.push(todo.slice(i, i + 10));
    await mapLimit(chunks, 2, async (chunk) => {
      inTime();
      try {
        const txs = await getTxBatch(chunk);
        chunk.forEach((sig, i) => settle(sig, txs[i]));
      } catch (e) {
        if (e instanceof BatchUnsupported) setBatching(false); // this node takes one at a time
        for (const sig of chunk) await one(sig);
      }
    });
  } else await mapLimit(todo, 4, one);
  if (fresh) historyCache.save(wallet);
  return sigs.map((sig) => found.get(sig)).filter((s): s is Swap => !!s && s.quote === 'SOL');
}

export function score(wallet: string, swaps: Swap[]): Report {
  const byMint = new Map<string, { spent: number; got: number; firstBuy?: number; lastSell?: number; sold: boolean }>();
  for (const s of [...swaps].sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0))) {
    const m = byMint.get(s.mint) ?? { spent: 0, got: 0, sold: false };
    if (s.side === 'buy') {
      m.spent += s.quoteAmount;
      m.firstBuy ??= s.blockTime ?? undefined;
    } else {
      m.got += s.quoteAmount;
      m.sold = true;
      m.lastSell = s.blockTime ?? undefined;
    }
    byMint.set(s.mint, m);
  }
  // Only count tokens where we saw both the buy and the sell inside the window.
  const closed = [...byMint.values()].filter((m) => m.sold && m.spent > 0);
  const wins = closed.filter((m) => m.got > m.spent).length;
  const pnl = closed.reduce((a, m) => a + m.got - m.spent, 0);
  const spent = closed.reduce((a, m) => a + m.spent, 0);
  const holds = closed.filter((m) => m.firstBuy && m.lastSell).map((m) => (m.lastSell! - m.firstBuy!) / 60);
  const times = swaps.map((s) => s.blockTime ?? 0).filter(Boolean);
  const days = times.length ? Math.max(1 / 24, (Math.max(...times) - Math.min(...times)) / 86400) : 0;
  const tpd = days ? swaps.length / days : 0;
  const r: Report = {
    wallet,
    swaps: swaps.length,
    days,
    tradesPerDay: tpd,
    tokens: byMint.size,
    closedTokens: closed.length,
    winRate: closed.length ? wins / closed.length : 0,
    realizedPnlSol: pnl,
    spentOnClosedSol: spent,
    roiPct: spent ? (pnl / spent) * 100 : 0,
    medianBuySol: median(swaps.filter((s) => s.side === 'buy').map((s) => s.quoteAmount)),
    medianHoldMin: median(holds),
    notes: [],
  };
  if (r.closedTokens < 10) r.notes.push('too few closed trades to judge');
  if (tpd > 150) r.notes.push('very high frequency: probably a bot, hard to copy');
  if (r.medianHoldMin < 2 && closed.length) r.notes.push('holds < 2 min: you will be too slow to copy exits');
  if (r.medianBuySol > 20) r.notes.push('large size: your fills will differ less, but it moves price');
  if (r.roiPct > 20 && r.winRate > 0.45 && r.closedTokens >= 10 && tpd <= 150) r.notes.push('✅ promising candidate');
  return r;
}

export function printReports(rs: Report[]) {
  console.log('\nwallet        swaps  days  /day  tokens closed  win%   PnL(SOL)   ROI%   medBuy  medHold(min)');
  for (const r of rs.sort((a, b) => b.realizedPnlSol - a.realizedPnlSol)) {
    console.log(
      `${short(r.wallet).padEnd(12)} ${String(r.swaps).padStart(6)} ${r.days.toFixed(1).padStart(5)} ${r.tradesPerDay.toFixed(0).padStart(5)} ${String(r.tokens).padStart(7)} ${String(r.closedTokens).padStart(6)} ${(r.winRate * 100).toFixed(0).padStart(5)} ${r.realizedPnlSol.toFixed(2).padStart(10)} ${r.roiPct.toFixed(0).padStart(6)} ${r.medianBuySol.toFixed(2).padStart(8)} ${r.medianHoldMin.toFixed(1).padStart(12)}`,
    );
    for (const n of r.notes) console.log(`              ↳ ${n}`);
  }
  console.log('\nFull addresses:');
  for (const r of rs) console.log(`  ${r.wallet}`);
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--txs');
  const maxTxs = i >= 0 ? Number(args.splice(i, 2)[1]) : 300;
  if (!args.length) {
    console.log('usage: npm run analyze -- <wallet> [<wallet> ...] [--txs 300]');
    process.exit(1);
  }
  const reports: Report[] = [];
  for (const w of args) {
    process.stdout.write(`Analyzing ${w} `);
    const swaps = await fetchSwaps(makeConnection(), w, maxTxs, (n, t) => n % 25 === 0 && process.stdout.write(`${n}/${t} `));
    console.log(`→ ${swaps.length} swaps`);
    reports.push(score(w, swaps));
  }
  printReports(reports);
}

if (process.argv[1]?.endsWith('analyze.ts')) main();
