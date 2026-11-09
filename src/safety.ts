import { Connection, ParsedAccountData, PublicKey } from '@solana/web3.js';
import { Config } from './config';
import { Quote, quoteBuy, quoteSell } from './jupiter';

// Classic SPL Token program. Mints owned by anything else are Token-2022.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export type CheckResult = { ok: true; buyQuote: Quote; decimals: number } | { ok: false; reason: string };

/**
 * What can't change about a token once created: its program and whether it has a freeze authority
 * (one can never be added later); a mint authority can only be given up. So this is cached, and a
 * second buy of the same token skips the lookup.
 */
type MintFacts = { owner: string; freeze: boolean; mint: boolean; decimals: number };
const mintCache = new Map<string, { at: number; f: MintFacts }>();
async function mintFacts(conn: Connection, mint: string): Promise<MintFacts | string> {
  const hit = mintCache.get(mint);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.f;
  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const acct = info.value;
  if (!acct) return 'mint account not found';
  const parsed = (acct.data as ParsedAccountData).parsed?.info;
  if (!parsed) return 'not a token mint';
  const f = { owner: acct.owner.toBase58(), freeze: !!parsed.freezeAuthority, mint: !!parsed.mintAuthority, decimals: Number(parsed.decimals) || 0 };
  mintCache.set(mint, { at: Date.now(), f });
  if (mintCache.size > 2000) mintCache.delete(mintCache.keys().next().value!);
  return f;
}

/**
 * Who created a token: the fee payer of its oldest transaction (reads back up to 3,000 signatures).
 * null when it can't be found quickly (very busy tokens).
 */
const creatorCache = new Map<string, string | null>();
export async function tokenCreator(conn: Connection, mint: string): Promise<string | null> {
  if (creatorCache.has(mint)) return creatorCache.get(mint)!;
  const pk = new PublicKey(mint);
  let before: string | undefined;
  let oldest: string | undefined;
  for (let page = 0; page < 3; page++) {
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 1000, before });
    if (!sigs.length) break;
    oldest = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) {
      before = undefined;
      break;
    }
    before = oldest;
  }
  let creator: string | null = null;
  if (oldest && !before) {
    const tx = await conn.getTransaction(oldest, { maxSupportedTransactionVersion: 0 });
    creator = tx?.transaction.message.staticAccountKeys[0]?.toBase58() ?? null;
  }
  creatorCache.set(mint, creator);
  if (creatorCache.size > 2000) creatorCache.delete(creatorCache.keys().next().value!);
  return creator;
}

/**
 * Checks before buying a token:
 *  - mint authorities (freeze authority lets the creator lock your tokens = classic honeypot)
 *  - a route exists to buy AND to sell back, and the round trip doesn't lose too much
 *    (catches near-zero liquidity, huge price impact and many sell-blocked tokens)
 */
export async function checkToken(conn: Connection, cfg: Config, mint: string, lamports: bigint): Promise<CheckResult> {
  const s = cfg.safety;
  if (s.blacklist.includes(mint)) return { ok: false, reason: 'blacklisted' };

  // The token facts and the buy quote don't depend on each other: fetch both at once.
  const [facts, buy] = await Promise.all([mintFacts(conn, mint), quoteBuy(mint, lamports, s.slippageBps)]);
  if (typeof facts === 'string') return { ok: false, reason: facts };
  if (s.rejectToken2022 && facts.owner !== TOKEN_PROGRAM) return { ok: false, reason: 'Token-2022 mint' };
  if (s.rejectFreezeAuthority && facts.freeze) return { ok: false, reason: 'has freeze authority' };
  if (s.rejectMintAuthority && facts.mint) return { ok: false, reason: 'has mint authority' };

  if (!buy) return { ok: false, reason: 'no buy route' };
  const sell = await quoteSell(mint, BigInt(buy.outAmount), s.slippageBps);
  if (!sell) return { ok: false, reason: 'no sell route (possible honeypot)' };
  const lossPct = (1 - Number(sell.outAmount) / Number(lamports)) * 100;
  if (lossPct > s.maxRoundTripLossPct) {
    return { ok: false, reason: `round-trip loss ${lossPct.toFixed(1)}% > ${s.maxRoundTripLossPct}%` };
  }
  return { ok: true, buyQuote: buy, decimals: facts.decimals };
}
