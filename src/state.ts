import fs from 'node:fs';
import type { ExitStep, GuardState } from './rules';

export type Position = {
  mint: string;
  decimals: number;
  amountRaw: string; // bigint as string
  costSol: number; // SOL cost basis of what we still hold
  openedAt: number;
  sources: string[]; // wallets we copied into this position
  steps?: ExitStep[]; // staged exits already taken
  peakMultiple?: number; // highest value / cost seen (for the trailing stop)
};

export type State = { positions: Record<string, Position>; realizedPnlSol: number; guard?: GuardState };

// Paper and live positions are kept in separate files so they never mix.
const file = (mode: string) => `data/state-${mode}.json`;

/** Load positions. A corrupted file is kept aside (never silently discarded). */
export function loadState(mode: string): { state: State; warning?: string } {
  const f = file(mode);
  if (!fs.existsSync(f)) return { state: { positions: {}, realizedPnlSol: 0 } };
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8')) as State;
    if (typeof s.positions !== 'object' || s.positions === null) throw new Error('bad format');
    return { state: { positions: s.positions, realizedPnlSol: Number(s.realizedPnlSol) || 0, guard: s.guard } };
  } catch {
    const backup = `${f}.corrupt-${Date.now()}`;
    fs.copyFileSync(f, backup);
    return {
      state: { positions: {}, realizedPnlSol: 0 },
      warning: `Your ${mode} positions file was damaged. A copy was saved as ${backup}. Check your wallet for tokens the bot no longer tracks.`,
    };
  }
}

export function saveState(s: State, mode: string) {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(file(mode) + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(file(mode) + '.tmp', file(mode));
}

export const exposure = (s: State) => Object.values(s.positions).reduce((a, p) => a + p.costSol, 0);
