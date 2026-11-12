// A made-up Solana (and Base) market for stress-testing Copybot offline: coins with moving prices (pumps,
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
const ETH_USD = 3000;
const SOL_PER_ETH = ETH_USD / SOL_USD;
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (n) => '0x' + BigInt(n).toString(16);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const topicOf = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const RENT = 2_039_280;

export function createWorld(o = {}) {
  const opt = { port: 0, wallets: 8, coins: 40, baseWallets: 0, baseCoins: 20, tradeEveryMs: 1200, chaos: 0.05, slow: 0.02, broken: 0.005, rugChance: 0.0005, ...o };
  let rand = crypto.randomBytes(4).readUInt32LE(0);
  const rnd = () => ((rand = (rand * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const key = () => bs58.encode(crypto.randomBytes(32));
  const evmAddr = () => '0x' + crypto.randomBytes(20).toString('hex');
  const sigOf = () => bs58.encode(crypto.randomBytes(64));
  const now = () => Date.now();
  let slot = 300_000_000;
  const stats = { baseTxs: 0, txs: 0, rugs: 0, pumps: 0, dumps: 0, requests: 0, chaos429: 0, slow: 0, broken: 0, quotes: 0 };

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
  // Base coins: same moving prices (still SOL per whole token), 18 decimals, each with a pool.
  for (let i = 0; i < (opt.baseWallets ? opt.baseCoins : 0); i++)
    coins.push({ mint: evmAddr(), pool: evmAddr(), chain: 'base', symbol: `B${i}`, decimals: 18, price: 1e-7 * Math.exp(rnd() * 6), liquidityUsd: 5_000 + rnd() * 200_000, createdAt: now() - rnd() * 7 * 86_400_000, rugged: false, noRoute: false, events: [], hist: [] });
  const solCoins = coins.filter((c) => c.chain !== 'base');
  const baseCoins = coins.filter((c) => c.chain === 'base');
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
        const live = solCoins.filter((c) => !c.rugged && !c.noRoute);
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

  // ---------- Base: blocks every 2 s, traders paying ETH and paid out in WETH ----------
  let block = 20_000_000;
  const blockTime = new Map([[block, Math.floor(now() / 1000)]]);
  const blockTimer = setInterval(() => { block++; blockTime.set(block, Math.floor(now() / 1000)); if (blockTime.size > 5000) blockTime.delete(blockTime.keys().next().value); }, 2000);
  const baseWallets = Array.from({ length: opt.baseWallets }, (_, i) => ({ address: evmAddr(), holdings: new Map(), style: i % 3 }));
  const evmTxs = new Map(); // hash -> { from, value, block, logs }
  const evmLogs = []; // recent logs, for eth_getLogs
  const balHist = new Map(); // `${token}:${owner}` -> [[block, balance]]
  const setBal = (token, owner, v) => {
    const k = `${token}:${owner}`;
    const h = balHist.get(k) ?? [];
    h.push([block, v]);
    if (h.length > 200) h.shift();
    balHist.set(k, h);
  };
  const balAt = (token, owner, at) => {
    const h = balHist.get(`${token}:${owner}`) ?? [];
    let v = 0n;
    for (const [b, x] of h) if (b <= at) v = x;
    return v;
  };
  const transferLog = (token, from, to, amount, hash) => ({ address: token, topics: [TRANSFER, topicOf(from), topicOf(to)], data: word(amount), blockNumber: hex(block), transactionHash: hash, logIndex: '0x0', removed: false });
  const evmRecord = (w, c, side, wei, tokens) => {
    const hash = '0x' + crypto.randomBytes(32).toString('hex');
    const logs = side === 'buy' ? [transferLog(c.mint, c.pool, w.address, tokens, hash)] : [transferLog(c.mint, w.address, c.pool, tokens, hash), transferLog(WETH, c.pool, w.address, wei, hash)];
    evmTxs.set(hash, { from: w.address, value: side === 'buy' ? wei : 0n, block, logs });
    evmLogs.push(...logs);
    if (evmLogs.length > 20_000) evmLogs.splice(0, 5000);
    if (evmTxs.size > 50_000) evmTxs.delete(evmTxs.keys().next().value);
    c.events.push([now(), side]);
    stats.txs++;
    stats.baseTxs++;
  };
  const baseTick = () => {
    for (const w of baseWallets) {
      if (rnd() > 0.3) continue;
      const held = [...w.holdings.entries()].filter(([, a]) => a > 0n);
      if (held.length && rnd() < 0.45) {
        const [mint, amount] = held[Math.floor(rnd() * held.length)];
        const c = coinBy.get(mint);
        if (c.noRoute && rnd() < 0.9) continue;
        const frac = rnd() < 0.5 ? 1 : 0.1 + rnd() * 0.8;
        const sell = frac >= 1 ? amount : (amount * BigInt(Math.floor(frac * 1e6))) / 1_000_000n;
        if (sell <= 0n) continue;
        const sol = (Number(sell) / 1e18) * c.price;
        evmRecord(w, c, 'sell', BigInt(Math.floor((sol / SOL_PER_ETH) * 1e18)), sell);
        w.holdings.set(mint, amount - sell);
        setBal(mint, w.address, amount - sell);
      } else {
        const live = baseCoins.filter((c) => !c.rugged && !c.noRoute);
        const c = live[Math.floor(rnd() * live.length)];
        if (!c) continue;
        const sol = w.style === 0 ? 0.05 + rnd() * 0.2 : w.style === 1 ? 0.3 + rnd() * 1.5 : 2 + rnd() * 6;
        const tokens = BigInt(Math.floor((sol / c.price) * 1e6)) * 10n ** 12n;
        const before = w.holdings.get(c.mint) ?? 0n;
        evmRecord(w, c, 'buy', BigInt(Math.floor((sol / SOL_PER_ETH) * 1e18)), tokens);
        w.holdings.set(c.mint, before + tokens);
        setBal(c.mint, w.address, before + tokens);
      }
    }
  };
  const baseTimer = opt.baseWallets ? setInterval(baseTick, opt.tradeEveryMs * 1.5) : null;
  const evm = (m, p) => {
    switch (m) {
      case 'eth_chainId': return '0x2105';
      case 'eth_blockNumber': return hex(block);
      case 'eth_getLogs': {
        const f = p[0] ?? {};
        const from = Number(f.fromBlock ?? 0), to = f.toBlock === 'latest' ? block : Number(f.toBlock ?? block);
        const match = (want, have) => want == null || (Array.isArray(want) ? want.includes(have) : want === have);
        return evmLogs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to && (f.topics ?? []).every((t, i) => match(t, l.topics[i])));
      }
      case 'eth_getTransactionByHash': {
        const t = evmTxs.get(p[0]);
        return t ? { hash: p[0], from: t.from, value: hex(t.value), blockNumber: hex(t.block) } : null;
      }
      case 'eth_getTransactionReceipt': {
        const t = evmTxs.get(p[0]);
        return t ? { transactionHash: p[0], from: t.from, blockNumber: hex(t.block), status: '0x1', logs: t.logs, gasUsed: '0x30d40', effectiveGasPrice: '0x3b9aca0' } : null;
      }
      case 'eth_getBlockByNumber': {
        const b = p[0] === 'latest' ? block : Number(p[0]);
        return { number: hex(b), timestamp: hex(blockTime.get(b) ?? Math.floor(now() / 1000)) };
      }
      case 'eth_call': {
        const { to, data = '' } = p[0] ?? {};
        if (data.startsWith('0x313ce567')) return word(coinBy.get(String(to).toLowerCase())?.decimals ?? 18);
        if (data.startsWith('0x70a08231')) {
          const owner = '0x' + data.slice(-40);
          const at = p[1] === 'latest' || p[1] == null ? block : Number(p[1]);
          return word(balAt(String(to).toLowerCase(), owner, at));
        }
        return '0x';
      }
      case 'eth_getBalance': return hex(10_000n * 10n ** 18n);
      case 'eth_getCode': return '0x';
      case 'eth_getTransactionCount': return '0x10';
      case 'eth_gasPrice': return '0x3b9aca0';
      default: return null;
    }
  };
  const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const kyber = (tokenIn, tokenOut, amountIn) => {
    stats.quotes++;
    const tin = tokenIn.toLowerCase(), tout = tokenOut.toLowerCase(), amt = BigInt(amountIn);
    if (tin === NATIVE && tout === USDC_BASE) return (amt * BigInt(ETH_USD * 1e6)) / 10n ** 18n;
    const buying = tin === NATIVE;
    const c = coinBy.get(buying ? tout : tin);
    if (!c || c.rugged || c.noRoute) return null;
    if (buying) {
      const sol = (Number(amt) / 1e18) * SOL_PER_ETH;
      const impact = Math.min(0.5, (sol * SOL_USD) / Math.max(1, c.liquidityUsd));
      return BigInt(Math.floor((sol / c.price) * (1 - impact) * 1e6)) * 10n ** 12n;
    }
    const sol = (Number(amt) / 1e18) * c.price;
    const impact = Math.min(0.5, (sol * SOL_USD) / Math.max(1, c.liquidityUsd));
    return BigInt(Math.floor((sol * (1 - impact)) / SOL_PER_ETH * 1e18));
  };

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
      // A fake local AI (Ollama): sensible answers mostly, sometimes chatter, nonsense or slow.
      if (url.pathname === '/api/tags') return json(res, 200, { models: [{ name: 'fake:7b', size: 4.7e9, details: { parameter_size: '7B' } }, { name: 'fake:14b', size: 9e9, details: { parameter_size: '14B' } }] });
      if (url.pathname === '/api/chat') {
        stats.ai = (stats.ai ?? 0) + 1;
        const q = JSON.parse(raw || '{}');
        const props = q.format?.properties ?? {};
        const roll = rnd();
        if (roll < 0.05) await new Promise((r) => setTimeout(r, 25_000)); // too slow for a buy
        let content;
        if (roll < 0.1) content = 'Sure! Here is what I think: buy it.';
        else if (roll < 0.15) content = JSON.stringify({ decision: 'maybe', size: 99 });
        else if (props.decision) content = JSON.stringify({ decision: rnd() < 0.6 ? 'buy' : 'skip', size: [0.5, 1, 1, 1.5, 2][Math.floor(rnd() * 5)], confidence: 'medium', reason: 'Looks fine.' });
        else if (props.positions) {
          const mints = [...String(q.messages?.[1]?.content ?? '').matchAll(/"mint":"([^"]+)"/g)].map((m) => m[1]);
          content = JSON.stringify({ positions: mints.map((m) => ({ mint: m, action: rnd() < 0.2 ? 'sell' : 'hold', sellPct: 50, reason: 'Taking some profit.' })), summary: 'Reviewed.' });
        } else content = JSON.stringify({ ok: true, message: 'Hello from the fake local AI.' });
        return json(res, 200, { model: q.model, message: { role: 'assistant', content }, done: true });
      }
      if (url.pathname === '/evm') {
        if (chaos(res)) return;
        const body = JSON.parse(raw || '{}');
        const one = (q) => ({ jsonrpc: '2.0', id: q.id, result: evm(q.method, q.params ?? []) });
        return json(res, 200, Array.isArray(body) ? body.map(one) : one(body));
      }
      if (url.pathname.startsWith('/kyber/')) {
        if (chaos(res)) return;
        const tin = url.searchParams.get('tokenIn'), tout = url.searchParams.get('tokenOut'), amountIn = url.searchParams.get('amountIn');
        const out = kyber(tin, tout, amountIn);
        if (out == null) return json(res, 400, { code: 4008, message: 'route not found' });
        return json(res, 200, { code: 0, data: { routeSummary: { tokenIn: tin, tokenOut: tout, amountIn, amountOut: out.toString(), route: [] }, routerAddress: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5' } });
      }
      if (url.pathname.startsWith('/goplus/')) {
        const a = (url.searchParams.get('contract_addresses') ?? '').toLowerCase();
        return json(res, 200, { code: 1, result: { [a]: { is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_mintable: '0', creator_address: '0x' + 'cc'.repeat(20) } } });
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
        const pairs = mints.map((m) => coinBy.get(m) ?? coinBy.get(m.toLowerCase())).filter(Boolean).map((c) => {
          if (c.chain === 'base') {
            const ev = c.events;
            const buys = ev.filter(([, s]) => s === 'buy').length, sells = ev.length - buys;
            return { chainId: 'base', dexId: 'uniswap', pairAddress: c.pool, baseToken: { address: c.mint, name: `Coin ${c.symbol}`, symbol: c.symbol }, quoteToken: { address: WETH, name: 'Wrapped Ether', symbol: 'WETH' }, priceUsd: String(c.price * SOL_USD), liquidity: { usd: c.liquidityUsd }, marketCap: c.price * SOL_USD * 1e9, fdv: c.price * SOL_USD * 1e9, pairCreatedAt: c.createdAt, priceChange: { m5: change5m(c), h1: 0, h24: 0 }, txns: { m5: { buys, sells }, h1: { buys, sells } }, volume: { h24: 10_000 } };
          }
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
    baseWallets,
    listen: () => new Promise((r) => server.listen(opt.port, '127.0.0.1', () => r(server.address().port))),
    close: () => { clearInterval(marketTimer); clearInterval(traderTimer); clearInterval(blockTimer); if (baseTimer) clearInterval(baseTimer); server.close(); },
  };
}
