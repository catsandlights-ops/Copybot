import fs from 'node:fs';

/**
 * Your trade history (data/trades.jsonl), kept in memory. Every read only checks the file's size
 * and time: new lines are parsed when it grew, and it's reloaded in full only if it was replaced
 * (a paper reset, a restored backup). Months of trades no longer get re-read many times a minute.
 */
type Cache = { file: string; size: number; mtimeMs: number; ino: number; rows: any[]; partial: string };
const caches = new Map<string, Cache>();

const parse = (text: string) =>
  text.split('\n').flatMap((l) => {
    if (!l.trim()) return [];
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

export function readTradeLog(file = 'data/trades.jsonl'): any[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    caches.delete(file);
    return [];
  }
  const c = caches.get(file);
  if (c && c.ino === st.ino && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.rows.slice();
  if (c && c.ino === st.ino && st.size > c.size) {
    // Appended to: read only the new bytes (a line may still be half-written: keep it for next time).
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.size);
      fs.readSync(fd, buf, 0, buf.length, c.size);
      const text = c.partial + buf.toString('utf8');
      const cut = text.lastIndexOf('\n') + 1;
      c.rows.push(...parse(text.slice(0, cut)));
      Object.assign(c, { size: st.size, mtimeMs: st.mtimeMs, partial: text.slice(cut) });
      return c.rows.slice();
    } finally {
      fs.closeSync(fd);
    }
  }
  const text = fs.readFileSync(file, 'utf8');
  const cut = text.lastIndexOf('\n') + 1;
  const fresh: Cache = { file, size: Buffer.byteLength(text), mtimeMs: st.mtimeMs, ino: st.ino, rows: parse(text.slice(0, cut)), partial: text.slice(cut) };
  // A last line without a newline is still a complete trade when the file was written in one go.
  if (fresh.partial.trim()) {
    try {
      fresh.rows.push(JSON.parse(fresh.partial));
      fresh.partial = '';
    } catch {
      /* half-written: picked up when the rest arrives */
    }
  }
  caches.set(file, fresh);
  return fresh.rows.slice();
}
