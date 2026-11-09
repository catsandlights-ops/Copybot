/**
 * Backup and restore: everything that makes your Copybot yours, in one file. Secrets (your
 * trading wallet's private key, API keys) are never included, so a backup can't leak your money.
 * The wallet-history cache isn't included either (it's large, and downloaded again when needed).
 */
import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_FORMAT = 'copybot-backup';
export type BackupFile = { format: typeof BACKUP_FORMAT; version: 1; appVersion: string | null; createdAt: number; files: Record<string, string> };

/** Only Copybot's own files: config.json and files directly in data/ (no folders, no "..", no secrets). */
export function safeBackupPath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (p === 'config.json') return true;
  return /^data\/[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(p) && !p.includes('..') && !/\.(tmp|env)$/i.test(p) && !/^data\/backup-/.test(p);
}

/** Collect the files to back up from the current folder. */
export function buildBackup(appVersion: string | null, now = Date.now()): BackupFile {
  const files: Record<string, string> = {};
  const add = (p: string) => {
    try {
      if (safeBackupPath(p) && fs.statSync(p).isFile()) files[p] = fs.readFileSync(p, 'utf8');
    } catch {
      /* missing: skip */
    }
  };
  add('config.json');
  let names: string[] = [];
  try {
    names = fs.readdirSync('data');
  } catch {
    /* no data yet */
  }
  for (const n of names) add(`data/${n}`);
  return { format: BACKUP_FORMAT, version: 1, appVersion, createdAt: now, files };
}

/** Check an uploaded backup before restoring anything. Returns the files to write, or an error. */
export function checkBackup(b: any, maxBytes = 60_000_000): { files: Record<string, string> } | { error: string } {
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) return { error: "This isn't a Copybot backup file." };
  if (b.version !== 1) return { error: 'This backup was made by a newer Copybot. Update Copybot first, then restore it.' };
  if (!b.files || typeof b.files !== 'object') return { error: 'The backup file is damaged (no files in it).' };
  const files: Record<string, string> = {};
  let size = 0;
  for (const [p, v] of Object.entries(b.files)) {
    if (!safeBackupPath(p)) return { error: `The backup contains a file Copybot doesn't restore (${String(p).slice(0, 60)}).` };
    if (typeof v !== 'string') return { error: `The backup file is damaged (${p}).` };
    size += v.length;
    if (size > maxBytes) return { error: 'The backup is too large to restore.' };
    if (p.endsWith('.json')) {
      try {
        JSON.parse(v);
      } catch {
        return { error: `The backup file is damaged (${p} isn't readable).` };
      }
    }
    files[p] = v;
  }
  if (!files['config.json']) return { error: 'The backup has no settings in it.' };
  return { files };
}

/** Write the files. Keeps a safety copy of what was there before, so a restore can be undone. */
export function restoreBackup(files: Record<string, string>, appVersion: string | null, now = Date.now()): string {
  fs.mkdirSync('data', { recursive: true });
  const safety = `data/backup-before-restore-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(safety, JSON.stringify(buildBackup(appVersion, now)));
  for (const [p, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + '.tmp', v);
    fs.renameSync(p + '.tmp', p);
  }
  return safety;
}
