// Automatic updates for the desktop app.
//
// Flow: check (at startup + every 4h) → download in the background → verify OUR
// Ed25519 signature on the downloaded installer → show "Restart to update" in the app.
// Nothing is ever installed without a valid signature from the Copybot signing key,
// even if the update server or the GitHub account were compromised.
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const PUBLIC_KEY = crypto.createPublicKey(fs.readFileSync(path.join(__dirname, 'update-public-key.pem'), 'utf8'));
const pkg = require('../package.json');

let state = { state: 'idle', currentVersion: app.getVersion() };
let verifiedFile = null;
let onState = () => {};

function setState(s) {
  state = { ...s, currentVersion: app.getVersion() };
  onState(state);
}

/** Where the .sig for a downloaded installer lives (next to the installer in the release). */
function signatureUrl(info) {
  const file = info.files?.[0]?.url || info.path;
  if (process.env.COPYBOT_UPDATE_URL) return `${process.env.COPYBOT_UPDATE_URL.replace(/\/$/, '')}/${file}.sig`;
  const pub = pkg.build.publish;
  return `https://github.com/${pub.owner}/${pub.repo}/releases/download/v${info.version}/${file}.sig`;
}

function signatureValid(file, sigB64) {
  try {
    return crypto.verify(null, fs.readFileSync(file), PUBLIC_KEY, Buffer.from(sigB64.trim(), 'base64'));
  } catch {
    return false;
  }
}

async function fetchSignature(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`signature not found (${res.status})`);
  const text = (await res.text()).trim();
  if (!/^[A-Za-z0-9+/=]{60,200}$/.test(text)) throw new Error('signature file is malformed');
  return text;
}

function init({ onStateChange, log }) {
  onState = onStateChange;
  if (!app.isPackaged && !process.env.COPYBOT_UPDATE_URL) {
    setState({ state: 'disabled', message: 'Updates are only available in the installed app.' });
    return;
  }
  if (process.env.COPYBOT_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.COPYBOT_UPDATE_URL });

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // never install unverified files on quit
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  // Keep the activity feed readable: only the first line of real errors, no routine warnings.
  autoUpdater.logger = { info: () => {}, warn: () => {}, debug: () => {}, error: (m) => log(`Update check problem: ${String(m).split('\n')[0].slice(0, 160)}`) };

  autoUpdater.on('checking-for-update', () => setState({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => setState({ state: 'up-to-date', checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) => setState({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setState({ state: 'downloading', version: state.version, percent: Math.round(p.percent) }));
  autoUpdater.on('error', (e) => setState({ state: 'error', message: 'Could not check for updates. Will try again later.', detail: String(e?.message || e).slice(0, 200) }));
  autoUpdater.on('update-downloaded', async (info) => {
    setState({ state: 'verifying', version: info.version });
    try {
      const sig = await fetchSignature(signatureUrl(info));
      if (!signatureValid(info.downloadedFile, sig)) throw new Error('signature does not match');
      verifiedFile = { path: info.downloadedFile, sig, version: info.version };
      setState({ state: 'ready', version: info.version, releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : null });
    } catch (e) {
      verifiedFile = null;
      fs.rmSync(info.downloadedFile, { force: true });
      log(`Update ${info.version} rejected: ${e.message}`);
      setState({ state: 'rejected', version: info.version, message: `Update ${info.version} was rejected because its security signature is invalid. It was not installed.` });
    }
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY_MS);
}

function checkNow() {
  if (state.state === 'disabled') return state;
  autoUpdater.checkForUpdates().catch(() => {});
  return state;
}

/** Install the verified update. `beforeQuit` stops the bot first. */
async function install(beforeQuit) {
  if (!verifiedFile) throw new Error('No verified update is ready.');
  // Re-check right before installing, in case the file changed on disk.
  if (!signatureValid(verifiedFile.path, verifiedFile.sig)) {
    verifiedFile = null;
    setState({ state: 'rejected', message: 'The downloaded update changed on disk and was not installed.' });
    throw new Error('Update file failed verification');
  }
  setState({ state: 'installing', version: verifiedFile.version });
  await beforeQuit();
  autoUpdater.quitAndInstall(true, true); // silent install, reopen Copybot afterwards
}

module.exports = { init, checkNow, install, getState: () => state };
