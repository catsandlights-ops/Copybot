// The real app against the made-up market: killed while running, it must start the bot again by
// itself; killed after you stopped it, it must stay stopped; and it must make its daily backup.
// Not part of the app.   node scripts/stress/resume-check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './world.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-resume-'));
const world = createWorld({ chaos: 0, wallets: 3, coins: 10 });
const worldPort = await world.listen();
const port = 5500 + Math.floor(Math.random() * 90);
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'paper', wallets: world.wallets.map((w, i) => ({ address: w.address, label: `w${i}`, enabled: true, sizeMultiplier: 1, maxExposureSol: 0 })), scanner: { findTraders: false, tradeCoins: false, trackSignals: false }, execution: { fastStream: false } }));

let child = null, token = null;
async function startApp() {
  token = null;
  let out = '';
  child = spawn(process.execPath, [path.join(root, 'dist/server.mjs')], {
    cwd: dir,
    env: { ...process.env, NO_OPEN: '1', PORT: String(port), RPC_URL: `http://127.0.0.1:${worldPort}/rpc`, STRESS_WORLD_PORT: String(worldPort), NODE_OPTIONS: `--import ${path.join(here, 'intercept.mjs')}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !token; i++) {
    await new Promise((r) => setTimeout(r, 200));
    token = out.match(/[?&]t=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  }
}
const kill = async () => {
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
};
const api = async (method, p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-copybot-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const running = async () => {
  for (let i = 0; i < 20; i++) {
    const s = await api('GET', '/api/state');
    if (s.status.running) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
const errors = [];
try {
  await startApp();
  await api('POST', '/api/start');
  await kill(); // a crash while running
  await startApp();
  if (!(await running())) errors.push('after a crash while running, the bot did not start again by itself');
  const log = (await api('GET', '/api/state')).logs.map((l) => l.msg).join('\n');
  if (!/closed while the bot was running/.test(log)) errors.push('no log line saying why the bot started again');

  await api('POST', '/api/stop'); // you stopped it
  await kill();
  await startApp();
  await new Promise((r) => setTimeout(r, 3000));
  if ((await api('GET', '/api/state')).status.running) errors.push('after you stopped it, the bot started again by itself');

  await api('POST', '/api/start');
  await api('PUT', '/api/ui', { resumeBot: false }); // the switch off
  await kill();
  await startApp();
  await new Promise((r) => setTimeout(r, 3000));
  if ((await api('GET', '/api/state')).status.running) errors.push('with the switch off, the bot started again by itself');

  console.log('Waiting for the first daily backup (about a minute)…');
  await new Promise((r) => setTimeout(r, 65_000));
  const b = await api('GET', '/api/backups');
  if (!b.list?.length) errors.push('no daily backup after a minute');
  else {
    const j = JSON.parse(fs.readFileSync(path.join(dir, b.list[0].file), 'utf8'));
    if (j.format !== 'copybot-backup') errors.push('the daily backup is not a Remora backup file');
    if (/PRIVATE_KEY|\.env/.test(Object.keys(j.files ?? {}).join(' '))) errors.push('the daily backup contains keys');
  }
} catch (e) {
  errors.push(e.message);
}
child?.kill('SIGKILL');
world.close();
console.log(`Resume and backups: ${errors.length} problems`);
for (const e of errors) console.log('  ✗ ' + e);
process.exit(errors.length ? 1 : 0);
