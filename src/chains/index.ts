/** The chains Remora can trade on, by id. */
import { solana } from './solana';
import { base } from './base';
import { chainOf, DEFAULT_CHAIN, type ChainAdapter, type ChainId } from './types';

export * from './types';

const CHAINS: Record<ChainId, ChainAdapter> = { solana, base };

export const chainIds = () => Object.keys(CHAINS) as ChainId[];
export const isChainId = (s: unknown): s is ChainId => typeof s === 'string' && s in CHAINS;

/** The adapter for a chain id, or for a record (records without a chain are Solana). */
export function getChain(id: ChainId | { chain?: string } | null | undefined = DEFAULT_CHAIN): ChainAdapter {
  const key = typeof id === 'string' ? id : chainOf(id);
  return CHAINS[key] ?? CHAINS[DEFAULT_CHAIN];
}
