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
  JSON.stringify({ mode: 'paper', wallets: [...world.wallets.map((w, i) => ({ address: w.address, label: `w${i}`, enabled: true, sizeMultiplier: 1, maxExposureSol: 0 })), { chain: 'base', address: baseWallet, label: 'base-1', enabled: false, sizeMultiplier: 1, maxExposureSol: 0 }], ai: { enabled: true, provider: 'ollama', ollamaUrl: `http://127.0.0.1:${worldPort}`, ollamaFast: 'fake:7b' } }),
);
// A little AI history, so the Autopilot page's scorecard, setups and notes cards have something to show.
{
  const t0 = Date.now() - 3 * 86_400_000;
  const lines = [];
  for (let i = 0; i < 48; i++) {
    const model = i < 24 ? 'ollama:qwen2.5:7b' : 'ollama:fake:7b';
    const buy = i % 3 !== 0;
    const pct = buy ? (i % 2 ? 25 : -15) : i < 24 ? 30 : -45;
    lines.push(JSON.stringify({ id: `seed${i}`, t: t0 + i * 3_600_000, kind: 'buy', verdict: buy ? 'buy' : 'skip', reason: 'seed', symbol: `S${i}`, costUsd: 0, probe: { lamports: '100000000', tokensOut: '1000' }, baseSol: 0.1, size: buy ? 1 : 0, model, outcomePct: pct }));
  }
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/ai-decisions.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'data/ai-notes.json'), JSON.stringify({ lastAt: Date.now() - 2 * 3_600_000, removed: [], notes: [{ id: 'n1', at: Date.now() - 2 * 3_600_000, text: 'Skip coins under 10 minutes old unless liquidity is over $50k.', basedOn: '5 of 6 such buys fell within the hour' }] }));
}
const bs58 = (await import('bs58')).default;
const { Keypair } = createRequire(import.meta.url)('@solana/web3.js');
fs.writeFileSync(path.join(dir, '.env'), `PRIVATE_KEY=${bs58.encode(Keypair.generate().secretKey)}\n`);
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

const shots = process.argv.find((a) => a.startsWith('--shots='))?.slice(8); // save screenshots of the go-live steps here
const shot = (n) => (shots ? page.screenshot({ path: path.join(shots, `golive-${n}.png`) }) : null);
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
// Settings → Automation: with the local AI picked, its own settings show and Claude's are hidden.
await page.click('.nav[data-page="settings"]');
await page.waitForTimeout(600);
await page.click('#set-tabs [data-tab="automation"]');
await page.waitForTimeout(300);
const aiFields = await page.evaluate(() => ({
  fast: document.querySelector('[data-k="ai.ollamaFast"]')?.value,
  fastShown: !document.querySelector('[data-k="ai.ollamaFast"]')?.closest('.field')?.hidden,
  claudeShown: !document.querySelector('[data-k="ai.claudeModel"]')?.closest('.field')?.hidden,
}));
if (aiFields.fast !== 'fake:7b' || !aiFields.fastShown || aiFields.claudeShown) errors.push(`Autopilot settings don't follow the chosen AI: ${JSON.stringify(aiFields)}`);
if (shots) await (await page.$('#ai-settings'))?.screenshot({ path: path.join(shots, 'ai-settings.png') });
// Autopilot page: the AI's scorecard, setups and its own notes.
await page.click('.nav[data-page="autopilot"]');
await page.waitForTimeout(1200);
const aiCards = await page.evaluate(() => ({ score: !!document.querySelector('#ai-score'), notes: document.body.innerText.includes('Skip coins under 10 minutes old'), setups: document.body.innerText.includes('Compare AI setups') }));
if (!aiCards.score || !aiCards.notes || !aiCards.setups) errors.push(`Autopilot cards missing: ${JSON.stringify(aiCards)}`);
if (shots) await page.screenshot({ path: path.join(shots, 'autopilot.png'), fullPage: true });
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
// The setup wizard (Settings → App → Run setup again): all 5 steps open, with the new ones in place.
await page.evaluate(() => window.openSettings?.('#look-seg'));
await page.waitForTimeout(600);
await page.click('#wz-again');
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(400);
  await shot(`wizard-${i + 1}`);
  if (i === 1 && !(await page.$('#wz-base'))) errors.push('the wizard has no Base step');
  if (i === 3 && !(await page.$('#wz-resume'))) errors.push('the wizard has no "running all day" step');
  if (i < 4) await page.click('#wz-next');
}
await page.click('#wz-skip');
await page.waitForTimeout(400);

// The Autopilot page with the local AI: the installed models are listed, and the test answers.
await page.click('.nav[data-page="autopilot"]');
await page.waitForTimeout(1500);
const fastOpts = await page.$$eval('#ai-fast option', (o) => o.map((x) => x.value)).catch(() => []);
if (!fastOpts.includes('fake:7b')) errors.push(`the local models aren't listed on the Autopilot page (${fastOpts.join(', ') || 'none'})`);
await shot('ai');
await page.click('#ai-test');
await page.waitForFunction(() => /answered in|✕/.test(document.querySelector('#ai-msg')?.textContent || ''), null, { timeout: 30_000 }).catch(() => errors.push('the local AI test never answered'));
const testMsg = await page.textContent('#ai-msg').catch(() => '');
if (!/fake:7b answered in/.test(testMsg)) errors.push(`the local AI test said: ${testMsg.trim().slice(0, 120)}`);

// The go-live assistant: opens from Settings → Live, walks its 5 steps, runs a test trade
// (the fake market can't execute swaps, so it must fail cleanly), switches to live, and undoes the starter limits.
await page.evaluate(() => window.openSettings?.('#mode-card'));
await page.waitForTimeout(700);
await page.click('#mode-seg [data-m="live"]');
await page.waitForSelector('#gl-next', { timeout: 15_000 }).catch(() => errors.push('the go-live assistant did not open'));
for (let i = 0; i < 3; i++) {
  if (!(await page.$('#gl-next'))) break;
  await shot(i + 1);
  await page.click('#gl-next');
  await page.waitForTimeout(400);
}
if (await page.$('[data-gltest="solana"]')) {
  await page.click('[data-gltest="solana"]');
  await page.click('#modal-root [data-a=yes]');
  await page.waitForFunction(() => !document.querySelector('[data-gltest]')?.disabled, null, { timeout: 60_000 }).catch(() => errors.push('the test trade never finished'));
  await shot(4);
  const res = await page.textContent('.wz-body');
  if (!/Failed at the|Worked in/.test(res)) errors.push('the test trade showed no result');
} else errors.push('no Solana test-trade button');
await page.click('#gl-next');
await page.waitForTimeout(400);
await shot(5);
if (!(await page.$('#gl-go'))) errors.push('no Switch to live button on the last step');
else {
  await page.click('#gl-go');
  await page.click('#modal-root [data-a=yes]');
  await page.waitForTimeout(1500);
  if (await page.$('#modal-root [data-a=no]')) await page.click('#modal-root [data-a=no]'); // don't start the bot
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  if (cfg.mode !== 'live') errors.push(`after the switch the mode is ${cfg.mode}`);
  if (!(cfg.buy?.fixedSol <= 0.25)) errors.push(`starter limits not applied (per trade ${cfg.buy?.fixedSol})`);
  if (!fs.existsSync(path.join(dir, 'data/golive.json'))) errors.push('the normal limits were not saved');
  // Live now: the Dashboard shows "Paper vs live".
  await page.click('.nav[data-page="dashboard"]');
  await page.waitForTimeout(1500);
  const pvl = await page.textContent('#pvl-card').catch(() => '');
  if (!/Paper vs live/.test(pvl) || !/No live trades yet/.test(pvl)) errors.push(`no "Paper vs live" card in live mode (${pvl.slice(0, 80)})`);
  await page.evaluate(() => window.openSettings?.('#mode-card'));
  await page.waitForTimeout(1200);
  if (!(await page.$('#gl-restore'))) errors.push('no "bring back my normal limits" button in live mode');
  else {
    await page.click('#gl-restore');
    await page.click('#modal-root [data-a=yes]');
    await page.waitForTimeout(1200);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (after.risk?.maxOpenPositions === 3 && cfg.risk?.maxOpenPositions === 3) errors.push('normal limits were not restored');
  }
}

await browser.close();
child.kill('SIGKILL');
world.close();
console.log(`${pages.length} pages opened, ${errors.length} problems`);
for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ✗ ' + e);
process.exit(errors.length ? 1 : 0);
