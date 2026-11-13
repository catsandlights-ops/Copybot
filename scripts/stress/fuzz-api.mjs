// Feeds every app endpoint junk (wrong types, empty, huge, negative, invalid addresses, long text,
// deep nesting) and reports anything that makes it error out (5xx) or crash. Not part of the app.
//   node scripts/stress/fuzz-api.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './world.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remora-fuzz-'));
const world = createWorld({ chaos: 0, wallets: 3, coins: 10 });
const worldPort = await world.listen();
const port = 5000 + Math.floor(Math.random() * 90);
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'paper', wallets: world.wallets.map((w, i) => ({ address: w.address, label: `w${i}`, enabled: true, sizeMultiplier: 1, maxExposureSol: 0 })) }));

let exited = null, token = null;
const child = spawn(process.execPath, [path.join(root, 'dist/server.mjs')], {
  cwd: dir,
  env: { ...process.env, NO_OPEN: '1', PORT: String(port), RPC_URL: `http://127.0.0.1:${worldPort}/rpc`, STRESS_WORLD_PORT: String(worldPort), NODE_OPTIONS: `--import ${path.join(here, 'intercept.mjs')}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.on('exit', (code, sig) => (exited = `${code}/${sig}`));
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 100 && !token; i++) {
  await new Promise((r) => setTimeout(r, 200));
  token = out.match(/[?&]t=([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

const src = fs.readdirSync(path.join(root, 'src')).filter((f) => /^server.*\.ts$/.test(f)).map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
const routes = [...new Set([...src.matchAll(/route === '(GET|POST|PUT|DELETE) ([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`))]
  .filter((r) => !r.includes(' /r/') && !r.endsWith('/update/install'));
const wallet = world.wallets[0].address, mint = world.coins[0].mint;
const long = 'x'.repeat(100_000);
let deep = {};
for (let i = 0; i < 200; i++) deep = { a: deep };
const bodies = [undefined, '', 'null', '[]', '"text"', '{', '{}', { address: 'nope' }, { address: wallet }, { address: wallet, action: 'zzz' }, { mint: 'nope', fraction: 5 }, { mint, fraction: -1 }, { sol: -1 }, { sol: 1e308 }, { sol: 'abc', fresh: 'yes' }, { at: 'x', feature: 1, bucket: null }, { kind: 'zzz', wallets: 'x', days: -3 }, { wallets: [long] }, deep, { mode: 'live', wallets: 'oops', buy: null }, { rpcUrl: 'javascript:alert(1)', baseKey: 'nope', privateKey: long }, { port: -1, enabled: 'x' }, { path: '../../etc/passwd' }];
const queries = ['', '?mint=nope', `?mint=${mint}&hours=-5`, '?range=zzz&limit=-1', `?mint=${'z'.repeat(5000)}`];

const fails = [];
let sent = 0;
for (const r of routes) {
  const [method, p] = r.split(' ');
  if (p === '/api/events') continue; // a live stream: stays open by design
  const variants = method === 'GET' || method === 'DELETE' ? queries.map((q) => [p + q, undefined]) : bodies.map((b) => [p, b]);
  for (const [url, body] of variants) {
    if (exited) break;
    sent++;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'x-copybot-token': token, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status >= 500) fails.push(`${res.status} ${method} ${url.slice(0, 60)} ${JSON.stringify(body)?.slice(0, 60) ?? ''} -> ${(await res.text()).slice(0, 120)}`);
    } catch (e) {
      if (e.name !== 'TimeoutError') fails.push(`no answer: ${method} ${url.slice(0, 60)} ${JSON.stringify(body)?.slice(0, 60) ?? ''} (${e.message})`);
    }
  }
  if (exited) {
    fails.push(`THE APP DIED (${exited}) after ${r}`);
    break;
  }
}
console.log(`${routes.length} endpoints, ${sent} junk requests, app ${exited ? `DIED (${exited})` : 'still running'}, ${fails.length} problems`);
for (const f of fails.slice(0, 40)) console.log('  ✗ ' + f);
child.kill('SIGKILL');
world.close();
process.exit(fails.length ? 1 : 0);
