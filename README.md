# Solana Copy Trading Bot

Watches any number of Solana wallets and copies their token swaps through Jupiter
(which routes across every Solana DEX, including pump.fun, Raydium, Orca and Meteora).

**It starts in PAPER mode: it logs what it would trade and sends nothing.** Run it this
way for at least a few days before you put real money in.

## Desktop app (recommended)

Copybot is a normal desktop app with its own window, icon and Start-menu or Applications entry.

**Windows:** run `Copybot Setup 0.1.0.exe`. The app isn't code-signed, so Windows SmartScreen
will warn you. Click **More info → Run anyway**. Afterwards, open Copybot from the desktop
shortcut or the Start menu.

**Mac:** build the .dmg with GitHub Actions (see below) or on any Mac with
`npm install && npm run dist:mac`. The app isn't signed by Apple, so the first time you open it,
right-click Copybot → **Open** → **Open** (or go to System Settings → Privacy & Security → *Open Anyway*).

**Look:** Copybot comes with two themes, picked in **Settings → Look**: **Rainbow arcade** (the default:
pixel fonts, rainbow colors, hearts and coins) and **Modern** (clean and minimal, follows light/dark mode).
Switching themes is instant and never stops the bot.

What the desktop app does:
- Runs the bot inside the app. There's no terminal or browser to keep open.
- Keeps your computer from sleeping while the bot is running.
- Warns you before quitting if the bot is still running.
- Stores your settings, keys and trade history in your user folder (menu: **File → Open Data Folder**):
  - Windows: `%APPDATA%\Copybot`
  - Mac: `~/Library/Application Support/Copybot`

  Uninstalling the app does not delete this folder.

### Building the installers yourself

```bash
npm install
npm run desktop      # run the desktop app without installing it
npm run dist:win     # → release/Copybot Setup x.y.z.exe  (on Windows, or Linux with Wine)
npm run dist:mac     # → release/*.dmg                      (on a Mac)
npm run dist:linux   # → release/*.AppImage
```

**GitHub Actions:** push this folder to a GitHub repository, open the **Actions** tab,
choose **Build desktop apps** and click **Run workflow**. A few minutes later, download the
Windows and Mac installers from that run's *Artifacts* section.

## Browser version (no install)

1. Install **Node.js** (LTS version) from https://nodejs.org
2. Start the app:
   - **Windows:** double-click `Start Copybot (Windows).bat`
   - **Mac:** double-click `Start Copybot (Mac).command`. The first time, right-click it → Open, because macOS blocks unsigned scripts.
   - **Any system, from a terminal:** `npm install`, then `npm run app`
3. Your browser opens at **http://localhost:4777**. Keep the black terminal window open while the bot runs; closing it stops the bot.

In the app:
- **Settings → Connection:** paste your Helius RPC URL and click *Test connection*
- **Find wallets:** discover and score wallets, then click *Copy* on the good ones
- **Wallets:** manage who you copy, and turn individual wallets on or off
- **Dashboard:** start or stop the bot, watch live activity and positions, and sell manually
- **Trades:** full history with profit and loss
- **Settings:** buy size, stop-loss and take-profit, limits, safety checks, paper or live mode

The app only listens on your own computer (localhost). Other devices on your network can't reach it.

### Headless (no UI)

`npm start` runs the same bot in the terminal using `config.json`. That's handy on a VPS.
To use the UI on a VPS, keep it private and reach it through an SSH tunnel:
`ssh -L 4777:localhost:4777 you@your-vps`, then open http://localhost:4777 on your own computer.

## Command-line tools

```bash
npm install
cp .env.example .env
cp config.example.json config.json
```

## 2. Find wallets worth copying

**Option A: discover them on-chain.** Choose 3–5 tokens that pumped hard recently
(look on dexscreener.com or birdeye.so). Copy each token's *mint address*, then run:

```bash
npm run discover -- <mint1> <mint2> <mint3>
```

This lists wallets that bought those tokens early. Wallets that were early on
**more than one** of them are the interesting ones.

**Option B:** get candidate addresses from tracker sites ("top traders" on
Dexscreener, GMGN, Birdeye or Cielo).

**Then always check their real record:**

```bash
npm run analyze -- <wallet1> <wallet2> ... --txs 500
```

You'll see win rate, realized PnL in SOL, ROI, trades per day and median hold time.
Good copy targets have:
- positive PnL across **many** closed trades (one lucky trade isn't a skill)
- fewer than about 100 trades a day (faster than that is a bot you can't keep up with)
- holds measured in minutes or hours, not seconds

## 3. Configure — `config.json`

| Setting | What it does |
|---|---|
| `mode` | `"paper"` (simulated) or `"live"` (real money) |
| `wallets` | the wallets to copy; add as many as you want, set `"enabled": false` to pause one |
| `buy.sizing` | `"fixed"` = spend `fixedSol` every time; `"percent"` = `percentOfTarget`% of what they spent |
| `buy.minSol` / `maxSol` | limits on the size of any single buy |
| `buy.minTargetBuySol` | ignore the target's small test buys |
| `sell.copySells` | when they sell X% of their bag, sell X% of yours |
| `risk.maxOpenPositions` | cap on how many tokens you hold at once |
| `risk.maxTotalExposureSol` | cap on total SOL in open positions |
| `risk.stopLossPct` / `takeProfitPct` | automatic exits |
| `risk.maxSignalAgeSec` | don't copy trades older than this |
| `safety.maxRoundTripLossPct` | before buying, quotes buy→sell; skips the token if the round trip loses more than this (illiquid or can't-sell tokens) |
| `safety.rejectFreezeAuthority` | skip tokens whose creator can freeze your tokens (common scam) |
| `safety.blacklist` | token mints never to buy |

### Exits, filters and safety limits

- **Staged take-profits** (Settings → Selling): at **+100% (2x)** sell enough to take your cost back,
  then sell part at take-profit 1 (+300%) and take-profit 2 (+900%). A **trailing stop** arms after
  +50% and sells everything if the price falls 30% from its peak. The Dashboard's *Exit plan* column
  shows what's done (✓) and where the trailing stop sits.
- **Don't chase** (Settings → Buying): skip a copy if the price is already more than 15% above what the
  copied wallet paid. You always buy after them; this stops the bot paying a pumped price.
- **Token filters** (Settings → Token filters, from Dexscreener data): minimum liquidity ($10K),
  max buy size vs the pool (2%), optional market-cap range and minimum token age. Pump.fun tokens still
  on their bonding curve have no pool figure; the buy-then-sell check covers those.
- **Circuit breaker** (Settings → Limits): stop new buys for the day after a **0.3 SOL** loss, and
  pause for 60 min after **4 losing trades in a row**. Sells and exits keep running. *Resume buying* on
  the Dashboard overrides it.
- **Per-wallet scoreboard** (Wallets): your own profit, win rate and sells from copying each wallet,
  a "losing money" flag, plus **Size ×** (scale buys from that wallet) and **Budget** (cap its SOL).

All of these have safe defaults. Set a value to 0 to turn that rule off.

## 4. Run

```bash
npm start
```

The bot writes trades to `data/trades.jsonl` and open positions to `data/state.json`.
It prints a status line every minute.

## 5. Going live (only after paper testing)

1. Create a **brand-new wallet** (for example in Phantom) used only for this bot.
   Fund it with only what you can afford to lose completely.
2. Export its private key and paste it in **Settings → Trading wallet**. The desktop app stores it
   encrypted. In browser or terminal mode you can instead put it in `.env` as `PRIVATE_KEY=...`.
3. Switch **Settings → Trading mode** to *Live* (or set `"mode": "live"` in `config.json`).
(Paper and live positions are tracked separately, in `data/state-paper.json` and `data/state-live.json`.)

## RPC provider

The bot needs an RPC node to read the blockchain. The public endpoint works for
testing but is heavily rate-limited and will miss trades.

- **Helius** (recommended): https://www.helius.dev. Has a free tier. Sign up, copy your
  key, and set `RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`
- QuickNode: https://www.quicknode.com
- Triton One: https://triton.one (for later, if you need the lowest latency)

## Running 24/7 on a VPS

A VPS is a small rented Linux server that stays on all the time.
DigitalOcean, Vultr and Hetzner all have plans for about $5–6/month that are plenty.

```bash
# on the server
git clone <your repo>   # or upload this folder
cd solana-copy-bot && npm install
npm install -g pm2
pm2 start "npm start" --name copybot      # or "npm run app" for the UI
pm2 logs copybot        # watch it
pm2 save && pm2 startup # restart automatically after reboots
```

Choose a US East or Frankfurt/Amsterdam region. Many Solana nodes are there, so it's faster.

## How it works

1. **Watch**: subscribes to each wallet over WebSocket and also polls as a backup.
2. **Decode** (`src/decode.ts`): compares the wallet's SOL and token balances before and
   after each transaction, so it understands swaps on any DEX without per-DEX code.
3. **Filter**: runs the position, exposure and age limits, then the safety checks.
4. **Execute**: gets a Jupiter quote and swap with your slippage and priority fee, then
   confirms. In live mode it reads the real filled amounts back from the chain.
5. **Manage**: copies sells proportionally, and runs the stop-loss and take-profit checks.

## Automatic updates

Copybot updates itself. The installed app checks GitHub Releases
(`github.com/catsandlights-ops/copybot`) when it starts and every 4 hours. It downloads new versions
in the background and shows **"Copybot x.y.z is ready, Restart & update"**. Clicking it stops the bot,
installs the update, reopens Copybot and starts the bot again if it was running. Settings, keys and
history are kept. You can also check manually in **Settings → App updates**.

**Updates are signed.** Every installer must carry a signature made with the Copybot update signing
key (Ed25519). The app contains only the matching public key (`electron/update-public-key.pem`) and
refuses any update without a valid signature, even if the GitHub account or download were compromised.

### Publishing an update

1. Make the code change and commit it.
2. Bump the version and push to `main`:
   ```bash
   npm version patch --no-git-tag-version   # 0.3.0 → 0.3.1  (minor/major for bigger releases)
   git commit -am "Release 0.3.1" && git push
   ```
3. GitHub Actions (`.github/workflows/release.yml`) sees the new version, builds the Windows
   installer, signs it and publishes the release. You can also start it from the **Actions** tab
   (**Release update → Run workflow**). Installed apps pick it up within 4 hours, or right away with
   "Check for updates".

### One-time setup for releases

- Repository secret **`UPDATE_SIGNING_KEY`**: the full contents of `signing/update-signing-key.pem`
  (GitHub → repo → Settings → Secrets and variables → Actions → New repository secret).
- **Back up that key** in a password manager. It is never committed (`signing/` is in `.gitignore`).
  If you lose it, existing installs can't accept updates and must be reinstalled by hand once.
  If it leaks, anyone could sign updates, so generate a new key pair and ship a manual reinstall.

To sign an installer by hand: `npm run sign-update -- release/Copybot-Setup-x.y.z.exe`.

## Security

How Copybot protects your wallet:

- **Every swap is verified before signing.** Jupiter builds each swap transaction, and the bot checks it
  before signing (`src/txguard.ts`). The transaction may only use the expected programs (Jupiter,
  Token, Associated Token Account, Compute Budget). It must not send SOL or tokens anywhere except
  your own accounts, and its priority fee must stay within your limit. It is then **simulated**
  against the live chain to confirm your balance drops by no more than the trade amount plus fees.
  Anything else is refused and logged. A compromised or spoofed API can't drain the wallet.
- **Quotes are checked.** A quote is only used if it's for exactly the token, amount and slippage the bot asked for.
- **The key is encrypted at rest (desktop app).** On Windows your trading wallet key is encrypted with
  DPAPI. Only your Windows user account on this computer can decrypt it. It's never sent to the
  dashboard, logged or transmitted. (In browser or terminal mode it's stored as plain text in `.env`.)
- **The control panel is locked to the app.** It only listens on `127.0.0.1`, and every request
  needs a random secret token created when the app starts. Other programs and websites can't control
  the bot, and requests with a foreign `Host` header are refused, which blocks DNS-rebinding attacks.
- **Hardened page.** Strict Content-Security-Policy, no framing, all on-chain data escaped. The Electron
  window is sandboxed with no Node access, refuses all device permissions, and only opens links
  to Solscan, Dexscreener and Helius.
- **Settings have limits.** Slippage is capped at 50%, priority fees at 0.05 SOL per trade, and so on,
  so a typo can't wreck your balance.
- **Dependencies are audited.** Patched web3.js and jayson, current Electron. `npm audit` only reports
  a build-tool issue (`minimatch` in electron-builder), which is never shipped in the app.

What you still need to do:
- Use a **separate wallet** for the bot and keep only a small amount in it.
- Keep Windows updated, and don't run Copybot on a computer you don't trust. Malware on
  your PC running as your user could still use your key.
- Download Copybot only from a source you trust. The installer is not code-signed.

## Risks, honestly

- You always fill **after** the wallet you copy, so at a worse price. On small meme coins
  this gap can wipe out the edge.
- Some public "smart wallets" deliberately profit from the people copying them.
- Safety checks reduce scam losses but cannot catch everything.
- Nothing here is financial advice. Never run it with money you can't lose.
