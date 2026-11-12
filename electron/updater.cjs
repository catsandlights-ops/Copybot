// Automatic updates for the desktop app.
//
// Flow: check (at startup + every 4h) → download in the background → verify OUR
// Ed25519 signature on the downloaded installer → show "Restart to update" in the app.
// Nothing is ever installed without a valid signature from the Remora signing key,
// even if the update server or the GitHub account were compromised.
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const PUBLIC_KEY = crypto.createPublicKey(fs.readFileSync(path.join(__dirname, 'update-public-key.pem'), 'utf8'));

class BadSignature extends Error {}

let state = { state: 'idle', currentVersion: app.getVersion() };
let verifiedFile = null;
let onState = () => {};

function setState(s) {
  state = { ...s, currentVersion: app.getVersion() };
  onState(state);
}

/**
 * The GitHub repo updates come from. Read from app-update.yml, the same file electron-updater
 * uses to find updates. (package.json's "build" section is stripped from the installed app.)
 */
function feedRepo() {
  const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
  const owner = /^owner:\s*([\w.-]+)\s*$/m.exec(yml)?.[1];
  const repo = /^repo:\s*([\w.-]+)\s*$/m.exec(yml)?.[1];
  if (!owner || !repo) throw new Error('update source is not configured in app-update.yml');
  return { owner, repo };
}

/** Where the .sig for a downloaded installer lives (next to the installer in the release). */
function signatureUrl(info) {
  const file = info.files?.[0]?.url || info.path;
  if (!/^[\w.-]+$/.test(file) || !/^[\w.-]+$/.test(info.version)) throw new Error('unexpected update file name');
  if (process.env.COPYBOT_UPDATE_URL) return `${process.env.COPYBOT_UPDATE_URL.replace(/\/$/, '')}/${file}.sig`;
  const { owner, repo } = feedRepo();
  return `https://github.com/${owner}/${repo}/releases/download/v${info.version}/${file}.sig`;
}

/** Throws BadSignature if the file isn't signed by us, or Error if it couldn't be checked. */
async function verifyDownload(file, info) {
  const sig = await fetchSignature(signatureUrl(info));
  const data = await readDownload(file);
  if (!signatureMatches(data, sig)) {
    // Include enough detail to tell a tampered file from any other problem.
    const sha = crypto.createHash('sha512').update(data).digest('base64');
    const expected = info.files?.[0]?.sha512 || info.sha512;
    throw new BadSignature(`signature does not match (file ${data.length} bytes, checksum ${sha === expected ? 'matches' : 'does NOT match'} the release)`);
  }
  return sig;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the downloaded installer. Right after a download, antivirus software (e.g. Windows
 * Defender) scans new .exe files and can lock them for several seconds, so retry while the
 * file is busy instead of treating that as a bad signature.
 */
async function readDownload(file) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.readFileSync(file);
    } catch (e) {
      const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
      if (!busy || attempt >= 24) throw new Error(`could not read the downloaded update (${e.code || e.message})`);
      await sleep(2500); // up to ~1 minute in total
    }
  }
}

function signatureMatches(data, sigB64) {
  try {
    return crypto.verify(null, data, PUBLIC_KEY, Buffer.from(sigB64.trim(), 'base64'));
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
      const sig = await verifyDownload(info.downloadedFile, info);
      verifiedFile = { path: info.downloadedFile, sig, version: info.version };
      setState({ state: 'ready', version: info.version, releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : null });
    } catch (e) {
      verifiedFile = null;
      fs.rmSync(info.downloadedFile, { force: true });
      log(`Update ${info.version} not installed: ${e.message}`);
      if (e instanceof BadSignature) {
        setState({ state: 'rejected', version: info.version, message: `Update ${info.version} was rejected because its security signature is invalid. It was not installed.` });
      } else {
        // Couldn't check (offline, GitHub hiccup…). Fail safe: don't install, try again later.
        setState({ state: 'error', version: info.version, message: `Update ${info.version} couldn't be verified right now, so it wasn't installed. Remora will try again in 10 minutes.`, detail: String(e.message).slice(0, 200) });
        setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10 * 60 * 1000);
      }
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
  if (!signatureMatches(await readDownload(verifiedFile.path), verifiedFile.sig)) {
    verifiedFile = null;
    setState({ state: 'rejected', message: 'The downloaded update changed on disk and was not installed.' });
    throw new Error('Update file failed verification');
  }
  setState({ state: 'installing', version: verifiedFile.version });
  await beforeQuit();
  autoUpdater.quitAndInstall(true, true); // silent install, reopen Remora afterwards
}

module.exports = { init, checkNow, install, getState: () => state, _test: { signatureUrl, verifyDownload, readDownload, BadSignature } };
