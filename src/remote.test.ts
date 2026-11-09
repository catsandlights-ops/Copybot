import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, cleanName, DEFAULT_REMOTE, findDevice, isTailscale, MAX_DEVICES, Pairing, peerAllowed, validPort } from './remote';

test('peerAllowed: home network and Tailscale only, never the public internet', () => {
  for (const ip of ['192.168.1.20', '::ffff:192.168.1.20', '10.0.0.5', '172.16.4.2', '172.31.255.1', '100.101.102.103', '127.0.0.1', '::1', 'fe80::1', 'fd12:3456::1', 'fd7a:115c:a1e0::1']) {
    assert.equal(peerAllowed(ip, false), true, ip);
  }
  for (const ip of ['8.8.8.8', '::ffff:8.8.8.8', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2001:4860::8888', '', 'not-an-ip', '999.1.1.1']) {
    assert.equal(peerAllowed(ip, false), false, ip);
  }
  assert.equal(peerAllowed(undefined, false), false);
});

test('peerAllowed: Tailscale-only mode refuses the home network', () => {
  assert.equal(peerAllowed('100.64.0.1', true), true);
  assert.equal(peerAllowed('fd7a:115c:a1e0:ab12::1', true), true);
  assert.equal(peerAllowed('127.0.0.1', true), true); // this computer
  assert.equal(peerAllowed('192.168.1.20', true), false);
  assert.equal(peerAllowed('10.0.0.5', true), false);
  assert.equal(isTailscale('100.127.255.254'), true);
  assert.equal(isTailscale('100.128.0.1'), false);
});

test('pairing codes: work once, expire, and lock after many wrong guesses', () => {
  const p = new Pairing();
  const t = 1_000_000;
  const { code, expiresAt } = p.create(t);
  assert.ok(code.length >= 20);
  assert.equal(expiresAt, t + 5 * 60_000);
  assert.equal(p.redeem(code, t + 1000), 'ok');
  assert.equal(p.redeem(code, t + 2000), 'bad'); // single use
  const late = p.create(t);
  assert.equal(p.redeem(late.code, t + 5 * 60_000 + 1), 'bad'); // expired
  const q = new Pairing();
  const good = q.create(t);
  for (let i = 0; i < 10; i++) q.redeem('wrong' + i, t);
  assert.equal(q.redeem(good.code, t), 'locked');
  assert.equal(q.redeem(good.code, t + 61_000), 'ok'); // the lock lifts after a minute
  const c = new Pairing();
  const x = c.create(t);
  c.cancelAll();
  assert.equal(c.redeem(x.code, t), 'bad');
  assert.equal(c.redeem({ evil: 1 }, t), 'bad');
});

test('devices: keys are stored only as hashes and checked exactly; at most 5', () => {
  const r = structuredClone(DEFAULT_REMOTE);
  const a = addDevice(r, 'My <b>phone</b>', 1);
  assert.equal(a.device.name, 'My bphone/b');
  assert.ok(!JSON.stringify(r).includes(a.key));
  assert.equal(findDevice(r, a.key)?.id, a.device.id);
  assert.equal(findDevice(r, a.key + 'x'), null);
  assert.equal(findDevice(r, ''), null);
  assert.equal(findDevice(r, undefined), null);
  const b = addDevice(r, '', 2);
  assert.equal(b.device.name, 'Phone');
  assert.equal(findDevice(r, b.key)?.id, b.device.id);
  for (let i = r.devices.length; i < MAX_DEVICES; i++) addDevice(r, 'x', 3);
  assert.throws(() => addDevice(r, 'one too many', 4), /At most 5/);
});

test('settings helpers', () => {
  assert.equal(validPort(4780), true);
  assert.equal(validPort(80), false);
  assert.equal(validPort(70000), false);
  assert.equal(validPort('4780'), false);
  assert.equal(cleanName('x'.repeat(80)).length, 40);
  assert.equal(DEFAULT_REMOTE.enabled, false);
});
