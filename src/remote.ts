/**
 * Phone access. A second, separate door into Copybot, off until the user turns it on:
 *   - only devices paired with a one-time QR code get in (each has its own long random key,
 *     stored here only as a hash, removable one by one);
 *   - only answers on the home network or Tailscale, never from a public internet address;
 *   - only offers a short list of actions (see server.ts handleRemote): no settings, keys or wallets.
 * The pure helpers are unit-tested; the server wires them up.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

export type Device = { id: string; name: string; hash: string; createdAt: number; lastSeen: number };
export type RemoteSettings = { enabled: boolean; port: number; tailscaleOnly: boolean; devices: Device[] };

const FILE = 'data/remote.json';
export const DEFAULT_REMOTE: RemoteSettings = { enabled: false, port: 4780, tailscaleOnly: false, devices: [] };
export const MAX_DEVICES = 5;
const PAIR_TTL_MS = 5 * 60_000;

// ---------------- which computers may connect ----------------

/** IPv4 as a 32-bit number, or null. Accepts IPv4-mapped IPv6 (::ffff:1.2.3.4). */
function v4(ip: string): number | null {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const inV4 = (n: number, base: string, bits: number) => {
  const b = v4(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
};

/** Tailscale addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailscale(ip: string): boolean {
  const n = v4(ip);
  if (n !== null) return inV4(n, '100.64.0.0', 10);
  return /^fd7a:115c:a1e0:/i.test(ip.trim());
}

/**
 * May this peer use the phone door? Home network (private IPv4 ranges, IPv6 link-local and
 * unique-local) and Tailscale, plus this computer itself. Never a public internet address, so a
 * router port-forward can't expose Copybot by accident. tailscaleOnly = Tailscale (and this computer) only.
 */
export function peerAllowed(ip: string | undefined, tailscaleOnly: boolean): boolean {
  if (!ip) return false;
  const a = ip.trim().toLowerCase();
  const n = v4(a);
  const loopback = a === '::1' || (n !== null && inV4(n, '127.0.0.0', 8));
  if (loopback || isTailscale(a)) return true;
  if (tailscaleOnly) return false;
  if (n !== null) return inV4(n, '10.0.0.0', 8) || inV4(n, '172.16.0.0', 12) || inV4(n, '192.168.0.0', 16);
  return /^fe[89ab][0-9a-f]:/.test(a) || /^f[cd][0-9a-f]{2}:/.test(a); // fe80::/10, fc00::/7
}

/** This computer's addresses a phone could use: home network and Tailscale. */
export function localAddresses(): { lan: string[]; tailscale: string[] } {
  const lan: string[] = [];
  const tailscale: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4') continue;
      if (isTailscale(i.address)) tailscale.push(i.address);
      else if (peerAllowed(i.address, false)) lan.push(i.address);
    }
  }
  return { lan, tailscale };
}

// ---------------- settings and paired devices ----------------

export function loadRemote(): RemoteSettings {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const devices: Device[] = (Array.isArray(j.devices) ? j.devices : [])
      .filter((d: any) => typeof d?.id === 'string' && typeof d?.hash === 'string' && /^[0-9a-f]{64}$/.test(d.hash))
      .slice(0, MAX_DEVICES)
      .map((d: any) => ({ id: d.id, name: cleanName(d.name), hash: d.hash, createdAt: Number(d.createdAt) || 0, lastSeen: Number(d.lastSeen) || 0 }));
    return { enabled: j.enabled === true, port: validPort(j.port) ? j.port : DEFAULT_REMOTE.port, tailscaleOnly: j.tailscaleOnly === true, devices };
  } catch {
    return structuredClone(DEFAULT_REMOTE);
  }
}

export function saveRemote(r: RemoteSettings) {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(r, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}

export const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1024 && (p as number) <= 65535;
export const cleanName = (s: unknown) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 40) || 'Phone';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** The device a key belongs to, or null. Compares hashes in constant time. */
export function findDevice(r: RemoteSettings, key: string | undefined | null): Device | null {
  if (!key || key.length < 20 || key.length > 200) return null;
  const h = Buffer.from(sha(key), 'hex');
  let hit: Device | null = null;
  for (const d of r.devices) if (crypto.timingSafeEqual(h, Buffer.from(d.hash, 'hex'))) hit = d;
  return hit;
}

/** Add a paired device. Returns its key (shown to the phone once, never stored). */
export function addDevice(r: RemoteSettings, name: string, now: number): { key: string; device: Device } {
  if (r.devices.length >= MAX_DEVICES) throw new Error(`At most ${MAX_DEVICES} paired devices. Remove one on the computer first.`);
  const key = crypto.randomBytes(32).toString('base64url');
  const device = { id: crypto.randomBytes(6).toString('hex'), name: cleanName(name), hash: sha(key), createdAt: now, lastSeen: now };
  r.devices.push(device);
  return { key, device };
}

// ---------------- one-time pairing codes ----------------

/** Pairing codes live in memory only: single use, 5 minutes, and a restart cancels them. */
export class Pairing {
  private codes = new Map<string, number>(); // sha(code) -> expires
  private fails: number[] = [];

  create(now: number): { code: string; expiresAt: number } {
    for (const [k, t] of this.codes) if (t <= now) this.codes.delete(k);
    const code = crypto.randomBytes(18).toString('base64url');
    const expiresAt = now + PAIR_TTL_MS;
    this.codes.set(sha(code), expiresAt);
    return { code, expiresAt };
  }

  /** Uses up the code if it's valid. Too many wrong codes in a minute locks pairing for that minute. */
  redeem(code: unknown, now: number): 'ok' | 'bad' | 'locked' {
    this.fails = this.fails.filter((t) => now - t < 60_000);
    if (this.fails.length >= 10) return 'locked';
    const k = typeof code === 'string' && code.length <= 100 ? sha(code) : '';
    const exp = this.codes.get(k);
    if (!exp || exp <= now) {
      this.fails.push(now);
      return 'bad';
    }
    this.codes.delete(k);
    return 'ok';
  }

  cancelAll() {
    this.codes.clear();
  }
}
