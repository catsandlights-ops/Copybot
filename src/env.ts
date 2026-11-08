import 'dotenv/config';
import fs from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Connection settings live in .env and are read lazily so the app can change them at runtime.
export const rpcUrl = () => process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
export const wsUrl = () => process.env.WS_URL || rpcUrl().replace(/^http/, 'ws');
export const jupUrl = () => (process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1').replace(/\/$/, '');
export const jupKey = () => process.env.JUPITER_API_KEY || '';

export function makeConnection(): Connection {
  return new Connection(rpcUrl(), { commitment: 'confirmed', wsEndpoint: wsUrl(), disableRetryOnRateLimit: true });
}

export function isHttpsUrl(s: string) {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Update keys in .env (creating it if needed) and in process.env. */
export function updateEnv(updates: Record<string, string>) {
  for (const [k, v] of Object.entries(updates)) {
    // A newline would let a value inject extra settings into the file.
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`Invalid characters in ${k}`);
  }
  const file = '.env';
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l !== '') : [];
  for (const [k, v] of Object.entries(updates)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    process.env[k] = v;
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}

// ---------------- trading wallet key ----------------
//
// In the desktop app, Electron provides an OS-backed "secret box" (Windows DPAPI /
// macOS Keychain). The key is then stored encrypted as PRIVATE_KEY_ENC and can only
// be decrypted by this user on this computer. Without it (browser/CLI mode) the key
// is stored as plain PRIVATE_KEY in .env, which only this user can read.

type SecretBox = { encrypt(s: string): string; decrypt(s: string): string };
const secretBox = (): SecretBox | null => (globalThis as any).__copybotSecretBox ?? null;

export const keyIsEncrypted = () => !!process.env.PRIVATE_KEY_ENC;
export const canEncryptKey = () => secretBox() !== null;

export function parseKeypair(pk: string): Keypair {
  pk = pk.trim();
  if (pk.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(pk)));
  return Keypair.fromSecretKey(bs58.decode(pk));
}

/** Throws if the stored key exists but can't be decrypted/parsed. */
export function loadKeypair(): Keypair | null {
  const enc = process.env.PRIVATE_KEY_ENC?.trim();
  if (enc) {
    const box = secretBox();
    if (!box) throw new Error('The trading wallet key is encrypted for the desktop app. Open Copybot from the desktop app, or add the key again.');
    let pk: string;
    try {
      pk = box.decrypt(enc);
    } catch {
      throw new Error("The saved trading wallet key can't be unlocked on this computer or user account. Add the key again in Settings → Trading wallet.");
    }
    return parseKeypair(pk);
  }
  const pk = process.env.PRIVATE_KEY?.trim();
  return pk ? parseKeypair(pk) : null;
}

/** Store (or with '' remove) the trading wallet key, encrypted when possible. */
export function savePrivateKey(pk: string) {
  pk = pk.trim();
  const box = secretBox();
  if (pk && box) updateEnv({ PRIVATE_KEY_ENC: box.encrypt(pk), PRIVATE_KEY: '' });
  else updateEnv({ PRIVATE_KEY: pk, PRIVATE_KEY_ENC: '' });
}

/** Desktop app: encrypt a key that is still stored in plain text. */
export function encryptPlaintextKey() {
  const pk = process.env.PRIVATE_KEY?.trim();
  if (pk && secretBox()) savePrivateKey(pk);
}
