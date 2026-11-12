/**
 * Keeping Copybot healthy when it runs all day, every day:
 *  - remember whether the bot was running, so it can start again after a crash, a power cut or a
 *    Windows restart (anything other than you stopping it);
 *  - a daily backup (settings, wallets, history; never keys), keeping the last 7;
 *  - old copies (paper resets, pre-restore safety copies) trimmed to the newest few.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './util';

// ---------- was the bot running? ----------
const RUN_FILE = 'data/run-state.json';
export type RunState = { running: boolean; mode: string; at: number };

export function saveRunState(running: boolean, mode: string, now = Date.now()) {
  try {
    fs.mkdirSync('data', { recursive: true });
    writeAtomic(RUN_FILE, JSON.stringify({ running, mode, at: now }));
  } catch {
    /* best effort */
  }
}
export function readRunState(): RunState | null {
  try {
    const j = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
    return typeof j?.running === 'boolean' ? j : null;
  } catch {
    return null;
  }
}

/**
 * Should the bot start by itself now? Only if it was running when Copybot last closed without you
 * stopping it, in the same mode (a switch to/from live never resumes by itself), and the setting is on.
 */
export function shouldResume(prev: RunState | null, mode: string, enabled: boolean): boolean {
  return !!enabled && !!prev?.running && prev.mode === mode;
}

// ---------- daily backups ----------
export const BACKUP_DIR = 'backups';
const BACKUP_RE = /^copybot-backup-(\d{4}-\d{2}-\d{2})\.json$/;

/** The automatic backups, newest first. */
export function listBackups(dir = BACKUP_DIR): { file: string; day: string; size: number }[] {
  try {
    return fs
      .readdirSync(dir)
      .map((f) => ({ f, m: BACKUP_RE.exec(f) }))
      .filter((x) => x.m)
      .map((x) => ({ file: path.join(dir, x.f), day: x.m![1], size: fs.statSync(path.join(dir, x.f)).size }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  } catch {
    return [];
  }
}

const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Write today's backup if there isn't one yet, and keep only the newest `keep`. Returns the file written, or null. */
export function dailyBackup(build: () => unknown, now = Date.now(), keep = 7, dir = BACKUP_DIR): string | null {
  const day = dayOf(now);
  let wrote: string | null = null;
  if (!listBackups(dir).some((b) => b.day === day)) {
    fs.mkdirSync(dir, { recursive: true });
    wrote = path.join(dir, `copybot-backup-${day}.json`);
    writeAtomic(wrote, JSON.stringify(build()));
  }
  for (const old of listBackups(dir).slice(keep)) fs.rmSync(old.file, { force: true });
  return wrote;
}

// ---------- old copies ----------
/** Keep only the newest `keep` files in `dir` whose names match `re` (by modified time). */
export function keepNewest(dir: string, re: RegExp, keep: number): number {
  let removed = 0;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(keep)) {
      fs.rmSync(path.join(dir, x.f), { force: true });
      removed++;
    }
  } catch {
    /* nothing to trim */
  }
  return removed;
}

/** Trim the copies that pile up over months of use. */
export function trimOldCopies(): number {
  return keepNewest('data', /^state-paper\.reset-\d+\.json$/, 5) + keepNewest('data', /^trades-paper\.reset-\d+\.jsonl$/, 5) + keepNewest('data', /^backup-before-restore-.+\.json$/, 5);
}

// ---------- unexpected errors ----------
/** Counts unexpected errors in a sliding minute; too many in a row means something is badly wrong. */
export class ErrorBurst {
  private times: number[] = [];
  constructor(
    private limit = 20,
    private windowMs = 60_000,
  ) {}
  /** Note one error; true when there have been more than `limit` in the last minute. */
  hit(now = Date.now()): boolean {
    this.times = [...this.times.filter((t) => now - t < this.windowMs), now];
    return this.times.length > this.limit;
  }
}
