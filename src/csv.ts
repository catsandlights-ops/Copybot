/** CSV for spreadsheets and tax tools. Text cells that look like formulas are neutralised. */
export function tradesCsv(trades: any[], labels: Map<string, string>): string {
  const cell = (v: unknown) => {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(+v.toFixed(9)) : '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['date_utc', 'mode', 'side', 'token', 'sol', 'profit_sol', 'copied_from', 'reason', 'transaction', 'solscan'];
  const rows = trades.map((t) => {
    const from = (t.sources ?? (t.source ? [t.source] : [])).map((w: string) => labels.get(w) ?? w).join(' + ');
    const real = t.sig && t.sig !== 'PAPER';
    return [new Date(t.t).toISOString(), t.mode, t.side, t.mint, t.sol, t.side === 'sell' ? t.pnl ?? null : null, from, t.reason ?? '', real ? t.sig : '', real ? `https://solscan.io/tx/${t.sig}` : ''].map(cell).join(',');
  });
  return '\ufeff' + [head.join(','), ...rows].join('\r\n') + '\r\n';
}
