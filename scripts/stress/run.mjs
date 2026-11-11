// Stress test: the real app, on Solana and Base, (dist/server.mjs) against a made-up market, with chaos, killed and
// restarted at random, its books checked every 30 s. Not part of the app.
//   node scripts/stress/run.mjs [minutes=20] [--kill-every=6] [--chaos=0.05] [--wallets=8] [--base-wallets=4]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './world.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const minutes = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 20);
const killEveryMin = Number(args['kill-every'] ?? 6);
const dir = args.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-stress-'));
const port = 4900 + Math.floor(Math.random() * 90);

const world = createWorld({ chaos: Number(args.chaos ?? 0.05), wallets: Number(args.wallets ?? 8), coins: Number(args.coins ?? 40), baseWallets: Number(args['base-wallets'] ?? 4) });
const worldPort = await world.listen();
fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
const cfg = {
  mode: 'paper',
  wallets: [
    ...world.wallets.map((w, i) => ({ address: w.address, label: `fake-${i}`, enabled: true, sizeMultiplier: 1, maxExposureSol: 0 })),
    ...world.baseWallets.map((w, i) => ({ chain: 'base', address: w.address, label: `base-${i}`, enabled: true, sizeMultiplier: 1, maxExposureSol: 0 })),
  ],
  scanner: { findTraders: false, tradeCoins: false, trackSignals: false },
  execution: { fastStream: false },
  // The fake traders are random, so the money-safety pauses would soon (correctly) stop buying for
  // hours. They're off here so the test keeps trading; the pause itself is covered by unit tests.
  risk: { moodFilter: false, pauseAfterLosses: 0, dailyLossLimitSol: 0, panicLossSol: 0 },
  trial: { enabled: false },
  monitor: { pollIntervalSec: 2, exitCheckIntervalSec: 5 },
  paper: { startSol: 10 },
};
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

const problems = [];
const problem = (what) => {
  if (!problems.some((p) => p.what === what)) console.log(`  ✗ ${what}`);
  problems.push({ at: new Date().toISOString(), what });
};
let app = null, token = null, starts = 0, crashes = 0, kills = 0;
const logFile = path.join(dir, 'app.log');

function startApp() {
  return new Promise((resolve) => {
    starts++;
    token = null;
    const child = spawn(process.execPath, [path.join(root, 'dist/server.mjs')], {
      cwd: dir,
      env: { ...process.env, NO_OPEN: '1', PORT: String(port), RPC_URL: `http://127.0.0.1:${worldPort}/rpc`, BASE_RPC_URL: `http://127.0.0.1:${worldPort}/evm`, STRESS_WORLD_PORT: String(worldPort), NODE_OPTIONS: `--import ${path.join(here, 'intercept.mjs')}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    const onData = (d) => {
      out.write(d);
      const m = String(d).match(/[?&]t=([A-Za-z0-9_-]+)/);
      if (m && !token) {
        token = m[1];
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => out.write(d));
    child.on('exit', (code, sig) => {
      if (app === child) {
        app = null;
        if (sig !== 'SIGKILL') {
          crashes++;
          problem(`the app exited by itself (code ${code}, signal ${sig})`);
        }
      }
    });
    app = child;
  });
}
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-copybot-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  return r.json();
};
const read = (f) => {
  try {
    return fs.readFileSync(path.join(dir, f), 'utf8');
  } catch {
    return null;
  }
};

/** The checks that must always hold, whatever happens. */
async function check(label) {
  let st;
  try {
    st = await api('GET', '/api/state');
  } catch (e) {
    return problem(`the app didn't answer (${e.message})`);
  }
  const state = JSON.parse(read('data/state-paper.json') ?? '{"positions":{},"realizedPnlSol":0}');
  const trades = (read('data/trades.jsonl') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((t) => t.mode === 'paper');
  const sells = trades.filter((t) => t.side === 'sell');
  const pnlSum = sells.reduce((a, t) => a + (t.pnl ?? 0), 0);
  // 1. Realized profit equals the sum of every sale's profit.
  if (Math.abs(pnlSum - state.realizedPnlSol) > 1e-6) problem(`profit doesn't add up: books ${state.realizedPnlSol} vs sales ${pnlSum}`);
  // 2. Every open position equals its buys minus its sells since it was last emptied.
  const run = new Map();
  for (const t of trades) {
    const r = run.get(t.mint) ?? 0n;
    if (t.side === 'buy') run.set(t.mint, r + BigInt(t.tokenRaw));
    else if (t.sig === 'NONE') run.set(t.mint, 0n); // written off / vanished
    else {
      const left = r - BigInt(t.tokenRaw);
      run.set(t.mint, left < 0n ? 0n : left);
    }
  }
  for (const [mint, p] of Object.entries(state.positions)) {
    if (!/^\d+$/.test(p.amountRaw) || !Number.isFinite(p.costSol) || p.costSol < -1e-9) problem(`bad numbers in a position: ${JSON.stringify(p).slice(0, 160)}`);
    const expect = run.get(mint) ?? 0n;
    if (BigInt(p.amountRaw) !== expect) problem(`position ${mint.slice(0, 6)} holds ${p.amountRaw} but its trades add up to ${expect}`);
  }
  for (const [mint, left] of run) if (left > 0n && !state.positions[mint]) problem(`trades leave ${left} of ${mint.slice(0, 6)} but there's no position`);
  // 3. The paper wallet never goes below zero; nothing is NaN.
  const free = st.status?.paper?.freeSol;
  if (!(Number.isFinite(free) && free > -1e-6)) problem(`paper wallet free SOL is ${free}`);
  if (!Number.isFinite(st.status?.realizedPnlSol)) problem(`realized profit is ${st.status?.realizedPnlSol}`);
  // 4. Memory.
  const mem = app?.pid ? Number(fs.readFileSync(`/proc/${app.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024 : 0;
  if (mem > 700) problem(`memory use is ${mem.toFixed(0)} MB`);
  const log = read('app.log') ?? '';
  const errs = log.split('\n').filter((l) => /\bError\b|TypeError|ReferenceError|Unhandled|uncaught/i.test(l) && !/ws error|DeprecationWarning/.test(l));
  console.log(`${label}: ${trades.filter((t) => t.side === 'buy').length} buys, ${sells.length} sells, ${Object.keys(state.positions).length} open (${Object.values(state.positions).filter((p) => p.chain === 'base').length} Base), profit ${state.realizedPnlSol.toFixed(4)} SOL, free ${Number(free).toFixed(3)} SOL, ${mem.toFixed(0)} MB, ${errs.length} error lines | market: ${world.stats.txs} trades (${world.stats.baseTxs} Base), ${world.stats.rugs} rugs, ${world.stats.chaos429} 429s`);
  return errs;
}

console.log(`Stress test for ${minutes} min in ${dir} (kill every ~${killEveryMin} min)`);
await startApp();
await api('POST', '/api/start');
const end = Date.now() + minutes * 60_000;
let nextKill = Date.now() + killEveryMin * 60_000 * (0.5 + Math.random());
let lastErrs = [];
while (Date.now() < end) {
  await new Promise((r) => setTimeout(r, 30_000));
  if (!app) {
    await startApp();
    await api('POST', '/api/start').catch(() => {});
  }
  lastErrs = (await check(`${Math.round((Date.now() - (end - minutes * 60_000)) / 60_000)} min`)) ?? lastErrs;
  if (killEveryMin > 0 && Date.now() > nextKill) {
    // Crash it at a random moment, restart, and check the books survived.
    kills++;
    const victim = app;
    app = null;
    victim.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 1500));
    await startApp();
    await api('POST', '/api/start').catch(() => {});
    await new Promise((r) => setTimeout(r, 5000));
    await check('  after a crash + restart');
    nextKill = Date.now() + killEveryMin * 60_000 * (0.5 + Math.random());
  }
}
await check('final');
app?.kill('SIGKILL');
world.close();
const uniq = [...new Set(lastErrs.map((l) => l.replace(/^\d\d:\d\d:\d\d /, '').replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, 'X').slice(0, 180)))];
console.log(`\nDone: ${starts} starts, ${kills} forced crashes, ${crashes} crashes by itself, ${problems.length} broken rules (${new Set(problems.map((p) => p.what)).size} different).`);
for (const p of [...new Set(problems.map((p) => p.what))]) console.log(`  ✗ ${p}`);
if (uniq.length) console.log(`Error lines (${uniq.length} different):\n  ${uniq.slice(0, 25).join('\n  ')}`);
console.log(`Folder: ${dir}`);
process.exit(problems.length ? 1 : 0);
