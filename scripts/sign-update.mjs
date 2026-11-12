// Signs an update installer so Remora will accept it.
//   node scripts/sign-update.mjs <file>  → writes <file>.sig
// The private key comes from the UPDATE_SIGNING_KEY environment variable (CI)
// or signing/update-signing-key.pem (local). Never commit or share it.
import crypto from 'node:crypto';
import fs from 'node:fs';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('usage: node scripts/sign-update.mjs <installer file>');
  process.exit(1);
}
const pem = process.env.UPDATE_SIGNING_KEY || fs.readFileSync('signing/update-signing-key.pem', 'utf8');
const key = crypto.createPrivateKey(pem);
const sig = crypto.sign(null, fs.readFileSync(file), key).toString('base64');

// Refuse to produce a signature the app would reject.
const pub = crypto.createPublicKey(fs.readFileSync('electron/update-public-key.pem', 'utf8'));
if (!crypto.verify(null, fs.readFileSync(file), pub, Buffer.from(sig, 'base64'))) {
  console.error('This signing key does not match electron/update-public-key.pem');
  process.exit(1);
}
fs.writeFileSync(file + '.sig', sig + '\n');
console.log(`Signed ${file}`);
