import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dailyBackup, ErrorBurst, keepNewest, listBackups, readRunState, saveRunState, shouldResume } from './upkeep';

const inTemp = (fn: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-upkeep-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    fn(dir);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('resume: only after an unexpected stop, in the same mode, with the setting on', () => {
  inTemp(() => {
    assert.equal(readRunState(), null);
    saveRunState(true, 'paper', 1);
    assert.deepEqual(readRunState(), { running: true, mode: 'paper', at: 1 });
    assert.equal(shouldResume(readRunState(), 'paper', true), true);
    assert.equal(shouldResume(readRunState(), 'paper', false), false, 'setting off');
    assert.equal(shouldResume(readRunState(), 'live', true), false, 'never resumes into a different mode');
    saveRunState(false, 'paper', 2); // you stopped it
    assert.equal(shouldResume(readRunState(), 'paper', true), false);
    assert.equal(shouldResume(null, 'paper', true), false);
  });
});

test('dailyBackup: one a day, newest 7 kept', () => {
  inTemp(() => {
    const day = 86_400_000;
    const t0 = new Date(2026, 10, 1, 12).getTime();
    let built = 0;
    const build = () => ({ n: ++built });
    assert.ok(dailyBackup(build, t0));
    assert.equal(dailyBackup(build, t0 + 3_600_000), null, 'only one a day');
    for (let i = 1; i <= 9; i++) dailyBackup(build, t0 + i * day);
    const list = listBackups();
    assert.equal(list.length, 7);
    assert.equal(list[0].day, '2026-11-10');
    assert.equal(list[6].day, '2026-11-04');
    assert.equal(built, 10);
    assert.deepEqual(JSON.parse(fs.readFileSync(list[0].file, 'utf8')), { n: 10 });
  });
});

test('keepNewest: trims old copies, leaves other files', () => {
  inTemp(() => {
    fs.mkdirSync('data');
    for (let i = 0; i < 8; i++) {
      const f = path.join('data', `state-paper.reset-${i}.json`);
      fs.writeFileSync(f, '{}');
      fs.utimesSync(f, i, i);
    }
    fs.writeFileSync('data/state-paper.json', '{}');
    assert.equal(keepNewest('data', /^state-paper\.reset-\d+\.json$/, 5), 3);
    const left = fs.readdirSync('data').sort();
    assert.ok(left.includes('state-paper.json'));
    assert.ok(!left.includes('state-paper.reset-0.json') && left.includes('state-paper.reset-7.json'));
    assert.equal(keepNewest('nope', /x/, 1), 0);
  });
});

test('ErrorBurst: more than 20 unexpected errors in a minute', () => {
  const b = new ErrorBurst(20, 60_000);
  for (let i = 0; i < 20; i++) assert.equal(b.hit(1000 + i), false);
  assert.equal(b.hit(1100), true);
  assert.equal(b.hit(200_000), false, 'old ones fall out of the window');
});
