import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AlertQueue, isChatId, isDiscordWebhook, isTelegramToken } from './alerts';

test('validators', () => {
  assert.ok(isTelegramToken('123456789:AAH4sdfGHjkLzxcVbnM1234567890qwertyu'));
  assert.ok(!isTelegramToken('hello'));
  assert.ok(isDiscordWebhook('https://discord.com/api/webhooks/123456789012345678/abcDEF_-123'));
  assert.ok(!isDiscordWebhook('https://evil.example/api/webhooks/1/x'));
  assert.ok(!isDiscordWebhook('http://discord.com/api/webhooks/1/x'));
  assert.ok(isChatId('-1001234567890') && isChatId('987654321') && !isChatId('abc'));
});

test('queue: rate limit merges extras into one summary; repeated errors collapse', () => {
  let now = 0;
  const sent: string[] = [];
  const q = new AlertQueue(async (t) => void sent.push(t), 2, () => now);
  q.push('a'); q.push('b'); q.push('c'); q.push('d');
  assert.deepEqual(sent, ['a', 'b']);
  q.flush();
  assert.equal(sent[2], '2 updates:\n• c\n• d');
  now = 61_000;
  sent.length = 0;
  q.push('⚠️ RPC failed 5 times', 'errors');
  q.push('⚠️ RPC failed 6 times', 'errors'); // same error with a different number: dropped
  now += 11 * 60_000;
  q.push('⚠️ RPC failed 7 times', 'errors');
  assert.deepEqual(sent, ['⚠️ RPC failed 5 times', '⚠️ RPC failed 7 times']);
});

// sendNow / detectTelegramChat against a fake Telegram server.
const got: any[] = [];
let srv: http.Server;
before(async () => {
  srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    got.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url!.includes('getUpdates') ? { ok: true, result: [{ message: { chat: { id: 42, first_name: 'Sam' } } }] } : { ok: true }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  process.env.COPYBOT_TELEGRAM_API = `http://127.0.0.1:${(srv.address() as any).port}`;
  process.env.TELEGRAM_BOT_TOKEN = '123456789:AAH4sdfGHjkLzxcVbnM1234567890qwertyu';
  process.env.TELEGRAM_CHAT_ID = '42';
});
after(() => srv.close());

test('sends plain text to Telegram and finds the chat ID', async () => {
  const { sendNow, detectTelegramChat } = await import('./alerts');
  assert.deepEqual(await sendNow('hi\u0007 there'), []);
  assert.equal(got[0].url, '/bot123456789:AAH4sdfGHjkLzxcVbnM1234567890qwertyu/sendMessage');
  assert.deepEqual(got[0].body, { chat_id: '42', text: 'hi there', disable_web_page_preview: true });
  assert.deepEqual(await detectTelegramChat(process.env.TELEGRAM_BOT_TOKEN!), { chatId: '42', name: 'Sam' });
});
