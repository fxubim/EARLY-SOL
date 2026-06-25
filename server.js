/* =========================================================================
   ALPHA FEED — backend proxy
   -------------------------------------------------------------------------
   Why this exists: browsers (and the claude.ai artifact sandbox) block direct
   calls to RugCheck / Meteora / pump.fun because of CORS. This tiny server
   sits in the middle:

     • Proxies DexScreener / RugCheck / Meteora server-side (no CORS in Node).
     • Holds ONE PumpPortal websocket and fans new launches + migrations out
       to every connected browser (PumpPortal asks for a single connection).
     • Optional Helius key -> wire in holder counts / dev run-stay later.

   Run it, then in alpha-feed.jsx set:
       CONFIG.PROXY_BASE = "http://localhost:8787/api"
   and the whole feed turns real, with all four sources live.

   Node 18+ (built-in fetch).  npm install  ->  npm start
   ========================================================================= */
import express from "express";
import cors from "cors";
import http from "http";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8787;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || ""; // optional, for holders/dev signals
const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY || ""; // optional, raises limits / PumpSwap

const UPSTREAM = {
  dexscreener: "https://api.dexscreener.com",
  rugcheck: "https://api.rugcheck.xyz/v1",
  meteora: "https://dlmm-api.meteora.ag",
};

const app = express();
app.use(cors());                       // allow the frontend from any origin
app.use(express.json());

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, helius: !!HELIUS_API_KEY, ts: Date.now() })
);

// ---- generic passthrough: /api/<source>/<...path> -> upstream/<...path> ----
function proxy(source) {
  const base = UPSTREAM[source];
  return async (req, res) => {
    const tail = req.params[0] || "";
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const url = `${base}/${tail}${qs}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      clearTimeout(t);
      const text = await r.text();
      let body = text;
      // Meteora /pair/all is huge — trim to a sane slice before sending to the browser
      if (source === "meteora" && tail.startsWith("pair/all")) {
        try {
          const arr = JSON.parse(text);
          if (Array.isArray(arr)) {
            const trimmed = arr
              .filter((p) => Number(p.liquidity || 0) > 0)
              .sort((a, b) => Number(b.volume?.h24 || b.trade_volume_24h || 0) - Number(a.volume?.h24 || a.trade_volume_24h || 0))
              .slice(0, 80);
            body = JSON.stringify(trimmed);
          }
        } catch { /* fall through with raw text */ }
      }
      res.status(r.status).type("application/json").send(body);
    } catch (e) {
      res.status(502).json({ error: "upstream_failed", source, detail: String(e) });
    }
  };
}

app.get(/^\/api\/dexscreener\/(.*)/, proxy("dexscreener"));
app.get(/^\/api\/rugcheck\/(.*)/, proxy("rugcheck"));

/* Meteora /pair/all is multi-MB and slow — fetch it server-side on a timer and
   cache the trimmed top pairs, so the browser gets an instant response instead
   of timing out. First call returns [] and kicks a background refresh. */
let meteoraCache = [];
let meteoraAt = 0;
let meteoraFetching = false;
const METEORA_TTL = 60 * 1000;

async function refreshMeteora() {
  if (meteoraFetching) return;
  meteoraFetching = true;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000); // generous server-side budget
    const r = await fetch(`${UPSTREAM.meteora}/pair/all`, { signal: ctrl.signal, headers: { accept: "application/json" } });
    clearTimeout(t);
    const arr = await r.json();
    if (Array.isArray(arr)) {
      meteoraCache = arr
        .filter((p) => Number(p.liquidity || 0) > 0)
        .sort((a, b) => Number(b.trade_volume_24h || 0) - Number(a.trade_volume_24h || 0))
        .slice(0, 80);
      meteoraAt = Date.now();
      console.log(`[meteora] cached ${meteoraCache.length} top pairs`);
    }
  } catch (e) { console.log("[meteora] refresh failed:", String(e)); } // keep last cache
  finally { meteoraFetching = false; }
}

app.get("/api/meteora/pair/all", (_req, res) => {
  if (Date.now() - meteoraAt > METEORA_TTL && !meteoraFetching) refreshMeteora(); // refresh in background
  res.type("application/json").send(JSON.stringify(meteoraCache));
});
app.get(/^\/api\/meteora\/(.*)/, proxy("meteora")); // any other meteora path passes through

/* ---- Helius enrichment: the signals the free APIs don't expose ----
   Real holder count, top-10 %, mint/freeze authority, and dev run/stay.
   GET /api/enrich/:mint  -> { helius, holders, top10Pct, mintable, freezable, dev:{status,holdPct} }
   Returns { helius:false } when no HELIUS_API_KEY is set. Cached 5 min/mint. */
const HELIUS_RPC = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "";
const enrichCache = new Map();
const ENRICH_TTL = 5 * 60 * 1000;

async function rpc(method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "af", method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || method + " failed");
    return j.result;
  } finally { clearTimeout(t); }
}

async function getSupply(mint) {
  const r = await rpc("getTokenSupply", [mint]);
  return { ui: r?.value?.uiAmount || 0, decimals: r?.value?.decimals ?? 0 };
}

async function getTop10Pct(mint, supplyUi) {
  if (!supplyUi) return null;
  const r = await rpc("getTokenLargestAccounts", [mint]);
  const top = (r?.value || []).slice(0, 10).reduce((s, a) => s + (a.uiAmount || 0), 0);
  return Math.round((top / supplyUi) * 1000) / 10;
}

async function getAuthorities(mint) {
  const r = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const info = r?.value?.data?.parsed?.info || {};
  return {
    mintable: "mintAuthority" in info ? !!info.mintAuthority : null,
    freezable: "freezeAuthority" in info ? !!info.freezeAuthority : null,
  };
}

// count holders via the DAS getTokenAccounts (paged, capped so it stays cheap)
async function countHolders(mint, maxPages = 5) {
  let total = 0, capped = false;
  for (let page = 1; page <= maxPages; page++) {
    const r = await rpc("getTokenAccounts", [{ mint, limit: 1000, page, options: { showZeroBalance: false } }]);
    const accts = r?.token_accounts || [];
    total += accts.length;
    if (accts.length < 1000) return { holders: total, capped };
    if (page === maxPages) capped = true;
  }
  return { holders: total, capped };
}

async function getCreator(mint) {
  try {
    const r = await fetch(`${UPSTREAM.rugcheck}/tokens/${mint}/report`, { headers: { accept: "application/json" } });
    const j = await r.json();
    return j?.creator || j?.token?.creator || null;
  } catch { return null; }
}

// dev run/stay: does the deployer still hold the supply they made?
async function getDev(mint, creator, supplyUi) {
  if (!creator || !supplyUi) return null;
  try {
    const r = await rpc("getTokenAccountsByOwner", [creator, { mint }, { encoding: "jsonParsed" }]);
    const bal = (r?.value || []).reduce(
      (s, a) => s + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
    const holdPct = Math.round((bal / supplyUi) * 1000) / 10;
    return { status: holdPct >= 0.5 ? "HOLDING" : "SOLD", holdPct, creator };
  } catch { return null; }
}

app.get("/api/enrich/:mint", async (req, res) => {
  if (!HELIUS_RPC) return res.json({ helius: false });
  const mint = req.params.mint;
  const hit = enrichCache.get(mint);
  if (hit && Date.now() - hit.ts < ENRICH_TTL) return res.json(hit.data);
  const out = { helius: true, mint };
  try {
    const supply = await getSupply(mint).catch(() => ({ ui: 0 }));
    const [auth, top10, holders, creator] = await Promise.all([
      getAuthorities(mint).catch(() => ({})),
      getTop10Pct(mint, supply.ui).catch(() => null),
      countHolders(mint).catch(() => null),
      getCreator(mint),
    ]);
    Object.assign(out, auth);
    if (top10 != null) out.top10Pct = top10;
    if (holders) { out.holders = holders.holders; out.holdersCapped = holders.capped; }
    const dev = await getDev(mint, creator, supply.ui).catch(() => null);
    if (dev) out.dev = dev;
  } catch (e) {
    out.error = String(e);
  }
  enrichCache.set(mint, { data: out, ts: Date.now() });
  res.json(out);
});

/* ---- Dev history: the deployer's track record ----
   Finds the tokens the creator launched (Helius enhanced transactions) and
   classifies each past coin's outcome by its CURRENT DexScreener state
   (liquidity dead -> rug; graduated / sizeable -> win). It's a real, on-chain
   read, but it's a proxy: "win" ≈ still alive & sizeable, not the true peak.
   GET /api/dev/:mint -> { creator, deployed, ath, rug }  (cached 30 min/creator) */
const devCache = new Map();
const DEV_TTL = 30 * 60 * 1000;
const STABLE = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

async function heliusTx(address, before) {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
  u.searchParams.set("api-key", HELIUS_API_KEY);
  u.searchParams.set("limit", "100");
  if (before) u.searchParams.set("before", before);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(u, { signal: ctrl.signal });
    if (!r.ok) throw new Error("helius tx " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// mints this wallet appears to have CREATED (pump.fun + token launches), recent first
async function getCreatedMints(creator, maxPages = 3) {
  const created = [];
  const seen = new Set();
  let before;
  for (let p = 0; p < maxPages; p++) {
    const txs = await heliusTx(creator, before);
    if (!Array.isArray(txs) || txs.length === 0) break;
    for (const tx of txs) {
      const isCreate = tx.type === "CREATE" ||
        (tx.source === "PUMP_FUN" && /creat/i.test(tx.description || ""));
      if (!isCreate) continue;
      for (const tt of tx.tokenTransfers || []) {
        const m = tt.mint;
        if (m && !STABLE.has(m) && !seen.has(m)) { seen.add(m); created.push(m); }
      }
    }
    before = txs[txs.length - 1]?.signature;
    if (txs.length < 100) break;
  }
  return created;
}

// classify each past coin by its current DexScreener state (proxy for outcome)
async function classifyOutcomes(mints, excludeMint) {
  const list = mints.filter((m) => m !== excludeMint).slice(0, 20);
  if (!list.length) return { deployed: 1, ath: 0, rug: 0 };
  let ath = 0, rug = 0;
  try {
    const r = await fetch(`${UPSTREAM.dexscreener}/latest/dex/tokens/${list.join(",")}`, { headers: { accept: "application/json" } });
    const data = await r.json();
    const byMint = new Map();
    for (const pr of data?.pairs || []) {
      const a = pr.baseToken?.address;
      if (!a) continue;
      const cur = byMint.get(a);
      if (!cur || (pr.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) byMint.set(a, pr);
    }
    for (const m of list) {
      const pr = byMint.get(m);
      const liq = pr?.liquidity?.usd || 0;
      const mc = pr?.marketCap || pr?.fdv || 0;
      const dex = (pr?.dexId || "").toLowerCase();
      if (!pr || liq < 1000) { rug++; continue; }                                   // liquidity dead -> rug
      if (mc >= 40000 || dex.includes("raydium") || dex.includes("meteora")) ath++; // graduated / sizeable -> win
    }
  } catch { /* leave counts as-is */ }
  return { deployed: list.length + 1, ath, rug }; // +1 = the current coin
}

app.get("/api/dev/:mint", async (req, res) => {
  if (!HELIUS_RPC) return res.json({ helius: false });
  const mint = req.params.mint;
  const creator = await getCreator(mint);
  if (!creator) return res.json({ helius: true, creator: null });
  const hit = devCache.get(creator);
  if (hit && Date.now() - hit.ts < DEV_TTL) return res.json({ ...hit.data, mint });
  const out = { helius: true, mint, creator };
  try {
    const mints = await getCreatedMints(creator);
    const o = await classifyOutcomes(mints, mint);
    out.deployed = o.deployed; out.ath = o.ath; out.rug = o.rug;
  } catch (e) {
    out.deployed = null; out.error = String(e); // unknown rather than a wrong number
  }
  devCache.set(creator, { data: out, ts: Date.now() });
  res.json(out);
});

/* ---- Smart-money watchlist: which tracked wallets hold each token ----
   Wallets come from SMART_WALLETS (comma-sep env) and/or smart-wallets.json
   (an array of addresses). We poll each wallet's token holdings ONCE per
   refresh and build an inverted index mint -> Set(wallet), so a per-token
   lookup costs nothing. Populate the list with profitable wallets you trust
   (from Kolscan / GMGN smart-money / Birdeye top traders, etc).
   GET /api/smart/:mint -> { tracked, count, wallets } */
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SMART_REFRESH = 5 * 60 * 1000;

function loadSmartWallets() {
  const out = new Set();
  (process.env.SMART_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((w) => out.add(w));
  try {
    const arr = JSON.parse(fs.readFileSync(new URL("./smart-wallets.json", import.meta.url), "utf8"));
    if (Array.isArray(arr)) arr.forEach((w) => { if (typeof w === "string" && w.trim()) out.add(w.trim()); });
  } catch { /* no file is fine */ }
  return [...out];
}
let SMART_WALLETS = loadSmartWallets();
let smartIndex = new Map(); // mint -> Set(wallet)
let smartBuiltAt = 0;
let smartBuilding = false;

async function buildSmartIndex() {
  if (!HELIUS_RPC || smartBuilding || !SMART_WALLETS.length) return;
  smartBuilding = true;
  const next = new Map();
  try {
    for (const w of SMART_WALLETS) {
      try {
        const r = await rpc("getTokenAccountsByOwner", [w, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }]);
        for (const acc of r?.value || []) {
          const info = acc.account?.data?.parsed?.info;
          const mint = info?.mint;
          const amt = info?.tokenAmount?.uiAmount || 0;
          if (mint && amt > 0) {
            if (!next.has(mint)) next.set(mint, new Set());
            next.get(mint).add(w);
          }
        }
      } catch { /* skip this wallet */ }
    }
    smartIndex = next;
    smartBuiltAt = Date.now();
    console.log(`[smart] indexed ${SMART_WALLETS.length} wallets -> ${smartIndex.size} tokens held`);
  } finally { smartBuilding = false; }
}

app.get("/api/smart/:mint", (req, res) => {
  if (!HELIUS_RPC) return res.json({ helius: false });
  if (!SMART_WALLETS.length) return res.json({ helius: true, tracked: 0, count: 0 });
  if (Date.now() - smartBuiltAt > SMART_REFRESH && !smartBuilding) buildSmartIndex(); // refresh in background
  const holders = smartIndex.get(req.params.mint);
  res.json({
    helius: true,
    tracked: SMART_WALLETS.length,
    count: holders ? holders.size : 0,
    wallets: holders ? [...holders] : [],
    builtAt: smartBuiltAt,
  });
});

if (HELIUS_API_KEY && SMART_WALLETS.length) buildSmartIndex(); // warm up on boot
refreshMeteora(); // warm the Meteora cache so the first browser request is instant

// ------------------------------------------------------------------ server --
const server = http.createServer(app);

/* ---- PumpPortal fan-out: one upstream WS, many browser clients ---- */
const wss = new WebSocketServer({ server, path: "/api/ws" });
const clients = new Set();
let pp = null;
let ppRetry = 1000;

function connectPumpPortal() {
  const url = "wss://pumpportal.fun/api/data" + (PUMPPORTAL_API_KEY ? `?api-key=${PUMPPORTAL_API_KEY}` : "");
  pp = new WebSocket(url);

  pp.on("open", () => {
    ppRetry = 1000;
    pp.send(JSON.stringify({ method: "subscribeNewToken" }));
    pp.send(JSON.stringify({ method: "subscribeMigration" }));
    console.log("[pumpportal] connected, subscribed to new tokens + migrations");
  });

  pp.on("message", (data) => {
    const msg = data.toString();
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
  });

  pp.on("close", () => {
    console.warn(`[pumpportal] closed, reconnecting in ${ppRetry}ms`);
    setTimeout(connectPumpPortal, ppRetry);
    ppRetry = Math.min(ppRetry * 2, 30000);
  });

  pp.on("error", (e) => {
    console.error("[pumpportal] error:", e.message);
    try { pp.close(); } catch {}
  });
}

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[ws] client connected (${clients.size} total)`);
  ws.on("close", () => { clients.delete(ws); });
  ws.on("error", () => { clients.delete(ws); });
});

connectPumpPortal();

server.listen(PORT, () => {
  console.log(`ALPHA FEED proxy on http://localhost:${PORT}`);
  console.log(`  REST : http://localhost:${PORT}/api/{dexscreener|rugcheck|meteora}/...`);
  console.log(`  WS   : ws://localhost:${PORT}/api/ws  (pump.fun new tokens + migrations)`);
  console.log(`  Helius enrich: ${HELIUS_API_KEY ? "ON" : "OFF (set HELIUS_API_KEY)"}  GET /api/enrich/:mint  ·  GET /api/dev/:mint`);
  console.log(`  Smart money  : ${SMART_WALLETS.length} wallet(s) tracked  GET /api/smart/:mint`);
  console.log(`  In alpha-feed.jsx set  CONFIG.PROXY_BASE = "http://localhost:${PORT}/api"`);
});
