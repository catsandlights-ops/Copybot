/**
 * Connection status: is every outside service Remora relies on working right now?
 * Each check runs at the same time with its own time limit; the result says what's wrong in
 * plain words and what fixes it.
 */
export type Health = 'ok' | 'slow' | 'limited' | 'down' | 'off';
export type CheckResult = { id: string; name: string; what: string; health: Health; ms: number | null; detail: string; fix: string | null };
export type Check = { id: string; name: string; what: string; run: () => Promise<string | void>; fixes: Partial<Record<Health, string>>; enabled?: () => boolean };

/** Rate limits look different everywhere: HTTP 429, "limit", "too many", "busy". */
export const isLimited = (msg: string) => /429|rate.?limit|too many|limit (reached|exceeded)|busy|exceeded/i.test(msg);

/** Classify one finished check. Pure (unit-tested). */
export function classify(ms: number, err: Error | null, slowMs = 3000): { health: Health; detail: string } {
  if (err) return { health: isLimited(err.message) ? 'limited' : 'down', detail: err.message.slice(0, 160) };
  return { health: ms > slowMs ? 'slow' : 'ok', detail: ms > slowMs ? `answered, but slowly (${(ms / 1000).toFixed(1)} s)` : 'working' };
}

export async function runChecks(checks: Check[], timeoutMs = 12_000): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (c): Promise<CheckResult> => {
      if (c.enabled && !c.enabled()) return { id: c.id, name: c.name, what: c.what, health: 'off', ms: null, detail: 'not used with your settings', fix: null };
      const t = Date.now();
      let err: Error | null = null;
      let note: string | void = undefined;
      try {
        note = await Promise.race([c.run(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs))]);
      } catch (e) {
        err = e as Error;
      }
      const ms = Date.now() - t;
      const { health, detail } = classify(ms, err);
      return { id: c.id, name: c.name, what: c.what, health, ms: err ? null : ms, detail: !err && note ? `${detail} · ${note}` : detail, fix: health === 'ok' ? null : c.fixes[health] ?? c.fixes.down ?? null };
    }),
  );
}

/** One line for the whole picture. */
export function summary(rs: CheckResult[]): { level: 'ok' | 'warn' | 'bad'; text: string } {
  const bad = rs.filter((r) => r.health === 'down');
  const warn = rs.filter((r) => r.health === 'limited' || r.health === 'slow');
  if (bad.length) return { level: 'bad', text: `${bad.map((r) => r.name).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not working` };
  if (warn.length) return { level: 'warn', text: `${warn.map((r) => r.name).join(', ')} ${warn.length === 1 ? 'is' : 'are'} busy or slow` };
  return { level: 'ok', text: 'Everything is working' };
}
