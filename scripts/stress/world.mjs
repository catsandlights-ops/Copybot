// A made-up Solana market for stress-testing Copybot offline: coins with moving prices (pumps,
// dumps, rugs, coins nobody will buy), traders buying and selling every few seconds, and answers
// in the exact formats of a Solana node, Jupiter and Dexscreener. Optional chaos: "429 Too Many
// Requests", slow answers and broken replies. Not part of the app.
import http from 'node:http';
import crypto from 'node:crypto';
import bs58mod from 'bs58';

const bs58 = bs58mod.default ?? bs58mod;
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL_USD = 150;
const RENT = 2_039_280;

export function createWorld(o = {}) {
  const opt = { port: 0, wallets: 8, coins: 40, tradeEveryMs: 1200, chaos: 0.05, slow: 0.02, broken: 0.005, rugChance: 0.0005, ...o };
  let rand = crypto.randomBytes(4).readUInt32LE(0);
  const rnd = () => ((rand = (rand * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const key = () => bs58.encode(crypto.randomBytes(32));
  const sigOf = () => bs58.encode(crypto.randomBytes(64));
  const now = () => Date.now();
  let slot = 300_000_000;
  const stats = { txs: 0, rugs: 0, pumps: 0, dumps: 0, requests: 0, chaos429: 0, slow: 0, broken: 0, quotes: 0 };

  // ---------- coins ----------
  const coins = Array.from({ length: opt.coins }, (_, i) => ({
    mint: key(),
    symbol: `C${i}`,
    decimals: 6,
    price: 1e-7 * Math.exp(rnd() * 6), // SOL per whole token
    liquidityUsd: 5_000 + rnd() * 200_000,
    createdAt: now() - rnd() * 7 * 86_400_000,
    rugged: false,
    noRoute: false,
    events: [], // [time, 'buy'|'sell'] for 5-minute counts
    hist: [], // [time, price] for 5-minute change
  }));
  const coinBy = new Map(coins.map((c) => [c.mint, c]));
  const tick = () => {
    const t = now();
    for (const c of coins) {
      if (c.rugged) continue;
      c.price *= Math.exp((rnd() - 0.5) * 0.04);
      if (rnd() < 0.002) { c.price *= 1.5 + rnd() * 1.5; stats.pumps++; }
      if (rnd() < 0.002) { c.price *= 0.3 + rnd() * 0.4; stats.dumps++; }
      if (rnd() < opt.rugChance) { c.rugged = true; c.liquidityUsd = 0; c.price *= 0.01; stats.rugs++; }
      if (rnd() < opt.rugChance / 2) c.noRoute = true; // nobody will buy it anymore
      c.hist.push([t, c.price]);
      while (c.hist.length && c.hist[0][0] < t - 3_600_000) c.hist.shift();
      while (c.events.length && c.events[0][0] < t - 300_000) c.events.shift();
    }
    slot += 1;
  };
  const marketTimer = setInterval(tick, 500);

  // ---------- traders ----------
  const wallets = Array.from({ length: opt.wallets }, (_, i) => ({ address: key(), lamports: 10_000n * 1_000_000_000n, holdings: new Map(), tokenAccounts: new Map(), sigs: [], style: i % 3 }));
  const walletBy = new Map(wallets.map((w) => [w.address, w]));
  const txs = new Map();
  const record = (w, c, side, lamportsDelta, tokensBefore, tokensAfter) => {
    const sig = sigOf();
    const t = Math.floor(now() / 1000);
    let ta = w.tokenAccounts.get(c.mint);
    const newAccount = !ta;
    if (!ta) w.tokenAccounts.set(c.mint, (ta = key()));
    const fee = 5000;
    const pre = w.lamports;
    const post = pre + lamportsDelta - BigInt(fee) - (newAccount ? BigInt(RENT) : 0n);
    w.lamports = post;
    const bal = (amount) => ({ accountIndex: 1, mint: c.mint, owner: w.address, programId: TOKENKEG, uiTokenAmount: { amount: amount.toString(), decimals: c.decimals, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) } });
    txs.set(sig, {
      slot,
      blockTime: t,
      wallet: w.address,
      accountKeys: [w.address, ta, c.mint],
      meta: {
        err: null,
        fee,
        preBalances: [Number(pre), newAccount ? 0 : RENT, 1_461_600],
        postBalances: [Number(post), RENT, 1_461_600],
        preTokenBalances: newAccount ? [] : [bal(tokensBefore)],
        postTokenBalances: [bal(tokensAfter)],
        logMessages: [],
        innerInstructions: [],
      },
    });
    w.sigs.unshift({ signature: sig, slot, err: null, memo: null, blockTime: t, confirmationStatus: 'finalized' });
    if (w.sigs.length > 2000) w.sigs.length = 2000;
    c.events.push([now(), side]);
    stats.txs++;
    if (txs.size > 50_000) txs.delete(txs.keys().next().value);
  };
  const traderTick = () => {
    for (const w of wallets) {
      if (rnd() > 0.35) continue;
      const held = [...w.holdings.entries()].filter(([, a]) => a > 0n);
      if (held.length && rnd() < 0.45) {
        const [mint, amount] = held[Math.floor(rnd() * held.length)];
        const c = coinBy.get(mint);
        if (c.noRoute && rnd() < 0.9) continue;
        const frac = rnd() < 0.5 ? 1 : 0.1 + rnd() * 0.8;
        const sell = frac >= 1 ? amount : BigInt(Math.floor(Number(amount) * frac));
        if (sell <= 0n) continue;
        const sol = (Number(sell) / 1e6) * c.price;
        record(w, c, 'sell', BigInt(Math.floor(sol * 1e9)), amount, amount - sell);
        w.holdings.set(mint, amount - sell);
      } else {
        const live = coins.filter((c) => !c.rugged && !c.noRoute);
        const c = rnd() < 0.3 && held.length ? coinBy.get(held[0][0]) : live[Math.floor(rnd() * live.length)];
        if (!c) continue;
        // Styles: small buyers, mixed, whales (some buys are tiny "test" buys).
        const sol = w.style === 0 ? 0.03 + rnd() * 0.1 : w.style === 1 ? (rnd() < 0.2 ? 0.01 : 0.2 + rnd() * 1.5) : 2 + rnd() * 8;
        const tokens = BigInt(Math.floor((sol / c.price) * 1e6));
        const before = w.holdings.get(c.mint) ?? 0n;
        record(w, c, 'buy', -BigInt(Math.floor(sol * 1e9)), before, before + tokens);
        w.holdings.set(c.mint, before + tokens);
      }
    }
  };
  const traderTimer = setInterval(traderTick, opt.tradeEveryMs);

  // ---------- answers ----------
  const change5m = (c) => {
    const old = c.hist.find(([t]) => t >= now() - 300_000);
    return old ? (c.price / old[1] - 1) * 100 : 0;
  };
  const quote = (inputMint, outputMint, amount, slippageBps) => {
    stats.quotes++;
    const amt = BigInt(amount);
    if (inputMint === WSOL && outputMint === USDC) return { out: (amt * BigInt(SOL_USD * 1e6)) / 1_000_000_000n, impact: 0 };
    const buying = inputMint === WSOL;
    const c = coinBy.get(buying ? outputMint : inputMint);
    if (!c || c.rugged || c.noRoute) return null;
    if (buying) {
      const sol = Number(amt) / 1e9;
      const impact = Math.min(0.5, (sol * SOL_USD) / Math.max(1, c.liquidityUsd));
      return { out: BigInt(Math.floor((sol / c.price) * (1 - impact) * 1e6)), impact };
    }
    const sol = (Number(amt) / 1e6) * c.price;
    const impact = Math.min(0.5, (sol * SOL_USD) / Math.max(1, c.liquidityUsd));
    return { out: BigInt(Math.floor(sol * (1 - impact) * 1e9)), impact };
  };
  const rpc = (m, p) => {
    const ctx = (value) => ({ context: { slot, apiVersion: '2.0.0' }, value });
    switch (m) {
      case 'getSignaturesForAddress': {
        const w = walletBy.get(p[0]);
        if (!w) return [];
        const { limit = 1000, before } = p[1] ?? {};
        let list = w.sigs;
        if (before) list = list.slice(list.findIndex((s) => s.signature === before) + 1);
        return list.slice(0, limit);
      }
      case 'getTransaction': {
        const tx = txs.get(p[0]);
        if (!tx || p[1]?.encoding !== 'jsonParsed') return null;
        return { slot: tx.slot, blockTime: tx.blockTime, version: 0, transaction: { signatures: [p[0]], message: { accountKeys: tx.accountKeys.map((k, i) => ({ pubkey: k, signer: i === 0, writable: i < 2, source: 'transaction' })), instructions: [], recentBlockhash: key() } }, meta: tx.meta };
      }
      case 'getAccountInfo': {
        const c = coinBy.get(p[0]);
        if (!c) return ctx(null);
        return ctx({ data: { parsed: { info: { decimals: c.decimals, freezeAuthority: null, mintAuthority: null, isInitialized: true, supply: '1000000000000000' }, type: 'mint' }, program: 'spl-token', space: 82 }, executable: false, lamports: 1_461_600, owner: TOKENKEG, rentEpoch: 0, space: 82 });
      }
      case 'getTokenSupply': return ctx({ amount: '1000000000000000', decimals: 6, uiAmount: 1e9, uiAmountString: '1000000000' });
      case 'getBalance': return ctx(10_000_000_000);
      case 'getBlockHeight': return slot;
      case 'getSlot': return slot;
      case 'getLatestBlockhash': return ctx({ blockhash: key(), lastValidBlockHeight: slot + 150 });
      case 'getSignatureStatuses': return ctx((p[0] ?? []).map(() => null));
      case 'getHealth': return 'ok';
      case 'getVersion': return { 'solana-core': '2.0.0', 'feature-set': 1 };
      case 'getMultipleAccounts': return ctx((p[0] ?? []).map(() => null));
      case 'getParsedTokenAccountsByOwner':
      case 'getTokenAccountsByOwner': return ctx([]);
      default: return null;
    }
  };
  const chaos = (res) => {
    if (rnd() < opt.chaos) { stats.chaos429++; res.writeHead(429, { 'content-type': 'text/plain' }); res.end('Too Many Requests'); return true; }
    if (rnd() < opt.broken) { stats.broken++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","res'); return true; }
    return false;
  };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    stats.requests++;
    let raw = '';
    for await (const ch of req) raw += ch;
    if (rnd() < opt.slow) { stats.slow++; await new Promise((r) => setTimeout(r, 2000 + rnd() * 6000)); }
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/rpc') {
        if (chaos(res)) return;
        const body = JSON.parse(raw || '{}');
        const one = (q) => ({ jsonrpc: '2.0', id: q.id, result: rpc(q.method, q.params ?? []) });
        return json(res, 200, Array.isArray(body) ? body.map(one) : one(body));
      }
      if (url.pathname.startsWith('/jup/')) {
        if (chaos(res)) return;
        if (url.pathname.endsWith('/quote')) {
          const q = quote(url.searchParams.get('inputMint'), url.searchParams.get('outputMint'), url.searchParams.get('amount'), Number(url.searchParams.get('slippageBps')));
          if (!q) return json(res, 400, { error: 'Could not find any route' });
          return json(res, 200, { inputMint: url.searchParams.get('inputMint'), inAmount: url.searchParams.get('amount'), outputMint: url.searchParams.get('outputMint'), outAmount: q.out.toString(), otherAmountThreshold: q.out.toString(), swapMode: 'ExactIn', slippageBps: Number(url.searchParams.get('slippageBps')), priceImpactPct: String(q.impact), routePlan: [], contextSlot: slot, timeTaken: 0.01 });
        }
        if (url.pathname.includes('/price/')) {
          const out = {};
          for (const id of (url.searchParams.get('ids') ?? '').split(',')) {
            if (id === WSOL) out[id] = { usdPrice: SOL_USD, decimals: 9 };
            const c = coinBy.get(id);
            if (c && !c.rugged) out[id] = { usdPrice: c.price * SOL_USD, decimals: c.decimals, liquidity: c.liquidityUsd };
          }
          return json(res, 200, out);
        }
        return json(res, 404, {});
      }
      if (url.pathname.startsWith('/dex/')) {
        const mints = decodeURIComponent(url.pathname.split('/tokens/')[1] ?? '').split(',');
        const pairs = mints.map((m) => coinBy.get(m)).filter(Boolean).map((c) => {
          const ev = c.events;
          const buys = ev.filter(([, s]) => s === 'buy').length, sells = ev.length - buys;
          return { chainId: 'solana', dexId: 'raydium', pairAddress: key(), baseToken: { address: c.mint, name: `Coin ${c.symbol}`, symbol: c.symbol }, quoteToken: { address: WSOL, name: 'Wrapped SOL', symbol: 'SOL' }, priceUsd: String(c.price * SOL_USD), liquidity: { usd: c.liquidityUsd }, marketCap: c.price * SOL_USD * 1e9, fdv: c.price * SOL_USD * 1e9, pairCreatedAt: c.createdAt, priceChange: { m5: change5m(c), h1: 0, h24: 0 }, txns: { m5: { buys, sells }, h1: { buys, sells } }, volume: { h24: 10_000 } };
        });
        return json(res, 200, { schemaVersion: '1.0.0', pairs });
      }
      return json(res, 404, {});
    } catch (e) {
      return json(res, 500, { error: String(e) });
    }
  });
  return {
    stats,
    coins,
    wallets,
    listen: () => new Promise((r) => server.listen(opt.port, '127.0.0.1', () => r(server.address().port))),
    close: () => { clearInterval(marketTimer); clearInterval(traderTimer); server.close(); },
  };
}
