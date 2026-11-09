import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBackup, checkBackup, restoreBackup, safeBackupPath } from './backup';

test('safeBackupPath: only config.json and files directly in data/', () => {
  for (const ok of ['config.json', 'data/trades.jsonl', 'data/state-paper.json', 'data/orders-live.json']) assert.equal(safeBackupPath(ok), true, ok);
  for (const bad of ['.env', 'data/../.env', '../config.json', 'data/history/x.json', '/etc/passwd', 'data/x.tmp', 'data/.env', 'ui/index.html', 'data/backup-before-restore-1.json', 5]) assert.equal(safeBackupPath(bad), false, String(bad));
});

test('backup, check and restore round trip; never includes secrets; keeps a safety copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-backup-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync('data/history', { recursive: true });
    fs.writeFileSync('config.json', JSON.stringify({ mode: 'paper', wallets: [{ address: 'A' }] }));
    fs.writeFileSync('.env', 'PRIVATE_KEY=secret');
    fs.writeFileSync('data/trades.jsonl', '{"t":1}\n');
    fs.writeFileSync('data/history/w.json', '{}');
    const b = buildBackup('0.8.2', 1);
    assert.deepEqual(Object.keys(b.files).sort(), ['config.json', 'data/trades.jsonl']);
    assert.ok(!JSON.stringify(b).includes('secret'));
    // Restore into a changed folder.
    fs.writeFileSync('config.json', JSON.stringify({ mode: 'live' }));
    const c = checkBackup(JSON.parse(JSON.stringify(b)));
    assert.ok('files' in c);
    const safety = restoreBackup((c as any).files, '0.8.2', 2);
    assert.equal(JSON.parse(fs.readFileSync('config.json', 'utf8')).mode, 'paper');
    assert.equal(JSON.parse(JSON.parse(fs.readFileSync(safety, 'utf8')).files['config.json']).mode, 'live'); // the undo copy
    assert.equal(fs.readFileSync('.env', 'utf8'), 'PRIVATE_KEY=secret'); // untouched
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBackup refuses other files, bad paths, damaged JSON and newer versions', () => {
  const base = { format: 'copybot-backup', version: 1, appVersion: '0.8.2', createdAt: 1, files: { 'config.json': '{}' } };
  assert.ok('files' in checkBackup(base));
  assert.match((checkBackup({ hello: 1 }) as any).error, /isn't a Copybot backup/);
  assert.match((checkBackup({ ...base, version: 2 }) as any).error, /newer Copybot/);
  assert.match((checkBackup({ ...base, files: { ...base.files, '.env': 'x' } }) as any).error, /doesn't restore/);
  assert.match((checkBackup({ ...base, files: { ...base.files, 'data/../../evil': 'x' } }) as any).error, /doesn't restore/);
  assert.match((checkBackup({ ...base, files: { 'config.json': '{nope' } }) as any).error, /damaged/);
  assert.match((checkBackup({ ...base, files: { 'data/trades.jsonl': '' } }) as any).error, /no settings/);
});
