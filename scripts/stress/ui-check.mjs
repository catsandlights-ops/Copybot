// Opens every page of the real app (against the made-up market) in a headless browser and reports
// any script error, plus a Base coin on the Orders page and both chains' wallets. Not part of the app.
//   node scripts/stress/ui-check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createWorld } from './world.mjs';

// Playwright: the project's copy if installed, else the machine's global one.
const { chromium } = createRequire(import.meta.url)('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-ui-'));
const world = createWorld({ chaos: 0, wallets: 3, coins: 10 });
const worldPort = await world.listen();
const port = 5100 + Math.floor(Math.random() * 90);
const baseWallet = '0x' + 'ab'.repeat(20);
fs.writeFileSync(
  path.join(dir, 'config.json'),
  JSON.stringify({ mode: 'paper', wallets: [...world.wallets.map((w, i) => ({ address: w.address, label: `w${i}`, enabled: true, sizeMultiplier: 1, maxExposureSol: 0 })), { chain: 'base', address: baseWallet, label: 'base-1', enabled: false, sizeMultiplier: 1, maxExposureSol: 0 }] }),
);
const child = spawn(process.execPath, [path.join(root, 'dist/server.mjs')], {
  cwd: dir,
  env: { ...process.env, NO_OPEN: '1', PORT: String(port), RPC_URL: `http://127.0.0.1:${worldPort}/rpc`, STRESS_WORLD_PORT: String(worldPort), NODE_OPTIONS: `--import ${path.join(here, 'intercept.mjs')}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '', url = null;
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 100 && !url; i++) {
  await new Promise((r) => setTimeout(r, 200));
  url = out.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\S*[?&]t=[A-Za-z0-9_-]+/)?.[0] ?? null;
}
if (!url) throw new Error('the app did not start:\n' + out.slice(-2000));

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => errors.push(`script error: ${e.message} @ ${(e.stack || '').split('\n').slice(1, 3).join(' ').trim()}`));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
await page.goto(url);
await page.waitForTimeout(1500);
const pages = await page.$$eval('[data-page]', (b) => [...new Set(b.map((x) => x.dataset.page))]);
for (const p of pages) {
  await page.click(`.nav[data-page="${p}"]`).catch(() => page.evaluate((x) => window.go?.(x), p));
  await page.waitForTimeout(700);
}
// The Base wallet shows a Shadow button.
await page.click('.nav[data-page="wallets"]');
await page.waitForTimeout(600);
const shadowOk = await page.$(`[data-shadow="start"][data-addr="${baseWallet}"]`);
if (!shadowOk) errors.push('no Shadow button for the paused Base wallet');
// A Base coin on the Orders page is accepted (looked up, not ignored).
await page.click('.nav[data-page="orders"]');
await page.waitForTimeout(600);
await page.fill('#of-mint', '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01');
await page.dispatchEvent('#of-mint', 'change');
await page.waitForTimeout(1200);
const tok = await page.textContent('#of-tok').catch(() => '');
if (!tok?.trim()) errors.push('a Base coin on the Orders page was not looked up');
// The watchlist tab exists on the Markets page.
await page.click('.nav[data-page="markets"]');
await page.waitForTimeout(600);
if (!(await page.$('[data-mtab="watch"]'))) errors.push('no watchlist tab on Markets');

await browser.close();
child.kill('SIGKILL');
world.close();
console.log(`${pages.length} pages opened, ${errors.length} problems`);
for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ✗ ' + e);
process.exit(errors.length ? 1 : 0);
