/**
 * Find wallets that bought tokens EARLY. Give it a few tokens that pumped:
 * wallets that were early on several of them are worth analyzing.
 *   npm run discover -- <mint> [<mint> ...] [--early 150] [--pages 10]
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { makeConnection } from './env';
import { decodeSwap } from './decode';
import { getTx, mapLimit, short, withRetry } from './util';


export async function earlyBuyers(conn: Connection, mint: string, early: number, maxPages: number, warn: (m: string) => void = console.log) {
  const pk = new PublicKey(mint);
  let before: string | undefined;
  let oldest: string[] = [];
  let reachedStart = false;
  for (let p = 0; p < maxPages; p++) {
    const page = await withRetry(() => conn.getSignaturesForAddress(pk, { limit: 1000, before }));
    if (!page.length) {
      reachedStart = true;
      break;
    }
    oldest = [...oldest, ...page.filter((s) => !s.err).map((s) => s.signature)].slice(-early * 3);
    before = page[page.length - 1].signature;
    if (page.length < 1000) {
      reachedStart = true;
      break;
    }
  }
  if (!reachedStart) warn(`⚠ ${short(mint)} has more history than ${maxPages}k txs; "early" here means early within what we scanned. Use --pages to go deeper.`);
  const sigs = oldest.reverse(); // oldest first
  const buyers = new Map<string, number>();
  await mapLimit(sigs, 4, async (sig) => {
    if (buyers.size >= early) return;
    const tx = await getTx(sig, 2).catch(() => null);
    if (!tx) return;
    const signer = tx.accountKeys[0];
    const s = decodeSwap(tx, signer);
    if (s && s.side === 'buy' && s.mint === mint && s.quote === 'SOL') buyers.set(signer, (buyers.get(signer) ?? 0) + s.quoteAmount);
  });
  return buyers;
}

export type Candidate = { wallet: string; mints: string[]; sol: number };

export function rankCandidates(perMint: Map<string, Map<string, number>>): Candidate[] {
  const hits = new Map<string, Candidate>();
  for (const [mint, buyers] of perMint) {
    for (const [w, sol] of buyers) {
      const h = hits.get(w) ?? { wallet: w, mints: [], sol: 0 };
      h.mints.push(mint);
      h.sol += sol;
      hits.set(w, h);
    }
  }
  return [...hits.values()].sort((a, b) => b.mints.length - a.mints.length || b.sol - a.sol);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string, def: number) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args.splice(i, 2)[1]) : def;
  };
  const early = opt('--early', 150);
  const pages = opt('--pages', 10);
  if (!args.length) {
    console.log('usage: npm run discover -- <tokenMint> [<tokenMint> ...] [--early 150] [--pages 10]');
    process.exit(1);
  }
  const conn = makeConnection();
  const perMint = new Map<string, Map<string, number>>();
  for (const mint of args) {
    console.log(`Scanning early buyers of ${mint} ...`);
    const buyers = await earlyBuyers(conn, mint, early, pages);
    console.log(`  found ${buyers.size} early buyers`);
    perMint.set(mint, buyers);
  }
  const ranked = rankCandidates(perMint);
  console.log('\nWallets ranked by how many of these tokens they bought early:\n');
  for (const c of ranked.slice(0, 30)) console.log(`  ${c.wallet}  early on ${c.mints.length}/${args.length}  (${c.sol.toFixed(2)} SOL)`);
  const top = ranked.filter((c) => c.mints.length > 1).slice(0, 10).map((c) => c.wallet);
  if (top.length) console.log(`\nNext step — check their actual profit:\n  npm run analyze -- ${top.join(' ')}`);
  else console.log('\nNo wallet was early on more than one token. Try more tokens, ideally ones that pumped in the same week.');
}

if (process.argv[1]?.endsWith('discover.ts')) main();
