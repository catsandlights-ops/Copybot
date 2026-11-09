/**
 * Profit reports (by day, week or month) and a tax export with USD values.
 * Pure: takes the trade log and lookups; the server fetches prices, decimals and symbols.
 */

export type ReportTrade = { t: number; mode: string; side: 'buy' | 'sell'; mint: string; sol: number; tokenRaw?: string; pnl?: number; reason?: string; source?: string; sources?: string[]; sig?: string };
export type Period = 'day' | 'week' | 'month';

const pad = (n: number) => String(n).padStart(2, '0');

/** The local period a time falls in: "2026-11-09", week starting Monday "2026-11-09", or "2026-11". */
export function periodKey(t: number, by: Period): string {
  const d = new Date(t);
  if (by === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (by === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type PeriodRow = { key: string; buys: number; sells: number; wins: number; pnlSol: number; boughtSol: number };
export type TradeHighlight = { t: number; mint: string; pnlSol: number; reason: string; from: string[] };
export type SourceRow = { source: string; sells: number; wins: number; pnlSol: number };
export type ProfitReport = { by: Period; rows: PeriodRow[]; totals: Omit<PeriodRow, 'key'>; best: TradeHighlight[]; worst: TradeHighlight[]; bySource: SourceRow[] };

/** Profit per period (newest first), plus the best and worst sells and results per source, for one mode. */
export function profitReport(trades: ReportTrade[], mode: string, by: Period, maxRows = 60): ProfitReport {
  const mine = trades.filter((t) => t.mode === mode);
  const rows = new Map<string, PeriodRow>();
  const src = new Map<string, SourceRow>();
  const totals = { buys: 0, sells: 0, wins: 0, pnlSol: 0, boughtSol: 0 };
  const sells: TradeHighlight[] = [];
  for (const t of mine) {
    const k = periodKey(t.t, by);
    const r = rows.get(k) ?? { key: k, buys: 0, sells: 0, wins: 0, pnlSol: 0, boughtSol: 0 };
    rows.set(k, r);
    if (t.side === 'buy') {
      r.buys++;
      r.boughtSol += t.sol;
      totals.buys++;
      totals.boughtSol += t.sol;
    } else if (typeof t.pnl === 'number') {
      r.sells++;
      r.pnlSol += t.pnl;
      totals.sells++;
      totals.pnlSol += t.pnl;
      if (t.pnl > 0) {
        r.wins++;
        totals.wins++;
      }
      const from = t.sources ?? [];
      sells.push({ t: t.t, mint: t.mint, pnlSol: t.pnl, reason: t.reason ?? '', from });
      for (const s of from.length ? from : ['unknown']) {
        const x = src.get(s) ?? { source: s, sells: 0, wins: 0, pnlSol: 0 };
        x.sells++;
        if (t.pnl > 0) x.wins++;
        x.pnlSol += t.pnl / Math.max(1, from.length);
        src.set(s, x);
      }
    }
  }
  const byPnl = [...sells].sort((a, b) => b.pnlSol - a.pnlSol);
  return {
    by,
    rows: [...rows.values()].sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, maxRows),
    totals,
    best: byPnl.filter((s) => s.pnlSol > 0).slice(0, 5),
    worst: byPnl.filter((s) => s.pnlSol < 0).reverse().slice(0, 5),
    bySource: [...src.values()].sort((a, b) => b.pnlSol - a.pnlSol),
  };
}

// ---------------------------------------------------------------------------
// Tax export
// ---------------------------------------------------------------------------

export type TaxRow = {
  t: number;
  type: 'buy' | 'sell';
  mint: string;
  symbol: string;
  tokenAmount: number | null;
  sol: number;
  solUsd: number | null;
  usd: number | null;
  costBasisUsd: number | null; // sells: average cost of the tokens sold
  gainUsd: number | null;
  gainSol: number | null;
  sig: string;
};

/**
 * Every trade of one mode with USD values, and for sells the gain using the average-cost method
 * per token (in USD at the time of each buy). Buys from earlier years count toward the cost of
 * later sells, so pass the whole history and filter by year afterwards.
 */
export function taxRows(trades: ReportTrade[], mode: string, solUsdAt: (t: number) => number | null, decimals: Map<string, number>, symbols: Map<string, string>): TaxRow[] {
  const held = new Map<string, { raw: number; costUsd: number | null; costSol: number }>();
  const out: TaxRow[] = [];
  for (const t of [...trades].filter((x) => x.mode === mode).sort((a, b) => a.t - b.t)) {
    const px = solUsdAt(t.t);
    const usd = px == null ? null : t.sol * px;
    const raw = Number(t.tokenRaw ?? 0);
    const dec = decimals.get(t.mint);
    const base = { t: t.t, mint: t.mint, symbol: symbols.get(t.mint) ?? '', tokenAmount: dec == null || !raw ? null : raw / 10 ** dec, sol: t.sol, solUsd: px, usd, sig: t.sig && t.sig !== 'PAPER' ? t.sig : '' };
    const h = held.get(t.mint) ?? { raw: 0, costUsd: 0, costSol: 0 };
    if (t.side === 'buy') {
      h.raw += raw;
      h.costSol += t.sol;
      h.costUsd = h.costUsd == null || usd == null ? null : h.costUsd + usd;
      held.set(t.mint, h);
      out.push({ ...base, type: 'buy', costBasisUsd: null, gainUsd: null, gainSol: null });
    } else {
      const share = h.raw > 0 ? Math.min(1, raw / h.raw) : 1;
      const basisUsd = h.costUsd == null ? null : h.costUsd * share;
      const basisSol = h.costSol * share;
      h.raw = Math.max(0, h.raw - raw);
      h.costSol -= basisSol;
      if (h.costUsd != null && basisUsd != null) h.costUsd -= basisUsd;
      if (h.raw <= 0) held.delete(t.mint);
      out.push({ ...base, type: 'sell', costBasisUsd: basisUsd, gainUsd: usd == null || basisUsd == null ? null : usd - basisUsd, gainSol: t.sol - basisSol });
    }
  }
  return out;
}

const cell = (v: unknown, digits = 9) => {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(+v.toFixed(digits)) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function taxCsv(rows: TaxRow[]): string {
  const head = ['date_utc', 'type', 'token_symbol', 'token_mint', 'token_amount', 'sol_amount', 'sol_usd_price', 'usd_value', 'cost_basis_usd', 'gain_usd', 'gain_sol', 'transaction'];
  const body = rows.map((r) =>
    [new Date(r.t).toISOString(), r.type, r.symbol, r.mint, r.tokenAmount, r.sol, r.solUsd == null ? null : +r.solUsd.toFixed(4), r.usd == null ? null : +r.usd.toFixed(2), r.costBasisUsd == null ? null : +r.costBasisUsd.toFixed(2), r.gainUsd == null ? null : +r.gainUsd.toFixed(2), r.gainSol, r.sig]
      .map((v) => cell(v))
      .join(','),
  );
  return '﻿' + [head.join(','), ...body].join('\r\n') + '\r\n';
}

/** Totals for one year of tax rows. */
export function taxSummary(rows: TaxRow[]) {
  const sells = rows.filter((r) => r.type === 'sell');
  const known = sells.filter((r) => r.gainUsd != null);
  return {
    trades: rows.length,
    sells: sells.length,
    proceedsUsd: sells.reduce((a, r) => a + (r.usd ?? 0), 0),
    gainUsd: known.reduce((a, r) => a + r.gainUsd!, 0),
    gainSol: sells.reduce((a, r) => a + (r.gainSol ?? 0), 0),
    missingPrices: rows.filter((r) => r.solUsd == null).length,
  };
}
