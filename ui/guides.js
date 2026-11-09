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
<li><b>Circuit breaker.</b> No new buys after a 0.3 SOL loss in a day, and a 60-minute pause after 4 losing trades in a row.</li>
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
