// Copybot desktop app: runs the bot + control panel inside an Electron window.
const { app, BrowserWindow, shell, dialog, Menu, powerSaveBlocker, nativeTheme, safeStorage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const updater = require('./updater.cjs');

const BASE = path.join(__dirname, '..'); // app files (ui/, dist/)
// Links may only open these sites in the user's browser (news sources, data providers, key sign-up pages).
const EXTERNAL_HOSTS = new Set([
  'solscan.io', 'basescan.org', 'www.alchemy.com', 'alchemy.com', 'dexscreener.com', 't.me', 'telegram.org', 'core.telegram.org', 'discord.com', 'support.discord.com', 'www.quicknode.com', 'quicknode.com', 'www.helius.dev', 'helius.dev', 'tailscale.com', 'login.tailscale.com', 'nodejs.org',
  'blockworks.com', 'blockworks.co', 'www.coindesk.com', 'coindesk.com', 'www.theblock.co', 'theblock.co', 'decrypt.co',
  'www.geckoterminal.com', 'www.coingecko.com', 'dexcheck.ai', 'api.dexcheck.ai', 'console.anthropic.com', 'docs.anthropic.com',
]);

let win = null;
let engine = null;
let appUrl = '';
let sleepBlocker = null;
let quitting = false;
let serverMod = null;
const startedAtLogin = process.argv.includes('--minimized');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(boot).catch((e) => {
    dialog.showErrorBox('Copybot could not start', String(e?.stack || e));
    app.exit(1);
  });
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname)) shell.openExternal(u.toString());
  } catch {
    /* ignore malformed links */
  }
}

async function boot() {
  // Settings, keys and trade history live in the per-user app data folder:
  //   Windows: %APPDATA%\Copybot   macOS: ~/Library/Application Support/Copybot
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  process.chdir(dataDir);

  // Let the bot store the wallet key encrypted by the OS (Windows DPAPI / macOS Keychain).
  if (safeStorage.isEncryptionAvailable()) {
    globalThis.__copybotSecretBox = {
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
    };
  }

  // The UI never needs camera, microphone, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  process.env.COPYBOT_DESKTOP = '1';
  process.env.COPYBOT_VERSION = app.getVersion();
  process.env.COPYBOT_UI = path.join(BASE, 'ui', 'index.html');
  // Settings → App → "Start with Windows": a login entry that opens Copybot minimized.
  globalThis.__copybotDesktop = {
    setStartAtLogin: (on) => {
      try {
        app.setLoginItemSettings({ openAtLogin: !!on, args: ['--minimized'] });
      } catch {
        /* not supported here */
      }
    },
    openFolder: (p) => shell.openPath(path.resolve(dataDir, p)),
  };
  const server = await import(pathToFileURL(path.join(BASE, 'dist', 'server.mjs')).href);
  engine = server.engine;
  serverMod = server;
  const port = await server.startServer(0, false);
  appUrl = `http://127.0.0.1:${port}`;

  engine.on('status', onStatus);
  setupUpdates(server);
  resumeAfterUpdate();
  buildMenu();
  createWindow(`${appUrl}/?t=${server.TOKEN}`);
}

// ---------- updates ----------
const RESUME_FILE = 'data/resume-after-update.json';

function setupUpdates(server) {
  updater.init({ onStateChange: (s) => server.setUpdateState(s), log: (m) => engine.log(m, 'warn') });
  globalThis.__copybotUpdater = {
    check: () => updater.checkNow(),
    install: () =>
      updater.install(async () => {
        // Remember that the bot was running so it starts again after the update.
        if (engine.running) {
          fs.mkdirSync('data', { recursive: true });
          fs.writeFileSync(RESUME_FILE, JSON.stringify({ at: Date.now() }));
        }
        quitting = true;
        await engine.stop();
      }),
  };
}

function resumeAfterUpdate() {
  try {
    const { at } = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
    fs.rmSync(RESUME_FILE, { force: true });
    if (Date.now() - at < 15 * 60 * 1000) {
      engine.log(`Updated to version ${app.getVersion()}. Restarting the bot…`, 'system');
      engine.start().catch((e) => engine.log(`Could not restart the bot: ${e.message}`, 'error'));
    }
  } catch {
    /* no pending resume */
  }
}

function onStatus() {
  // Keep the computer awake while the bot is trading.
  if (engine.running && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!engine.running && sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = null;
  }
  if (win) win.setTitle(engine.running ? `Copybot — running (${engine.cfg.mode})` : 'Copybot');
}

function createWindow(startUrl) {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 860,
    minHeight: 560,
    title: 'Copybot',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1014' : '#f5f6f8',
    icon: path.join(BASE, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  // Opened by Windows at login: start minimized to the taskbar instead of popping up.
  win.once('ready-to-show', () => {
    if (!startedAtLogin) return win.show();
    win.showInactive();
    win.minimize();
  });
  win.loadURL(startUrl);

  // Links open in the normal browser (known sites only); the window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(appUrl + '/')) {
      e.preventDefault();
      openExternal(url);
    }
  });

  win.on('close', async (e) => {
    if (quitting || !engine || !engine.running) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Keep running', 'Stop bot and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'The bot is still running',
      detail: 'Quitting stops copy trading. Open positions stay in your wallet, but stop-loss, take-profit and copied sells will not run while Copybot is closed.',
    });
    if (response === 1) {
      quitting = true;
      await engine.stop();
      serverMod?.userStopped?.(); // you stopped it: don't start it again by itself next time
      app.quit();
    }
  });
  win.on('closed', () => (win = null));
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('window-all-closed', async () => {
  if (engine) await engine.stop().catch(() => {});
  app.quit();
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const view = [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }];
  if (!app.isPackaged) view.push({ role: 'toggleDevTools' });
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [{ label: 'Open Data Folder', click: () => shell.openPath(app.getPath('userData')) }, { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    {
      label: 'Help',
      submenu: [
        { label: 'Get a free Helius RPC key', click: () => openExternal('https://www.helius.dev') },
        { label: 'Find trending tokens (Dexscreener)', click: () => openExternal('https://dexscreener.com/solana') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
