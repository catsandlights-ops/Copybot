/**
 * On-disk cache of decoded wallet transactions, shared by Analyze, Backtest and the wallet scout.
 * A confirmed transaction never changes, so once read it never needs to be downloaded again.
 * Stored per wallet in data/history/<wallet>.json as { signature: swap | 0 } (0 = not a SOL swap).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Swap } from './decode';

const DIR = 'data/history';
const MAX_ENTRIES = 20_000; // per wallet
const MAX_FILES = 400;

type Stored = Omit<Swap, 'tokenAmount' | 'tokenPre' | 'tokenPost'> & { tokenAmount: string; tokenPre: string; tokenPost: string };
type FileShape = { v: 1; entries: Record<string, Stored | 0> };

const toStored = (s: Swap): Stored => ({ ...s, tokenAmount: s.tokenAmount.toString(), tokenPre: s.tokenPre.toString(), tokenPost: s.tokenPost.toString() });
const fromStored = (s: Stored): Swap => ({ ...s, tokenAmount: BigInt(s.tokenAmount), tokenPre: BigInt(s.tokenPre), tokenPost: BigInt(s.tokenPost) });
const file = (wallet: string) => path.join(DIR, `${wallet.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '')}.json`);

/** In memory while in use, so parallel jobs on the same wallet share one copy. */
const open = new Map<string, FileShape>();

function load(wallet: string): FileShape {
  const hit = open.get(wallet);
  if (hit) return hit;
  let data: FileShape = { v: 1, entries: {} };
  try {
    const j = JSON.parse(fs.readFileSync(file(wallet), 'utf8'));
    if (j?.v === 1 && j.entries && typeof j.entries === 'object') data = j;
  } catch {
    /* nothing cached yet, or an unreadable file: start fresh */
  }
  open.set(wallet, data);
  if (open.size > 50) open.delete(open.keys().next().value!);
  return data;
}

export type CacheLookup = { swap: Swap | null } | undefined;

export const historyCache = {
  /** undefined = not cached; { swap: null } = cached as "not a SOL swap". */
  get(wallet: string, sig: string): CacheLookup {
    const e = load(wallet).entries[sig];
    if (e === undefined) return undefined;
    return { swap: e === 0 ? null : fromStored(e) };
  },
  set(wallet: string, sig: string, swap: Swap | null) {
    load(wallet).entries[sig] = swap ? toStored(swap) : 0;
  },
  save(wallet: string) {
    const data = load(wallet);
    const keys = Object.keys(data.entries);
    if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete data.entries[k];
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file(wallet) + '.tmp', JSON.stringify(data));
    fs.renameSync(file(wallet) + '.tmp', file(wallet));
    prune();
  },
  size(wallet: string) {
    return Object.keys(load(wallet).entries).length;
  },
};

/** Keep the folder bounded: drop the least recently updated wallets. */
function prune() {
  let names: string[];
  try {
    names = fs.readdirSync(DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  if (names.length <= MAX_FILES) return;
  const byAge = names.map((n) => ({ n, t: fs.statSync(path.join(DIR, n)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const { n } of byAge.slice(0, names.length - MAX_FILES)) fs.rmSync(path.join(DIR, n), { force: true });
}
