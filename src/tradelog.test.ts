import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTradeLog } from './tradelog';

test('trade log: kept in memory, new lines picked up, a replaced file reloaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-tl-'));
  const f = path.join(dir, 'trades.jsonl');
  assert.deepEqual(readTradeLog(f), []); // no file yet
  fs.writeFileSync(f, '{"n":1}\n{"n":2}\n');
  assert.deepEqual(readTradeLog(f).map((t) => t.n), [1, 2]);
  fs.appendFileSync(f, '{"n":3}\n');
  assert.deepEqual(readTradeLog(f).map((t) => t.n), [1, 2, 3]);
  // A line still being written isn't read until it's complete.
  fs.appendFileSync(f, '{"n":4');
  assert.deepEqual(readTradeLog(f).map((t) => t.n), [1, 2, 3]);
  fs.appendFileSync(f, '}\n');
  assert.deepEqual(readTradeLog(f).map((t) => t.n), [1, 2, 3, 4]);
  // Changing what's returned doesn't change the memory copy.
  readTradeLog(f).pop();
  assert.equal(readTradeLog(f).length, 4);
  // Replaced (a reset): read again in full.
  fs.writeFileSync(f + '.tmp', '{"n":9}\n');
  fs.renameSync(f + '.tmp', f);
  assert.deepEqual(readTradeLog(f).map((t) => t.n), [9]);
  fs.rmSync(dir, { recursive: true, force: true });
});
