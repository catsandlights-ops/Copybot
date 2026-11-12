/**
 * The local AI (Ollama) against a fake Ollama server: good answers are used; anything unexpected
 * (garbled, wrong format, missing model, too slow, not running) means no answer, so the bot falls
 * back to its rules and never trades bigger.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeConfig } from './config';

type Reply = { status?: number; content?: string; delayMs?: number };
let next: Reply[] = [];
const seen: any[] = [];
let server: http.Server;
let port = 0;
let ai: typeof import('./ai');
const prevDir = process.cwd();
let dir = '';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ollama-'));
  process.chdir(dir);
  fs.mkdirSync('data');
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', size: 4.7e9, details: { parameter_size: '7.6B' } }, { name: 'qwen2.5:14b', size: 9e9, details: { parameter_size: '14.8B' } }] }));
    }
    seen.push(JSON.parse(raw || '{}'));
    const r = next.shift() ?? { content: '{}' };
    if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'x', message: { role: 'assistant', content: r.content ?? '' }, done: true }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  ai = await import('./ai');
});
after(() => {
  server.close();
  process.chdir(prevDir);
  fs.rmSync(dir, { recursive: true, force: true });
});

const cfgWith = (ai: object) => sanitizeConfig({ ai: { enabled: true, provider: 'ollama', ollamaUrl: `http://127.0.0.1:${port}`, ollamaFast: 'qwen2.5:7b', ollamaSmart: 'qwen2.5:14b', ...ai } }, true);
const signal = () => ({
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'TEST',
  name: 'Test',
  wallet: { label: 'w', theirSol: 1, record: null },
  ourSol: 0.1,
  driftPct: 2,
  priceImpactPct: 0.5,
  market: null,
  portfolio: { openPositions: 0, maxPositions: 5, exposureSol: 0, maxExposureSol: 2, dayPnlSol: 0 },
  probe: { lamports: '100000000', tokensOut: '1000' },
});

test('settings: Ollama only on this computer; model names checked', () => {
  assert.equal(cfgWith({}).ai.provider, 'ollama');
  assert.throws(() => sanitizeConfig({ ai: { ollamaUrl: 'http://evil.example:11434' } }, true), /on this computer/);
  assert.throws(() => sanitizeConfig({ ai: { ollamaUrl: 'http://192.168.1.5:11434' } }, true), /on this computer/);
  assert.throws(() => sanitizeConfig({ ai: { ollamaFast: 'bad name; rm' } }, true), /model name/);
  assert.equal(sanitizeConfig({ ai: { claudeModel: 'claude-haiku-5-5' } }, true).ai.claudeModel, 'claude-haiku-5-5');
  assert.throws(() => sanitizeConfig({ ai: { claudeModel: 'gpt-5' } }, true));
});

test('the fast model decides buys, the smart model reviews', () => {
  const c = cfgWith({}).ai;
  assert.equal(ai.ollamaModelFor('buy', c), 'qwen2.5:7b');
  assert.equal(ai.ollamaModelFor('review', c), 'qwen2.5:14b');
  assert.equal(ai.ollamaModelFor('wallets', { ...c, ollamaSmart: '' }), 'qwen2.5:7b', 'falls back to the other model');
  assert.equal(ai.aiName(cfgWith({})), 'the local AI');
});

test('a good answer is used, for free, with the answer format sent to the model', async () => {
  next = [{ content: JSON.stringify({ decision: 'buy', size: 1.5, confidence: 'high', reason: 'Strong wallet, healthy liquidity.' }) }];
  const r = await ai.decideBuy(cfgWith({}), signal() as any);
  assert.ok(r);
  assert.equal(r!.buy, true);
  const req = seen.at(-1);
  assert.equal(req.model, 'qwen2.5:7b');
  assert.equal(req.stream, false);
  assert.equal(req.format.type, 'object', 'the JSON schema is sent so the model answers in that shape');
  assert.ok(req.messages[0].content.includes('Rule #1'), 'same instructions as Claude');
  assert.equal(ai.aiStatus(cfgWith({})).today.costUsd, 0);
});

test('garbled, wrong-format, missing-model, slow and not-running answers all mean "no answer"', async () => {
  next = [{ content: 'Sure! I think you should buy.' }];
  assert.equal(await ai.decideBuy(cfgWith({}), signal() as any), null);
  assert.match(ai.aiStatus(cfgWith({})).lastError!, /unreadable/);

  next = [{ content: JSON.stringify({ decision: 'yolo', size: 50 }) }];
  assert.equal(await ai.decideBuy(cfgWith({}), signal() as any), null);
  assert.match(ai.aiStatus(cfgWith({})).lastError!, /wrong format/);

  next = [{ status: 404 }];
  assert.equal(await ai.decideBuy(cfgWith({}), signal() as any), null);
  assert.match(ai.aiStatus(cfgWith({})).lastError!, /isn't installed.*ollama pull qwen2\.5:7b/);

  assert.equal(await ai.decideBuy(cfgWith({ ollamaFast: '', ollamaSmart: '' }), signal() as any), null);
  assert.match(ai.aiStatus(cfgWith({})).lastError!, /Pick a local model/);

  const off = sanitizeConfig({ ai: { enabled: true, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:19', ollamaFast: 'qwen2.5:7b' } }, true);
  assert.equal(await ai.decideBuy(off, signal() as any), null);
  assert.match(ai.aiStatus(off).lastError!, /Is Ollama running/);
});

test('the list of installed models', async () => {
  const r = await ai.ollamaModels(`http://127.0.0.1:${port}`);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.models.map((m) => [m.name, m.params]), [['qwen2.5:7b', '7.6B'], ['qwen2.5:14b', '14.8B']]);
  const bad = await ai.ollamaModels('http://127.0.0.1:19');
  assert.equal(bad.ok, false);
});
