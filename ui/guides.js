// Copybot guides, shown on the Learn page. Plain HTML authored here (trusted content).
// Categories: start, strategy, safety, features, news
window.GUIDE_CATS = {
  start: { label: 'Getting started', color: 'var(--r-green)' },
  strategy: { label: 'Strategy', color: 'var(--r-blue)' },
  safety: { label: 'Safety', color: 'var(--r-red)' },
  features: { label: 'Features', color: 'var(--r-violet)' },
  news: { label: "What's new", color: 'var(--r-orange)' },
};

window.GUIDES = [
  {
    id: 'whats-new-08', cat: 'news', mins: 3, title: "What's new in Copybot 0.8",
    teaser: 'Phone access, a market scanner, live graphs, your own limit and DCA orders, a panic button, and profit reports with a tax export.',
    body: `
<h3>New in 0.8.5</h3>
<ul>
<li><b>Simpler Settings:</b> tabs (Basics, Buying, Selling, Safety, Automation, Connections, App), a search box, and only the settings that apply right now. Rarely-changed ones wait behind "Show more".</li>
<li><b>Trade size in one click:</b> Small (0.05 SOL), Medium (0.25 SOL, the new default) or Large (1 SOL) sets the buy size and the limits that go with it.</li>
<li><b>Faster scanners:</b> the coin scanner gets a fresh list every minute (or every 30 seconds), the spotter looks for traders every 5 minutes, and full wallet searches run every hour. All adjustable in Settings → Automation.</li>
<li><b>Clearer charts:</b> the wallet chart stays in its box, profit steps at each sale, and tiny amounts show real digits.</li>
</ul>
<h3>New in 0.8.4</h3>
<ul>
<li><b>Rule #1: a profitable trade is a good trade.</b> Once a trade has been up 20%, it is never allowed to end as a loss: if it falls back to +5%, Copybot sells and keeps the win. On for every wallet, the scanner, backtests and the autopilot. <a href="#" data-guide="exits">How exits work →</a></li>
<li><b>Learning:</b> Copybot keeps score of the conditions each trade was bought in (coin age, liquidity, size, market mood, time of day, chain) and avoids the kinds that have been losing you money over the last 2 weeks. Lessons last a week, then get a fresh test, so it keeps up as the market changes. Exits are re-checked daily and only switched when they win on the past week <i>and</i> the last 2 days. Everything it learns and changes is on the Autopilot page, with Undo.</li>
<li><b>Always hunting:</b> one switch on the Scanner page keeps Copybot looking for coins (every minute) and traders (spotted every 15 minutes, a full backtested search every 2 hours, on Solana and, with an Alchemy key, Base) the whole time it runs.</li>
</ul>
<h3>New in 0.8.3</h3>
<ul>
<li><b>Calmer dump protection:</b> lots of small sells only trigger a sale if the price is really falling (5% or more in 5 minutes).</li>
<li><b>Break-even isn't a loss:</b> trades that lose under 2% no longer count toward "losing trades in a row" pauses.</li>
<li><b>Safer Base live trading:</b> a trade that's slow to confirm is followed up and added to your books when it lands; one the network drops changes nothing.</li>
<li><b>A quieter activity log</b>, with plain words when a free network node is busy.</li>
</ul>
<h3>New in 0.8.2</h3>
<ul>
<li><b>Base everywhere:</b> Find wallets, Analyze, backtests and the wallet check-up now work for Base wallets (add a free Alchemy Base URL in <b>Settings → Connection</b>). Markets and the coin scanner have a <b>Solana / Base</b> switch.</li>
<li><b>Contract-wallet warning:</b> adding a Base address that is a smart contract (which can't be copied reliably) tells you so.</li>
<li><b>Connection status</b> (Settings): a card that checks every service Copybot uses (Solana, Base, Jupiter, KyberSwap, safety checks, prices) and says in plain words what is down.</li>
<li><b>Backup and restore</b> (Settings): save your settings, wallets, history and orders to one file and restore them later. Your keys are never included.</li>
<li><b>Ready for live?</b> (Settings) A report that looks at your paper results (days run, trades closed, profit factor, missed copies) and says whether going live looks sensible, shown again when you switch to Live.</li>
<li><b>Live trading on Base</b> (off by default): add a Base trading key in <b>Settings → Trading wallet</b> and switch it on. <a href="#" data-guide="base">Read the safety notes first →</a></li>
</ul>
<h3>New in 0.8.1: Base</h3>
<p>Copy wallets on <b>Base</b> (addresses starting with 0x) alongside your Solana wallets, in paper mode for now. Base trades are checked for honeypots and high taxes and converted to SOL in your books. <a href="#" data-guide="base">How it works →</a></p>
<h3>Phone access</h3>
<p>Check your profit and positions, start and stop the bot, and sell from your phone, at home over Wi-Fi or anywhere with the free Tailscale app. Set it up in <b>Settings → Phone access</b>. Your phone can't change settings or touch your keys and wallets. <a href="#" data-guide="phone">Set it up →</a></p>
<h3>Market scanner</h3>
<p>A new <b>Scanner</b> page with two switches, both off until you turn them on:</p>
<ul>
<li><b>Find traders:</b> keeps looking at new <i>and older</i> coins for traders who are winning, backtests them with your settings, and adds the best on a trial.</li>
<li><b>Trade coins:</b> buys coins that are rising on strong buying, on its own, with its own budget, stop-loss and take-profit, through every safety check. Try it in paper mode first. <a href="#" data-guide="scanner">How it works →</a></li>
</ul>
<h3>Is the scanner any good?</h3>
<p>The Scanner page now shows a <b>live track record</b>: every coin it flags (bought or not) is checked later against the real price. <b>Test on the past</b> replays its rules on the last 1 to 3 days with different buying rules and exits, and lets you switch to the best one in a click.</p>
<h3>Your own orders</h3>
<p>A new <b>Orders</b> page: buy a coin when it drops to a price, sell when it reaches a target, or buy a little every few hours (DCA). Every buy goes through your limits and safety checks. Use <b>Place an order</b> on any coin in Markets.</p>
<h3>Live graphs</h3>
<p>Charts that update by themselves: your <b>wallet value</b> on the Dashboard (last hour, 6 or 24 hours), a trend line next to every open position (click it for a live chart with its stop-loss, targets and your buys and sells), each open <b>order's price against its target</b>, the scanner's results and the coins rising now, a profit line per <b>wallet</b>, a running total on the Trades report, and the same on your phone. Hover any chart to read exact values.</p>
<h3>Faster, smarter, safer trades</h3>
<ul>
<li><b>Faster copies:</b> the safety checks before a buy now run at the same time instead of one after another, and what never changes about a coin is remembered, so the bot gets in closer to the wallet you copy. The activity log shows how long the checks took.</li>
<li><b>Smart sizing</b> (Settings → Smart sizing): buy 1.5× when 2+ of your wallets buy the same coin within 10 minutes (and buy more once if a second wallet confirms a coin you hold); wallets that make you money get up to 1.5×, losing or hard-to-copy ones less; optionally skip a coin only one wallet bought small.</li>
<li><b>Market mood:</b> when SOL is dropping or most trending coins are falling, buys from signals are halved or paused until it improves.</li>
<li><b>Rug memory:</b> after a rug pull, Copybot never buys that coin again, nor coins from the wallet that created it.</li>
<li><b>Weekly settings check:</b> compares your exits with other setups on the last 7 days and suggests a better one on the Dashboard (nothing changes unless you press Use).</li>
<li><b>Live mode:</b> smart slippage per trade, and optional front-running protection that sends trades privately through Jito.</li>
</ul>
<h3>Panic button</h3>
<p><b>Sell everything &amp; stop</b> on the Dashboard and on your phone. Optionally set a <b>panic limit</b> (Settings → Limits) so Copybot does it by itself if today's total loss gets too big.</p>
<h3>Reports and taxes</h3>
<p>The Trades page shows your profit by day, week or month, your best and worst trades, and results per wallet. <b>Tax export</b> gives a year of trades with USD values and the gain on every sale.</p>
<h3>Fixes</h3>
<ul>
<li>The one-press paper experiment no longer fails with "Couldn't find active traders" when the market data service is busy: it retries, says what went wrong, and falls back to your last Find wallets results.</li>
<li>Find wallets now also looks at older, established coins.</li>
<li>The bot can start with only the scanner on, no wallets needed.</li>
<li>Selling part of a position by hand no longer sets off dump protection.</li>
</ul>
<h3>Under the hood</h3>
<ul>
<li>Groundwork for trading on more blockchains later: every trade, position, wallet and order now records which chain it's on (all Solana for now), and Settings show the dollar value of SOL amounts. Nothing changes in how Copybot trades.</li>
</ul>`,
  },
  {
    id: 'base', cat: 'features', mins: 3, title: 'Copying wallets on Base',
    teaser: 'Copy traders on Base, Coinbase\'s fast and cheap Ethereum network, alongside your Solana wallets.',
    body: `
<p>Copybot can copy wallets on <b>Base</b> as well as Solana. Start in <b>paper mode</b>: it shows you what copying would do, with real prices, without spending anything. Live trading on Base is available but <b>off until you switch it on</b>.</p>
<h3>Add a Base wallet</h3>
<p>On the Wallets page, paste an address that starts with <span class="mono">0x</span>. Copybot recognises it as a Base wallet and labels it. Start the bot in paper mode, and Base and Solana wallets are copied side by side.</p>
<h3>How it works</h3>
<ul>
<li><b>Watching:</b> Copybot checks Base every few seconds for your wallets' trades (a new Base block arrives every 2 seconds).</li>
<li><b>Prices:</b> from KyberSwap, which finds the best route across Base exchanges.</li>
<li><b>Safety checks:</b> every token is checked with GoPlus (honeypots, sell taxes over 10%, owners who can pause transfers, block sellers or change balances) plus the same buy-then-sell test as on Solana. Your liquidity filters and rug memory apply too.</li>
<li><b>Your books stay in SOL:</b> Base trades are in ETH, converted to SOL at the price of the moment. So your buy size, limits, profit, charts and reports all work the same way across both chains.</li>
</ul>
<h3>Good to know</h3>
<ul>
<li>The free public Base nodes limit how often they can be asked. For reliable copying, add a free Base RPC from Alchemy or QuickNode in <b>Settings → Connection</b>.</li>
<li>Find wallets, Analyze, backtests and the wallet check-up read Base history through Alchemy: add your free Alchemy Base URL in <b>Settings → Connection</b>.</li>
<li>Some Base traders use smart-contract wallets: copy the address that actually holds the tokens (it's the one shown on Basescan as receiving them).</li>
</ul>
<h3>Live trading on Base</h3>
<p>Use a <b>new wallet just for Copybot</b> holding only what you're willing to trade, never your main wallet. Paste its private key in <b>Settings → Trading wallet → Base</b> (it's encrypted on your computer), then turn on <b>Live trading on Base</b>. Before anything is signed, Copybot checks every transaction:</p>
<ul>
<li>it goes only to the KyberSwap router, and pays out to <b>your</b> wallet;</li>
<li>it sends exactly the ETH intended, and never more than your maximum network fee (Settings → Execution);</li>
<li>when selling, it approves exactly the amount being sold, never "unlimited";</li>
<li>it is rehearsed on Base first, and nothing is sent if the rehearsal fails.</li>
</ul>
<p>Start with tiny amounts until you've seen a few real trades go through.</p>`,
  },
  {
    id: 'phone', cat: 'features', mins: 3, title: 'Control Copybot from your phone (Tailscale)',
    teaser: 'Check profit and positions, start and stop, and sell from your phone, at home or anywhere.',
    body: `
<p>Copybot keeps running on your computer. Your phone gets a small Copybot screen that talks to it.</p>
<h3>Set it up once</h3>
<ol>
<li><b>Install Tailscale</b> on your computer and on your phone from <a href="https://tailscale.com/download" target="_blank" rel="noopener">tailscale.com/download</a>. It's free. Sign in with the <b>same account</b> on both. Tailscale is a private, encrypted link between your own devices: your phone can reach your computer from anywhere, and nobody else can.</li>
<li>In Copybot, go to <b>Settings → Phone access</b> and turn it on. If Windows asks whether to allow Copybot on networks, choose <b>Allow</b>.</li>
<li>Press <b>Pair a phone</b> and scan the QR code with your phone's camera. Give the phone a name and press <b>Pair this phone</b>.</li>
<li>In your phone's browser menu, choose <b>Add to Home Screen</b>. Now Copybot has its own icon.</li>
</ol>
<p>At home, your phone can also connect over the same Wi-Fi without Tailscale (pick <b>Home Wi-Fi</b> above the QR code). Away from home, keep Tailscale switched on, on the phone.</p>
<h3>What the phone can do</h3>
<ul>
<li>See your profit, open positions, trades and live activity.</li>
<li>Start and stop the bot, sell half or all of a position, and resume buying after the daily loss limit.</li>
<li>Turn the market scanner's two switches on and off.</li>
</ul>
<p>It <b>can't</b> change settings, switch between paper and live, or see or change keys and wallets. Those stay on the computer, so a lost phone can't empty your wallet.</p>
<h3>Staying safe</h3>
<ul>
<li>Each pairing QR code works <b>once</b> and only for 5 minutes. Don't share screenshots of it.</li>
<li>Copybot only answers your home network and Tailscale. Even if your router were set up to expose it, it refuses connections from the open internet. For the strictest setup, tick <b>Tailscale only</b>.</li>
<li>Lost a phone? Press <b>Remove</b> next to it in Settings → Phone access. It loses access immediately.</li>
<li>Your computer has to be on, with Copybot open, for the phone to connect.</li>
</ul>`,
  },
  {
    id: 'scanner', cat: 'features', mins: 4, title: 'The market scanner: finding traders and coins',
    teaser: 'Let Copybot look for opportunities while it runs: winning traders to copy, and rising coins to trade.',
    body: `
<p>The <b>Scanner</b> page has two switches. Both only work while the bot is running, and both stay inside your limits.</p>
<h3>Find traders</h3>
<p>Every few hours (6 by default) Copybot looks at coins that are moving: new launches <i>and</i> older, established coins. It finds traders who caught the move and reads their real track record. Then it <b>backtests</b> them with your settings and copy delay. Only traders whose backtest made money can be added, and they start on a <b>trial</b> at ¼ size, growing as they make you money. Any trader who loses 5 times in a row is paused.</p>
<h3>Trade coins</h3>
<p>About once a minute Copybot checks trending, new and high-volume coins and looks for one that is <b>rising the right way</b>:</p>
<ul>
<li>up over the last hour, but hasn't already run (not a coin that is up 300% today);</li>
<li>more buyers than sellers in the last hour;</li>
<li>more trading than usual;</li>
<li>not falling in the last 5 minutes.</li>
</ul>
<p>Older coins need deeper liquidity and a smaller move. You can turn new or older coins off in Settings → Market scanner.</p>
<p>Every scanner buy goes through the <b>same checks as a copied buy</b>: your loss limits, max positions and exposure, liquidity and holder filters, and the buy-then-sell honeypot check. It has its <b>own budget</b> and its <b>own quick exits</b>: stop-loss −20%, take profit +50%, a trailing stop once it's up 15%, and it sells after 12 hours. Momentum fades, so it doesn't hold forever.</p>
<h3>Be careful</h3>
<p>Momentum trading is risky. Many coins that are rising fall back, so expect plenty of small losses and hope for bigger wins. <b>Run it in paper mode first</b> and watch its profit on the Scanner page. It stops buying coins by itself after 5 losing trades in a row (the same rule that pauses a losing wallet).</p>`,
  },
  {
    id: 'whats-new-07', cat: 'news', mins: 4, title: "What's new in Copybot 0.7",
    teaser: 'Ready-made strategies, smarter wallet picking, a wallet check-up, better backtests and a profit chart.',
    body: `
<p>Copybot 0.7 is about trading smarter: picking better wallets, trading them the right way, and knowing which ones to drop.</p>
<h3>Strategies</h3>
<ul>
<li><b>Five ready-made strategies</b> on the new <b>Strategies</b> page: Balanced, Sniper, Whale follower, Momentum and Conservative. Each shows exactly which settings it changes before you switch, and never touches your SOL per buy, limits or safety checks.</li>
<li><b>A strategy per wallet:</b> press <b>Strategy</b> next to a wallet to give it its own, like Sniper for a fast flipper and Whale follower for a patient big buyer.</li>
<li><b>Compare strategies:</b> replay the wallets you copy with all five side by side and use the winner. If every strategy loses money, Copybot tells you the wallet is the problem.</li>
</ul>
<h3>Picking and keeping good wallets</h3>
<ul>
<li><b>Check my wallets</b> (Wallets page): backtests each wallet you copy on its own and marks it <i>worth keeping</i>, <i>losing you money</i> or <i>too few trades</i>, with one-click pause.</li>
<li><b>The wallet scout looks wider:</b> trending, new and top-volume tokens, different coins each search, and wallets that <b>caught a move</b> on busy tokens.</li>
<li><b>The scout backtests before it picks:</b> a wallet is only picked if copying it with <i>your</i> settings would have made money, and it suggests a strategy for each pick.</li>
<li><b>Trial period:</b> new wallets start at ¼ size and grow as they make you money. Any wallet pauses after 5 losing copies in a row (Settings → New wallets).</li>
</ul>
<h3>Better backtests</h3>
<ul>
<li><b>Backtest by date:</b> the last 24 hours, 3, 7 or 30 days, or your own dates.</li>
<li><b>Find my best settings:</b> compares 16 stop-loss and take-profit setups on the same trades.</li>
<li>Backtests now also replay <b>minimum token age</b> and <b>crash protection</b>.</li>
<li><b>Much faster:</b> wallet history is saved on your computer, so checking the same wallet again only downloads what's new.</li>
</ul>
<h3>Also new</h3>
<ul>
<li><b>One-press paper experiment:</b> press <b>Start bot</b> with no wallets in paper mode and Copybot picks 3 traders who just caught moves on different tokens, and starts copying them with a pretend <b>10 SOL paper wallet</b>. Nothing is spent.</li>
<li><b>Paper wallet:</b> the Dashboard shows your paper balance; paper buys stop when it runs out, and <b>Reset</b> starts a fresh experiment (old results are kept in the data folder).</li>
<li><b>Profit chart</b> on the Dashboard: your real results over 24 hours, 7 days, 30 days or all time.</li>
</ul>
<p class="tip">Start with <b>Check my wallets</b>. If a wallet is losing you money, no strategy will fix it: pause it and let the scout find a better one.</p>`,
  },
  {
    id: 'whats-new-06', cat: 'news', mins: 4, title: "What's new in Copybot 0.6",
    teaser: 'The wallet scout, backtesting, rug protection, phone alerts, faster trades and much more.',
    body: `
<p>Finding good wallets was the hardest part of copy trading. Now Copybot can do it for you.</p>
<h3>The wallet scout</h3>
<ol>
<li>It picks Solana tokens that <b>pumped recently</b> (up 30%+ in a day, a few hours to a week old, with real liquidity).</li>
<li>It finds the wallets that <b>bought them early</b>, and with a DexCheck key, their top traders too.</li>
<li>It checks each wallet's <b>real on-chain record</b>: win rate, profit, how long it holds, and whether it's a bot.</li>
<li><b>Claude picks the most suitable ones</b> and explains why. Without Claude, the rules rank them.</li>
</ol>
<p>Try it on <b>Find wallets → Find wallets for me</b>. It takes 5–15 minutes.</p>
<h3>Backtest</h3>
<p>The new <b>Backtest</b> page answers "what would copying these wallets have made?" It replays up to 5 wallets' real trades with your current settings, buying a little higher and selling a little lower than they did (you always trade after them). You get the total profit, win rate, worst dip, a chart and every trade. There's a <b>Backtest</b> button next to wallets on the Wallets and Find wallets pages too.</p>
<p class="tip">A wallet that made money for itself can still lose money for you, because you buy after it. Backtest before you copy.</p>
<h3>Solscan holder check</h3>
<p>Add a Solscan API key (Settings → Connection) and Copybot checks who owns each token before buying. It skips tokens that one wallet, or a small group, controls. Claude sees the same numbers when it decides. Change the limits in Settings → Token filters.</p>
<h3>With the autopilot</h3>
<p>If the autopilot manages your wallets, the scout runs by itself once a day while the bot is running and <b>adds its picks to your copy list</b> (2 per search, never more than your maximum). Change this in Settings → Autopilot.</p>
<p class="tip">Most wallets that catch one pump don't keep winning, so some searches find nothing good. That's the scout doing its job.</p>
<h3>Protecting your trades</h3>
<ul>
<li><b>Rug protection</b> (Settings → Rug protection): sells everything at once if a token's liquidity drains, its price crashes within minutes, or sellers swamp buyers.</li>
<li><b>Exits per wallet:</b> on the Wallets page, press <b>Exits</b> to give a wallet its own stop-loss and take-profits, e.g. tighter for a fast scalper.</li>
<li><b>Backtests replay your exits too:</b> stop-loss, take-profits and trailing stop, using price history.</li>
</ul>
<h3>Knowing what's happening</h3>
<ul>
<li><b>Phone alerts</b> on Telegram or Discord for trades, problems, the circuit breaker and autopilot decisions (Settings → Phone alerts).</li>
<li><b>Copy gap:</b> the Wallets page shows how much worse your price is than each wallet's, measured on your real trades. The Backtest can use your measured number.</li>
<li><b>Export CSV</b> on the Trades page, for spreadsheets and taxes.</li>
</ul>
<h3>Speed and reliability</h3>
<ul>
<li><b>Backup RPC:</b> add a second RPC in Settings → Connection and Copybot switches over automatically if your main one fails.</li>
<li><b>Jito tips</b> (Settings → Speed): in live mode, pay a small tip so trades land sooner when the network is busy.</li>
<li><b>Fast trade detection</b> with a Helius RPC that includes Enhanced WebSockets: Copybot sees the copied trade without an extra lookup.</li>
</ul>
<p>New installs also get a short <b>setup guide</b> on first launch (you can run it again from Settings → Look).</p>`,
  },
  {
    id: 'whats-new-05', cat: 'news', mins: 3, title: "What's new in Copybot 0.5",
    teaser: 'Smart exits, token filters, a circuit breaker, a wallet scoreboard, the Markets hub, the AI autopilot and a new look.',
    body: `
<p>Copybot 0.5 is the biggest update so far. Here's everything that changed.</p>
<h3>Trading</h3>
<ul>
<li><b>Staged exits.</b> At 2x Copybot takes your cost back, then takes profit at +300% and +900%, and a trailing stop protects the rest. See <a href="#" data-guide="exits">How exits work</a>.</li>
<li><b>Don't chase.</b> If the price is already more than 15% above what the copied wallet paid, Copybot skips the copy.</li>
<li><b>Token filters.</b> Minimum liquidity, maximum buy size compared to the pool, plus optional market-cap and token-age limits.</li>
<li><b>Circuit breaker.</b> No new buys after a 0.3 SOL loss in a day, and a 60-minute pause after 4 losing trades in a row (trades that lose under 2% count as break-even).</li>
<li><b>Wallet scoreboard.</b> Your own profit and win rate from each wallet you copy, with a per-wallet size and budget.</li>
</ul>
<h3>New pages</h3>
<ul>
<li><b>Markets:</b> prices, trending and brand-new Solana tokens, token details with charts, crypto news and a watchlist.</li>
<li><b>Autopilot:</b> let Claude decide what to buy, when to sell and which wallets to copy, always inside your limits.</li>
<li><b>Learn:</b> the guides you're reading now.</li>
</ul>
<h3>Look</h3>
<p>One new theme that mixes the clean modern layout with rainbow colors, in <b>light and dark</b>. Switch it in Settings → Look, or with the sun/moon button at the top. Copybot also has a new leaf icon.</p>
<p class="tip">Your old "sell everything at +150%" setting was switched off so the new staged exits can work. You can turn it back on in Settings → Selling.</p>`,
  },
  {
    id: 'getting-started', cat: 'start', mins: 4, title: 'Getting started with Copybot',
    teaser: 'From install to your first paper trade in five steps.',
    body: `
<p>Copybot watches Solana wallets you choose. When one of them buys or sells a token, Copybot can copy the trade within seconds.</p>
<ol class="big">
<li><b>Add a fast connection.</b> Settings → Connection → paste a free Helius RPC link. See <a href="#" data-guide="rpc">Connect a fast RPC</a>. The free public connection misses trades.</li>
<li><b>Find wallets worth copying.</b> Use <b>Find wallets</b> or the top traders in <b>Markets</b>, then check each one's record with <b>Analyze</b>. See <a href="#" data-guide="finding-wallets">Finding wallets worth copying</a>.</li>
<li><b>Add 2–3 wallets</b> on the Wallets page. Spreading across a few traders means one bad week doesn't sink you.</li>
<li><b>Start in paper mode.</b> Press <b>Start bot</b>. Paper mode simulates every trade with real prices, using a pretend 10 SOL wallet, and never spends money. No wallets yet? Press Start anyway and Copybot picks a few active traders for a quick experiment.</li>
<li><b>Review after a few days.</b> The Wallets scoreboard shows which wallets actually made <i>you</i> money. Pause the ones that didn't.</li>
</ol>
<p class="tip">Only go live after paper mode has been profitable for a while, and only with money you can afford to lose. See <a href="#" data-guide="going-live">Going live safely</a>.</p>`,
  },
  {
    id: 'rpc', cat: 'start', mins: 2, title: 'Connect a fast RPC (Helius)',
    teaser: "Why the free public connection misses trades, and how to fix it in two minutes.",
    body: `
<p>An <b>RPC</b> is Copybot's connection to the Solana blockchain. Every trade it sees and every price it checks goes through it.</p>
<p>The free public RPC is shared by everyone and heavily rate-limited. You'll see "RPC is rate-limiting the bot" in Live activity, and some trades get missed.</p>
<h3>Set up Helius (free)</h3>
<ol>
<li>Go to <b>helius.dev</b> and create a free account.</li>
<li>Copy your RPC link. It looks like <code>https://mainnet.helius-rpc.com/?api-key=…</code></li>
<li>In Copybot: <b>Settings → Connection</b>, paste it, then <b>Save connection</b> and <b>Test connection</b>.</li>
</ol>
<p>You should see green checkmarks, and the sidebar will say <b>Private RPC</b>.</p>`,
  },
  {
    id: 'finding-wallets', cat: 'strategy', mins: 5, title: 'Finding wallets worth copying',
    teaser: 'What a good copy target looks like, and the red flags that mean "skip".',
    body: `
<p>Copy trading is only as good as the wallets you copy. A wallet that looks amazing for one week is often just lucky, or is a bot you can't keep up with.</p>
<h3>Where to look</h3>
<ul>
<li><b>Backtest first:</b> before copying a wallet, run it on the Backtest page. It shows what copying it would have made <i>for you</i>, after the price you lose by trading later.</li>
<li><b>Find wallets → Find wallets for me:</b> the easiest way. Copybot picks tokens that pumped recently, finds their early buyers, checks each wallet's record, and Claude (or the rules) picks the best ones.</li>
<li><b>Find wallets → Discover early buyers:</b> paste 3–5 tokens that pumped recently. Wallets that were early on <i>several</i> of them rank highest.</li>
<li><b>Markets → Top traders</b> for a token (needs a free DexCheck key), with a <b>Copy</b> button.</li>
</ul>
<h3>What good looks like (Analyze)</h3>
<ul>
<li><b>Many closed trades</b>, ideally weeks or months of them. One huge win proves nothing.</li>
<li><b>Positive profit and ROI</b> across those trades, with a win rate that isn't wildly high (real traders lose often).</li>
<li><b>Holds of minutes to hours</b>, not seconds. You always buy after them, so you need time to catch up.</li>
<li><b>Fewer than ~100 trades a day.</b> More than that is usually a bot.</li>
</ul>
<h3>Red flags</h3>
<ul>
<li>"+1,000% last month": usually huge risk, not skill.</li>
<li>Most of the profit from a single trade.</li>
<li>Tiny buys that they sell seconds later.</li>
</ul>
<p class="tip">Copy 2–3 wallets with different styles, then check the Wallets scoreboard weekly. Pause wallets that are losing you money.</p>`,
  },
  {
    id: 'exits', cat: 'strategy', mins: 4, title: 'How exits work: take back cost, take-profits, trailing stop',
    teaser: 'Copybot sells in stages so you lock in wins without missing the big runs.',
    body: `
<p><b>Rule #1: a profitable trade is a good trade.</b> Once a trade has been up 20%, Copybot never lets it end as a loss: if it falls back to +5% (enough to cover fees), it sells everything and keeps the win. Both numbers are in <b>Settings → Selling</b>; open positions show 🔒 once their profit is locked.</p>
<p>Selling everything at one target means you either sell too early or give it all back. Copybot sells in steps instead. All percentages are gains over <b>your</b> entry price (+100% = 2x).</p>
<ol class="big">
<li><b>Take back my cost (+100%).</b> At 2x, Copybot sells just enough to get your original SOL back, which is half the position. The rest is "free".</li>
<li><b>Take-profit 1 (+300%):</b> sell 50% of what's left.</li>
<li><b>Take-profit 2 (+900%):</b> sell 50% of what's left again.</li>
<li><b>Trailing stop.</b> Once a token has been up 50%, Copybot remembers its highest value. If it then falls 30% from that peak, it sells everything.</li>
<li><b>Stop-loss (−40%):</b> if a position falls 40% from your entry, Copybot sells everything.</li>
</ol>
<h3>Example</h3>
<p>You buy for 0.05 SOL. It goes to 2x: Copybot sells 0.05 SOL worth and you're back to even. It runs to 5x and then drops: the trailing stop sells the rest around 3.5x. You kept a big part of the run, with no risk after the first step.</p>
<p>The Dashboard's <b>Exit plan</b> column shows ✓ next to steps that are done, and where the trailing stop will sell. Every step is adjustable in <b>Settings → Selling</b>; set a step to 0 to turn it off.</p>`,
  },
  {
    id: 'risk', cat: 'strategy', mins: 4, title: 'Sizing and risk limits',
    teaser: 'How much to put in each trade, budgets per wallet, and the circuit breaker.',
    body: `
<p>Meme coins can drop 90% in minutes. Good sizing keeps one bad trade, or one bad day, from hurting you.</p>
<ul>
<li><b>Keep each buy small.</b> A common rule is to risk only 1–2% of your trading money per position on volatile tokens. Settings → Buying sets the amount.</li>
<li><b>Cap the total.</b> "Max SOL in open positions" limits how much can be in trades at once.</li>
<li><b>Per-wallet Size ×.</b> On the Wallets page you can copy your best wallet at 1.5× and a riskier one at 0.5×.</li>
<li><b>Per-wallet Budget.</b> Caps how much SOL a single wallet's trades can tie up.</li>
</ul>
<h3>The circuit breaker</h3>
<p>Two automatic brakes protect you on a bad day (Settings → Limits):</p>
<ul>
<li><b>Daily loss limit (0.3 SOL):</b> no new buys for the rest of the day.</li>
<li><b>Losing streak (4 in a row):</b> a 60-minute cool-down.</li>
</ul>
<p>Sells, stop-losses and take-profits always keep running. You can override it with <b>Resume buying</b> on the Dashboard.</p>
<p class="tip">If you raise your trade sizes, raise the daily loss limit to match. Otherwise it will trip after a single loss.</p>`,
  },
  {
    id: 'safety-checks', cat: 'safety', mins: 5, title: 'The safety checks, explained',
    teaser: "Everything Copybot checks before it buys, and before it signs anything.",
    body: `
<p>Before every buy, a token has to pass all of these:</p>
<ul>
<li><b>Freeze check:</b> skips tokens whose creator can freeze your tokens so you can't sell.</li>
<li><b>Buy-then-sell test:</b> gets a quote to buy and then sell straight back. If it can't sell, or the round trip loses more than 12%, it skips. This catches most "honeypots" and very thin pools.</li>
<li><b>Liquidity filters:</b> skips pools under $10K, and buys that would be more than 2% of the pool.</li>
<li><b>Holder check</b> (with a Solscan API key): skips tokens where one wallet owns more than 15% of the supply, or the 10 largest wallets own more than 50%. Those wallets can dump on you at any moment. Liquidity pools don't count as holders.</li>
<li><b>Don't chase:</b> skips if the price is already 15% above what the copied wallet paid.</li>
<li><b>Limits and budgets:</b> max positions, max SOL in trades, per-wallet budgets, and the circuit breaker.</li>
</ul>
<h3>Before signing a live trade</h3>
<p>Copybot checks every swap transaction <b>before</b> your wallet signs it:</p>
<ul>
<li>It may only use the expected programs.</li>
<li>It can't send SOL or tokens anywhere except your own accounts.</li>
<li>Its fee must be within your limit.</li>
<li>It's simulated against the live blockchain to confirm it takes no more SOL than the trade plus fees.</li>
</ul>
<p>Even a hacked data provider can't empty your wallet.</p>
<p class="tip">Pump.fun tokens still on their bonding curve have no pool size listed. For those, the buy-then-sell test is what measures the real exit cost.</p>`,
  },
  {
    id: 'going-live', cat: 'safety', mins: 3, title: 'Going live safely',
    teaser: 'The checklist before you let Copybot spend real SOL.',
    body: `
<ol class="big">
<li><b>Paper trade first,</b> for at least a few days, and check that the Wallets scoreboard is positive.</li>
<li><b>Use a brand-new wallet</b> just for Copybot (in Phantom: add a new account), funded only with money you can afford to lose.</li>
<li><b>Add a fast RPC.</b> Live trading on the free connection misses exits too, not just entries.</li>
<li><b>Paste the key</b> in Settings → Trading wallet. On Windows it's encrypted so only your user account can read it. It never leaves your PC.</li>
<li><b>Switch Settings → Trading mode to Live</b> and start the bot.</li>
</ol>
<p class="tip">Start with small buys. You can always raise them once live results match paper.</p>`,
  },
  {
    id: 'autopilot', cat: 'features', mins: 5, title: 'The AI autopilot (Claude)',
    teaser: 'What Claude decides, what it can never do, what it costs, and how to judge it.',
    body: `
<p>The autopilot lets <b>Claude</b>, Anthropic's AI model, make the trading decisions:</p>
<ul>
<li><b>Buys:</b> for each copy signal that passes the safety checks, Claude decides <i>buy or skip</i> and how much, and explains why.</li>
<li><b>Open positions:</b> every few minutes it reviews them and can sell early or hold.</li>
<li><b>Wallets:</b> it reviews your copied wallets and can pause them or adjust sizes and budgets.</li>
<li><b>Finding new wallets:</b> once a day (Settings → Autopilot) the <b>wallet scout</b> scans tokens that pumped recently, finds who bought them early, checks those wallets' real records, and Claude adds the most suitable ones to your list, up to your maximum.</li>
</ul>
<h3>What it can never do</h3>
<ul>
<li>Go past your limits: trade size, total SOL, budgets, daily loss limit, stop-loss.</li>
<li>Skip any safety check, or send money anywhere except through normal buys and sells.</li>
<li>Copy a wallet whose track record wasn't checked first.</li>
</ul>
<h3>Cost</h3>
<p>You use your own Anthropic API key (from console.anthropic.com) and pay Anthropic per decision, roughly <b>$0.02–0.04</b> each with Claude Opus 5.5. A <b>daily AI budget</b> (Settings → Autopilot) caps the spend. When it's used up, Copybot falls back to its normal rules.</p>
<h3>Is it working?</h3>
<p>The Autopilot page tracks every decision. For buys Claude <i>skipped</i>, it records what they would have made an hour later, so you can see whether its skips helped. Judge it in paper mode first.</p>
<p class="tip">No AI can reliably predict meme coins. Treat the autopilot as an experiment, and let the numbers decide whether it stays on.</p>`,
  },
  {
    id: 'markets', cat: 'features', mins: 3, title: 'Using the Markets hub',
    teaser: 'Prices, trending and new tokens, token details, news and your watchlist.',
    body: `
<ul>
<li><b>Overview:</b> BTC, ETH and SOL prices and their 24-hour change.</li>
<li><b>Trending and New pools:</b> the hottest Solana pools right now, and brand-new launches. Click any token to see details.</li>
<li><b>Token details:</b> price chart, liquidity, market cap, volume, buys vs sells and age. These are the same numbers Copybot's filters use.</li>
<li><b>Watchlist:</b> star a token to keep it on your list.</li>
<li><b>News:</b> headlines from Blockworks, CoinDesk, The Block and Decrypt. Click one to read it in your browser.</li>
<li><b>Whales and top traders</b> (optional): add a free DexCheck API key in Settings to see big trades and the best traders on a token, with buttons to Analyze or Copy them.</li>
</ul>
<p class="tip">High volume with low liquidity, or far more sells than buys, are warning signs. The Markets hub shows both at a glance.</p>`,
  },
  {
    id: 'glossary', cat: 'start', mins: 4, title: 'Glossary: trading words in plain English',
    teaser: 'Liquidity, slippage, market cap, bonding curve, honeypot and more.',
    body: `
<dl class="gloss">
<dt>SOL</dt><dd>Solana's coin. Copybot buys and sells tokens with SOL.</dd>
<dt>Token / mint</dt><dd>A coin on Solana. Its "mint address" is its unique ID.</dd>
<dt>Liquidity</dt><dd>How much money sits in a token's trading pool. More liquidity means you can buy and sell without moving the price much.</dd>
<dt>Slippage</dt><dd>The difference between the price you expected and the price you got. Thin pools mean big slippage.</dd>
<dt>Market cap</dt><dd>Price × supply: the total value of all tokens. Under $1M is the riskiest tier.</dd>
<dt>Bonding curve</dt><dd>How brand-new pump.fun tokens trade before they "graduate" to a normal pool.</dd>
<dt>Honeypot</dt><dd>A scam token you can buy but can't sell.</dd>
<dt>Rug pull</dt><dd>When creators pull the money out of the pool and the price collapses.</dd>
<dt>P&amp;L</dt><dd>Profit and loss. "Realized" means from sells you've made; "open" means if you sold now.</dd>
<dt>Stop-loss / take-profit</dt><dd>Automatic sells when a position falls or rises by a set amount.</dd>
<dt>Trailing stop</dt><dd>A stop-loss that moves up as the price rises, to protect gains.</dd>
<dt>RPC</dt><dd>Copybot's connection to the blockchain.</dd>
<dt>Paper trading</dt><dd>Simulated trading with real prices and no real money.</dd>
</dl>`,
  },
];
