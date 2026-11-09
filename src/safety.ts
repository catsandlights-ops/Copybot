import { Connection, ParsedAccountData, PublicKey } from '@solana/web3.js';
import { Config } from './config';
import { Quote, quoteBuy, quoteSell } from './jupiter';

// Classic SPL Token program. Mints owned by anything else are Token-2022.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export type CheckResult = { ok: true; buyQuote: Quote; decimals: number } | { ok: false; reason: string };

/**
 * Checks before buying a token:
 *  - mint authorities (freeze authority lets the creator lock your tokens = classic honeypot)
 *  - a route exists to buy AND to sell back, and the round trip doesn't lose too much
 *    (catches near-zero liquidity, huge price impact and many sell-blocked tokens)
 */
export async function checkToken(conn: Connection, cfg: Config, mint: string, lamports: bigint): Promise<CheckResult> {
  const s = cfg.safety;
  if (s.blacklist.includes(mint)) return { ok: false, reason: 'blacklisted' };

  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const acct = info.value;
  if (!acct) return { ok: false, reason: 'mint account not found' };
  const parsed = (acct.data as ParsedAccountData).parsed?.info;
  if (!parsed) return { ok: false, reason: 'not a token mint' };
  if (s.rejectToken2022 && acct.owner.toBase58() !== TOKEN_PROGRAM) return { ok: false, reason: 'Token-2022 mint' };
  if (s.rejectFreezeAuthority && parsed.freezeAuthority) return { ok: false, reason: 'has freeze authority' };
  if (s.rejectMintAuthority && parsed.mintAuthority) return { ok: false, reason: 'has mint authority' };

  const buy = await quoteBuy(mint, lamports, s.slippageBps);
  if (!buy) return { ok: false, reason: 'no buy route' };
  const sell = await quoteSell(mint, BigInt(buy.outAmount), s.slippageBps);
  if (!sell) return { ok: false, reason: 'no sell route (possible honeypot)' };
  const lossPct = (1 - Number(sell.outAmount) / Number(lamports)) * 100;
  if (lossPct > s.maxRoundTripLossPct) {
    return { ok: false, reason: `round-trip loss ${lossPct.toFixed(1)}% > ${s.maxRoundTripLossPct}%` };
  }
  return { ok: true, buyQuote: buy, decimals: Number(parsed.decimals) || 0 };
}
