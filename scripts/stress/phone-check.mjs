// Pairs a (simulated) phone with the real app running against the made-up market, opens every tab
// of the phone page, pauses a wallet from the phone, and reports script errors. Not part of the app.
//   node scripts/stress/phone-check.mjs [--shots=dir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWorld } from './world.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const shots = process.argv.find((a) => a.startsWith('--shots='))?.slice(8);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-phone-'));
const world = createWorld({ chaos: 0, wallets: 6, baseWallets: 3, coins: 30 });
const worldPort = await world.listen();
const port = 5300 + Math.floor(Math.random() * 90);
const phonePort = port + 200;
fs.writeFileSync(
  path.join(dir, 'config.json'),
  JSON.stringify({
    mode: 'paper',
    wallets: [
      ...world.wallets.map((w, i) => ({ address: w.address, label: `sol-${i}`, enabled: true, sizeMultiplier: 1, maxExposureSol: 0 })),
      ...world.baseWallets.map((w, i) => ({ chain: 'base', address: w.address, label: `base-${i}`, enabled: i > 0, ...(i === 0 ? { shadow: true } : {}), sizeMultiplier: 1, maxExposureSol: 0 })),
    ],
    scanner: { findTraders: false, tradeCoins: false, trackSignals: false },
    execution: { fastStream: false },
    risk: { moodFilter: false, pauseAfterLosses: 0, maxOpenPositions: 8 },
    monitor: { pollIntervalSec: 2, exitCheckIntervalSec: 5 },
  }),
);
const child = spawn(process.execPath, [path.join(root, 'dist/server.mjs')], {
  cwd: dir,
  env: { ...process.env, NO_OPEN: '1', PORT: String(port), RPC_URL: `http://127.0.0.1:${worldPort}/rpc`, BASE_RPC_URL: `http://127.0.0.1:${worldPort}/evm`, STRESS_WORLD_PORT: String(worldPort), NODE_OPTIONS: `--import ${path.join(here, 'intercept.mjs')} --import ${path.join(here, 'fake-lan.mjs')}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '', token = null;
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 100 && !token; i++) {
  await new Promise((r) => setTimeout(r, 200));
  token = out.match(/[?&]t=([A-Za-z0-9_-]+)/)?.[1] ?? null;
}
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-copybot-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
};
const errors = [];
try {
  await api('PUT', '/api/remote', { enabled: true, port: phonePort, tailscaleOnly: false });
  await api('POST', '/api/start');
  const pair = await api('POST', '/api/remote/pair');
  const code = pair.links[0].url.split('#pair=')[1];
  console.log('Phone access on; letting the bot trade for 60 s…');
  await new Promise((r) => setTimeout(r, 60_000));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`script error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await page.goto(`http://127.0.0.1:${phonePort}/#pair=${code}`);
  await page.click('#pgo');
  await page.waitForSelector('#runbtn', { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const shot = (n) => (shots ? page.screenshot({ path: path.join(shots, `phone-${n}.png`), fullPage: true }) : null);
  await shot('1-home');
  const home = await page.textContent('#app');
  if (!/Today/.test(home)) errors.push('no Today card');
  for (const t of ['wallets', 'trades', 'activity']) {
    await page.click(`[data-tab="${t}"]`);
    await page.waitForTimeout(500);
    await shot(`2-${t}`);
  }
  await page.click('[data-tab="wallets"]');
  const w = await page.textContent('#app');
  if (!/Shadow/.test(w)) errors.push('the shadow wallet is not shown as Shadow');
  if (!/Base/.test(w)) errors.push('no Base label on the wallets tab');
  if (/[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-f]{40}/.test(w)) errors.push('a wallet address is shown on the phone');
  const act = await page.$eval('[data-tab="activity"]', () => 1).catch(() => 0);
  if (!act) errors.push('no Activity tab');
  // Pause the first copied wallet from the phone.
  page.once('dialog', (d) => d.accept());
  const pauseBtn = await page.$('[data-pause]');
  if (!pauseBtn) errors.push('no Pause button');
  else {
    const name = await pauseBtn.getAttribute('data-name');
    await pauseBtn.click();
    await page.waitForTimeout(2500);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    const wl = cfg.wallets.find((x) => x.label === name);
    if (wl?.enabled !== false || !/paused from/.test(wl?.pausedReason ?? '')) errors.push(`pausing ${name} from the phone didn't work`);
  }
  await page.click('[data-tab="positions"]');
  await page.waitForTimeout(6000); // coin names arrive in the background
  await shot('3-positions-later');
  const pos = await page.textContent('#app');
  if (/Positions \((\d+)\)/.exec(pos)?.[1] !== '0' && !/\b[CB]\d+\b/.test(pos)) errors.push('positions show no coin names');
  await browser.close();

  // Write off an open position (as for a rugged coin), then reset paper mode: everything starts again.
  let st = await api('GET', '/api/state');
  const victim = st.status.positions[0];
  if (victim) {
    const before = st.status.realizedPnlSol;
    await api('POST', '/api/positions/writeoff', { mint: victim.mint });
    st = await api('GET', '/api/state');
    if (st.status.positions.some((p) => p.mint === victim.mint)) errors.push('the written-off position is still open');
    if (Math.abs(st.status.realizedPnlSol - (before - victim.costSol)) > 1e-6) errors.push(`write-off booked ${st.status.realizedPnlSol - before}, expected ${-victim.costSol}`);
  } else errors.push('no open position to write off');
  await api('POST', '/api/stop');
  await api('POST', '/api/paper/reset');
  st = await api('GET', '/api/state');
  if (st.status.positions.length || st.status.realizedPnlSol !== 0) errors.push('paper reset left positions or profit');
  if (fs.existsSync(path.join(dir, 'data/series-paper.json'))) errors.push('paper reset left the wallet chart');
  if (st.trades.some((t) => t.mode === 'paper')) errors.push('paper reset left paper trades');
} catch (e) {
  errors.push(e.message);
}
child.kill('SIGKILL');
world.close();
console.log(`Phone page: ${errors.length} problems`);
for (const e of [...new Set(errors)]) console.log('  ✗ ' + e);
process.exit(errors.length ? 1 : 0);
