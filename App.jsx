import { useState, useEffect, useMemo, useRef, memo } from "react";
import {
  AreaChart, Area, ResponsiveContainer, Tooltip, YAxis,
} from "recharts";
import {
  Zap, Activity, TrendingUp, Search, X, Crosshair, Radio,
  ArrowUpDown, Flame, Copy, Check, Shield, Wallet,
} from "lucide-react";

/* =========================================================================
   ALPHA FEED — Solana early-call scanner  (sub-$100K band)
   -------------------------------------------------------------------------
   • Only surfaces tokens UNDER $100K market cap (the early-call window).
   • Per token: RugCheck status, holder count + top-10 supply %,
     mint / freeze / LP-burn audit, and current X-gain from deploy.
   • Pulls REAL data (DexScreener / pump.fun / Meteora / RugCheck / Helius)
     with a live-simulation fallback when the network is blocked. Configure
     via CONFIG near the top; see the DATA LAYER notes at the bottom.
   ========================================================================= */

/* ---------- palette (from your reference screenshots) ---------- */
const BG = "#08090a";
const SURFACE = "#0e0f12";
const SURFACE2 = "#131419";
const BORDER = "rgba(255,255,255,0.07)";
const BORDER2 = "rgba(255,255,255,0.12)";
const TXT = "#f4f4f5";
const SUB = "#71717a";
const MUTE = "#52525b";
const GREEN = "#22c55e";
const AMBER = "#eab308";
const RED = "#ef4444";
const ORANGE = "#f97316";

const MCAP_CEILING = 100000; // agent only calls below this

const metricColor = (v) => (v >= 80 ? GREEN : v >= 50 ? AMBER : RED);
const convColor = (c) =>
  c === "HIGH CONVICTION" ? GREEN : c === "MODERATE" ? AMBER : ORANGE;
const riskColor = (r) => (r === "LOW" ? GREEN : r === "MEDIUM" ? AMBER : RED);
const rugColor = (s) => (s === "GOOD" ? GREEN : s === "WARNING" ? AMBER : s === "DANGER" ? RED : MUTE);
const top10Color = (p) => (p < 20 ? GREEN : p < 35 ? AMBER : RED);
const venueColor = (v) => (v === "Meteora" ? "#22d3ee" : v === "Pump.fun" ? GREEN : v === "Raydium" ? "#60a5fa" : v === "Orca" ? "#818cf8" : SUB);

/* ---------- formatting ---------- */
const fmtUsd = (n) => {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + Math.round(n);
};
const fmtPct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fmtX = (x) => (x >= 10 ? Math.round(x) : x.toFixed(1)) + "x";
const fmtSol = (n) => (n >= 100 ? Math.round(n) : n.toFixed(1)) + " SOL";
const fmtAge = (ms) => {
  const m = ms / 60000;
  if (m < 60) return Math.max(1, Math.round(m)) + "m";
  if (m < 1440) return (m / 60).toFixed(m < 600 ? 1 : 0) + "h";
  if (m < 43200) return Math.round(m / 1440) + "d";
  return Math.round(m / 43200) + "mo";
};

/* ---------- scoring engine (the "Hunter Score") ---------- */
function scoreToken(t) {
  const walletScore = Math.min(100, t.smartWallets * 3.5);
  const buyPressure = Math.max(0, Math.min(100, (t.buyPct - 42) * 2.6));
  const base =
    t.smartMoneyFlow * 0.22 +
    t.holderGrowth * 0.24 +
    t.volumeExpansion * 0.22 +
    t.liquidityHealth * 0.14 +
    walletScore * 0.1 +
    buyPressure * 0.08;

  const m = t.ageMs / 60000;
  const ageMult =
    m < 15 ? 1.05 : m < 60 ? 1.02 : m < 360 ? 1.0 : m < 1440 ? 0.99 : 0.97;
  const riskMult =
    t.risk === "LOW" ? 1.0 : t.risk === "MEDIUM" ? 0.94 : t.risk === "HIGH" ? 0.84
      : t.rugStatus === "DANGER" ? 0.84 : t.rugStatus === "WARNING" ? 0.94 : 1.0;
  const bundledMult = t.bundled ? 0.98 : 1.0;

  // safety penalties — the audit + holder + deployer data feed the score
  let safetyMult = 1;
  if (t.mintable) safetyMult *= 0.95;
  if (t.freezable) safetyMult *= 0.95;
  if (t.lpBurned === false) safetyMult *= 0.93;
  if (t.top10Pct > 40) safetyMult *= 0.92;
  else if (t.top10Pct > 30) safetyMult *= 0.97;
  if (t.devStatus === "SOLD") safetyMult *= 0.93;
  const past = (t.devDeployed || 1) - 1;
  if (past >= 3 && t.devRug / past > 0.4) safetyMult *= 0.9;

  return Math.max(0, Math.min(100,
    Math.round(base * ageMult * riskMult * bundledMult * safetyMult)));
}
const convictionOf = (s) =>
  s >= 78 ? "HIGH CONVICTION" : s >= 62 ? "MODERATE" : "WATCH";

/* ---------- agent reasoning ---------- */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const joinList = (a) =>
  a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];

function reasoningFor(t) {
  const S = [], C = [];
  if (t.currentX >= 5) S.push(`${fmtX(t.currentX)} from deploy`);
  if (t.smartHolders > 0) S.unshift(`${t.smartHolders} tracked smart wallet${t.smartHolders > 1 ? "s" : ""} holding`);
  if (t.volumeExpansion >= 85) S.push("volume expanding hard");
  else if (t.volumeExpansion >= 65) S.push("volume building");
  if (t.holderGrowth >= 85) S.push("holders climbing fast");
  else if (t.holderGrowth >= 65) S.push("steady holder inflow");
  if (t.smartMoneyFlow >= 70 && !(t.smartHolders > 0)) S.push("smart money rotating in");
  if (t.liquidityHealth >= 80) S.push("deep liquidity");
  if (t.buyPct >= 60) S.push(`${t.buyPct}% buy-side`);
  if (t.devStatus === "HOLDING" && t.devAth > 0) S.push(`dev holding, ${t.devAth} past ATH`);

  if (t.mintable) C.push("mint authority live");
  if (t.freezable) C.push("freeze authority live");
  if (t.lpBurned === false) C.push("LP not burned");
  if (t.devStatus === "SOLD") C.push("dev already sold out");
  const _past = (t.devDeployed || 1) - 1;
  if (_past >= 3 && t.devRug / _past > 0.4) C.push(`dev rugged ${t.devRug}/${_past} past coins`);
  if (t.top10Pct > 35) C.push(`top 10 hold ${t.top10Pct}%`);
  if (t.rugStatus === "DANGER") C.push("RugCheck flags danger");
  if (t.smartMoneyFlow < 50) C.push("smart-money flow weak");
  if (t.liquidityHealth < 55) C.push("thin liquidity");
  if (t.bundled) C.push("bundled launch");
  if (t.snipers > 25) C.push(`${t.snipers} snipers in early`);

  const age = fmtAge(t.ageMs);
  const lead =
    t.conviction === "HIGH CONVICTION"
      ? `High-conviction sub-$100K call at ${age}.`
      : t.conviction === "MODERATE"
      ? `Moderate setup, ${age} in.`
      : `Early watch, ${age} old.`;

  const strengths = S.length ? " " + cap(joinList(S.slice(0, 3))) + "." : "";
  const concerns = C.length ? " Watch: " + joinList(C.slice(0, 2)) + "." : "";
  return (lead + strengths + concerns).trim();
}

/* ---------- record builders ---------- */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const randAddr = () => {
  let s = "";
  for (let i = 0; i < 40; i++) s += B58[(Math.random() * B58.length) | 0];
  return s + "pump";
};

function genHistory(currentMc, n = 44) {
  const arr = [];
  let mc = currentMc * (0.12 + Math.random() * 0.22);
  for (let i = 0; i < n; i++) {
    const drift = (Math.random() - 0.4) * currentMc * 0.07;
    mc = Math.max(currentMc * 0.04, mc + drift + (currentMc - mc) * 0.05);
    arr.push({ t: i, mc: Math.round(mc) });
  }
  arr[n - 1].mc = currentMc;
  return arr;
}

// generate static safety/audit data, correlated with the risk tier
function makeSafety(risk) {
  const p = risk === "LOW" ? 0.08 : risk === "MEDIUM" ? 0.4 : 0.85;
  const mintable = Math.random() < p * 0.7;
  const freezable = Math.random() < p * 0.6;
  const lpBurned = Math.random() > (risk === "LOW" ? 0.1 : risk === "MEDIUM" ? 0.45 : 0.85);
  const base = risk === "LOW" ? 14 : risk === "MEDIUM" ? 26 : 42;
  const top10Pct = Math.round((base + Math.random() * 14) * 10) / 10;
  let rugScore =
    (mintable ? 28 : 0) + (freezable ? 22 : 0) + (!lpBurned ? 26 : 0) +
    Math.max(0, top10Pct - 18) + Math.random() * 8;
  rugScore = Math.min(100, Math.round(rugScore));
  const rugStatus = rugScore >= 55 ? "DANGER" : rugScore >= 28 ? "WARNING" : "GOOD";
  return { mintable, freezable, lpBurned, top10Pct, rugScore, rugStatus };
}

// add holders + deploy MC + safety + fees + deployer history to a fresh token
function enrich(t) {
  Object.assign(t, makeSafety(t.risk));
  t.holders = Math.max(35, Math.round(t.mcap / (25 + Math.random() * 45)));
  let dep = 2000 + Math.random() * 5000;
  dep = Math.min(dep, t.mcap / 1.3);
  t.deployMcap = Math.round(Math.max(1200, dep));

  // total fees generated, in SOL (~1% of lifetime volume — shown like GMGN)
  const ageHours = t.ageMs / 3600000;
  const estLifetimeVol = t.vol24h * (1 + Math.min(6, ageHours / 24) * 0.6);
  t.totalFeeSol = Math.round((estLifetimeVol / (18000 + Math.random() * 5000)) * 10) / 10;

  // deployer wallet — run (sold) or stay (holding) + track record
  const soldP = t.risk === "LOW" ? 0.12 : t.risk === "MEDIUM" ? 0.45 : 0.8;
  const sold = Math.random() < soldP;
  t.devStatus = sold ? "SOLD" : "HOLDING";
  t.devHoldPct = sold
    ? Math.round(Math.random() * 5) / 10                // 0–0.5%
    : Math.round((1.5 + Math.random() * 6.5) * 10) / 10; // 1.5–8%
  t.devDeployed = 1 + Math.round(Math.random() * 14);    // 1–15 (incl. this one)
  const past = t.devDeployed - 1;
  const rugRate = t.risk === "LOW" ? 0.05 + Math.random() * 0.18
    : t.risk === "MEDIUM" ? 0.2 + Math.random() * 0.3
    : 0.5 + Math.random() * 0.4;
  const athRate = t.risk === "LOW" ? 0.2 + Math.random() * 0.3
    : t.risk === "MEDIUM" ? 0.1 + Math.random() * 0.2
    : Math.random() * 0.12;
  t.devRug = Math.min(past, Math.round(past * rugRate));
  t.devAth = Math.min(past - t.devRug, Math.round(past * athRate));

  // smart-money (demo): better tokens are more likely to have tracked wallets in them
  const smartP = t.risk === "LOW" ? 0.5 : t.risk === "MEDIUM" ? 0.3 : 0.12;
  t.smartHolders = Math.random() < smartP ? 1 + Math.floor(Math.random() * (t.risk === "LOW" ? 6 : 3)) : 0;
  t.smartTracked = 40;
  return t;
}

// compute everything derived (safe to call every tick)
function finalize(t) {
  t.currentX = t.deployMcap ? t.mcap / t.deployMcap : 1;
  t.hunterScore = scoreToken(t);
  t.conviction = convictionOf(t.hunterScore);
  t.reasoning = reasoningFor(t);
  if (!t.history) t.history = genHistory(t.mcap);
  return t;
}

/* ---------- seed set (all sub-$100K early calls) ---------- */
const SEED = [
  { ticker: "HermesAgnt", name: "Awesome Hermes Agent", mcap: 33400, liq: 13400, vol24h: 209700, change24h: 216.34, smartWallets: 13, buyPct: 56, smartMoneyFlow: 51, holderGrowth: 100, volumeExpansion: 100, liquidityHealth: 83, risk: "LOW", bundled: true, snipers: 24, ageMin: 95 },
  { ticker: "Houston", name: "Houston", mcap: 24600, liq: 14600, vol24h: 15500, change24h: 53.07, smartWallets: 61, buyPct: 57, smartMoneyFlow: 100, holderGrowth: 50, volumeExpansion: 100, liquidityHealth: 83, risk: "LOW", bundled: false, snipers: 20, ageMin: 38 },
  { ticker: "GOONC", name: "GOONCOIN", mcap: 58500, liq: 21900, vol24h: 19300, change24h: 83.71, smartWallets: 42, buyPct: 58, smartMoneyFlow: 100, holderGrowth: 50, volumeExpansion: 92, liquidityHealth: 87, risk: "LOW", bundled: false, snipers: 37, ageMin: 220 },
  { ticker: ".png", name: ".png", mcap: 7900, liq: 8200, vol24h: 9300, change24h: 40.63, smartWallets: 33, buyPct: 49, smartMoneyFlow: 87, holderGrowth: 50, volumeExpansion: 97, liquidityHealth: 78, risk: "MEDIUM", bundled: false, snipers: 16, ageMin: 12 },
  { ticker: "ASMORA", name: "Asmora", mcap: 21600, liq: 11400, vol24h: 18100, change24h: -1.52, smartWallets: 27, buyPct: 51, smartMoneyFlow: 78, holderGrowth: 50, volumeExpansion: 85, liquidityHealth: 81, risk: "LOW", bundled: false, snipers: 22, ageMin: 410 },
  { ticker: "Larry", name: "Larry The Cat", mcap: 3400, liq: 4200, vol24h: 19300, change24h: 123.34, smartWallets: 46, buyPct: 53, smartMoneyFlow: 100, holderGrowth: 50, volumeExpansion: 100, liquidityHealth: 73, risk: "MEDIUM", bundled: false, snipers: 31, ageMin: 6 },
  { ticker: "MoonRunner", name: "Moon Runner", mcap: 67200, liq: 24800, vol24h: 142000, change24h: 96.4, smartWallets: 38, buyPct: 61, smartMoneyFlow: 74, holderGrowth: 88, volumeExpansion: 91, liquidityHealth: 86, risk: "LOW", bundled: false, snipers: 18, ageMin: 47 },
  { ticker: "GIGACAT", name: "Giga Cat", mcap: 12800, liq: 9200, vol24h: 31000, change24h: 18.7, smartWallets: 19, buyPct: 52, smartMoneyFlow: 60, holderGrowth: 71, volumeExpansion: 64, liquidityHealth: 70, risk: "MEDIUM", bundled: false, snipers: 26, ageMin: 175 },
  { ticker: "pepework", name: "Pepe Work", mcap: 45300, liq: 18600, vol24h: 88000, change24h: 64.2, smartWallets: 41, buyPct: 59, smartMoneyFlow: 82, holderGrowth: 79, volumeExpansion: 86, liquidityHealth: 84, risk: "LOW", bundled: false, snipers: 21, ageMin: 25 },
  { ticker: "FROGE", name: "Froge Sol", mcap: 89100, liq: 12200, vol24h: 240000, change24h: 312.0, smartWallets: 9, buyPct: 64, smartMoneyFlow: 41, holderGrowth: 96, volumeExpansion: 100, liquidityHealth: 58, risk: "HIGH", bundled: true, snipers: 33, ageMin: 8 },
  { ticker: "mochi", name: "Mochi Cat", mcap: 4600, liq: 5100, vol24h: 11200, change24h: -8.4, smartWallets: 22, buyPct: 50, smartMoneyFlow: 55, holderGrowth: 60, volumeExpansion: 58, liquidityHealth: 80, risk: "LOW", bundled: false, snipers: 14, ageMin: 320 },
  { ticker: "aura", name: "Aura Coin", mcap: 71500, liq: 22400, vol24h: 96000, change24h: 41.2, smartWallets: 34, buyPct: 55, smartMoneyFlow: 70, holderGrowth: 67, volumeExpansion: 73, liquidityHealth: 88, risk: "MEDIUM", bundled: false, snipers: 22, ageMin: 130 },
  { ticker: "SOLRAT", name: "Sol Rat", mcap: 9100, liq: 6400, vol24h: 28800, change24h: 71.5, smartWallets: 29, buyPct: 57, smartMoneyFlow: 81, holderGrowth: 77, volumeExpansion: 88, liquidityHealth: 74, risk: "MEDIUM", bundled: false, snipers: 19, ageMin: 9 },
  { ticker: "NOVA", name: "Nova Protocol", mcap: 52300, liq: 20100, vol24h: 74000, change24h: 28.9, smartWallets: 44, buyPct: 54, smartMoneyFlow: 76, holderGrowth: 62, volumeExpansion: 70, liquidityHealth: 85, risk: "LOW", bundled: false, snipers: 17, ageMin: 64 },
  { ticker: "wojak", name: "Wojak Returns", mcap: 16700, liq: 10300, vol24h: 41000, change24h: 109.2, smartWallets: 31, buyPct: 60, smartMoneyFlow: 88, holderGrowth: 83, volumeExpansion: 90, liquidityHealth: 77, risk: "MEDIUM", bundled: false, snipers: 24, ageMin: 14 },
  { ticker: "BONKAI", name: "Bonk AI", mcap: 38900, liq: 16800, vol24h: 67000, change24h: 52.7, smartWallets: 37, buyPct: 56, smartMoneyFlow: 79, holderGrowth: 74, volumeExpansion: 82, liquidityHealth: 83, risk: "LOW", bundled: false, snipers: 20, ageMin: 33 },
  { ticker: "shroom", name: "Shroom Cat", mcap: 5200, liq: 4900, vol24h: 14600, change24h: -4.1, smartWallets: 17, buyPct: 48, smartMoneyFlow: 52, holderGrowth: 58, volumeExpansion: 55, liquidityHealth: 72, risk: "MEDIUM", bundled: false, snipers: 13, ageMin: 240 },
  { ticker: "PHOENIX", name: "Phoenix Agent", mcap: 81400, liq: 26200, vol24h: 188000, change24h: 144.6, smartWallets: 48, buyPct: 62, smartMoneyFlow: 90, holderGrowth: 92, volumeExpansion: 95, liquidityHealth: 84, risk: "MEDIUM", bundled: false, snipers: 28, ageMin: 19 },
];

/* ---------- venues (which DEX / launchpad the liquidity sits on) ---------- */
const VENUES = ["Pump.fun", "Pump.fun", "Pump.fun", "Meteora", "Meteora", "Raydium", "Bonk", "Orca"];
const pickVenue = () => VENUES[(Math.random() * VENUES.length) | 0];

const buildSeed = () =>
  SEED.map((s, i) => {
    const addr = randAddr();
    return finalize(enrich({
      ...s,
      id: "seed-" + i,
      address: addr,
      preview: addr.slice(0, 4) + "...pump",
      venue: pickVenue(),
      ageMs: s.ageMin * 60000,
      detectedAt: Date.now() - i * 60000,
      _new: false,
    }));
  });

/* ---------- pool for newly "detected" tokens ---------- */
const NAME_POOL = [
  ["GIGACHAD", "Giga Chad"], ["SOLBONK", "Sol Bonk"], ["WIFHAT", "Dog Wif Hat"],
  ["NebulaAI", "Nebula Agent"], ["TURBO", "Turbo Toad"], ["ZENITH", "Zenith AI"],
  ["VOLT", "Volt Network"], ["KIRO", "Kiro Inu"], ["dogwater", "Dog Water"],
  ["ECLIPSE", "Eclipse Agent"], ["HELIOS", "Helios AI"], ["snork", "Snork"],
  ["QUANTA", "Quanta Protocol"], ["pondscum", "Pond Scum"], ["RIZZ", "Rizzler"],
  ["VORTEX", "Vortex AI"], ["mfer", "Sol Mfer"], ["PEPEX", "Pepe X"],
  ["catwif", "Cat Wif Gun"], ["ATLAS", "Atlas Agent"], ["goblin", "Goblin Town"],
  ["SIGMA", "Sigma Grindset"], ["nyan", "Nyan Sol"], ["LUMA", "Luma Protocol"],
  ["chad404", "Chad 404"], ["TITAN", "Titan AI"], ["dook", "Dook Dook"],
];
let nameIdx = 0;
function spawnToken(taken) {
  // pick a pool name that isn't already on screen (avoids duplicate cards)
  let pick = null;
  for (let k = 0; k < NAME_POOL.length; k++) {
    const cand = NAME_POOL[nameIdx++ % NAME_POOL.length];
    if (!taken || !taken.has(cand[0])) { pick = cand; break; }
  }
  if (!pick) pick = NAME_POOL[nameIdx++ % NAME_POOL.length];
  const [ticker, name] = pick;
  const addr = randAddr();
  const ageMs = (30 + Math.random() * 300) * 1000; // 0.5–5 min old: caught early
  const mcap = Math.round(6000 + Math.random() * 86000); // under ceiling
  const risks = ["LOW", "LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH"];
  return finalize(enrich({
    id: "live-" + Date.now() + "-" + Math.round(Math.random() * 1e4),
    ticker, name, address: addr, preview: addr.slice(0, 4) + "...pump",
    venue: pickVenue(),
    mcap,
    liq: Math.round(mcap * (0.25 + Math.random() * 0.35)),
    vol24h: Math.round(mcap * (1 + Math.random() * 6)),
    change24h: Math.round((Math.random() * 320 - 25) * 100) / 100,
    smartWallets: Math.round(3 + Math.random() * 45),
    buyPct: Math.round(46 + Math.random() * 22),
    smartMoneyFlow: Math.round(30 + Math.random() * 70),
    holderGrowth: Math.round(40 + Math.random() * 60),
    volumeExpansion: Math.round(40 + Math.random() * 60),
    liquidityHealth: Math.round(55 + Math.random() * 45),
    risk: risks[(Math.random() * risks.length) | 0],
    bundled: Math.random() < 0.25,
    snipers: Math.round(8 + Math.random() * 30),
    ageMs,
    detectedAt: Date.now(),
    _new: true,
  }));
}

/* ---------- live feed engine (swap this for real data) ---------- */
function useFeedEngine(live) {
  const [tokens, setTokens] = useState(buildSeed);
  const [scanned, setScanned] = useState(2841);
  const tokensRef = useRef(tokens);
  const timers = useRef({});
  useEffect(() => { tokensRef.current = tokens; }, [tokens]);

  useEffect(() => {
    if (!live) return;
    const drift = setInterval(() => {
      setTokens((prev) =>
        prev.map((t) => {
          // only ~55% of tokens tick each cycle: more realistic + lets
          // memoized cards skip re-rendering the ones that didn't change
          if (Math.random() < 0.45) return t;
          const j = () => (Math.random() - 0.5) * 4;
          const nextMc = Math.min(
            MCAP_CEILING - 1000,
            Math.max(2000, Math.round(t.mcap * (1 + (Math.random() - 0.48) * 0.05)))
          );
          const u = {
            ...t,
            ageMs: t.ageMs + 2600,
            mcap: nextMc,
            vol24h: Math.max(1000, Math.round(t.vol24h * (1 + (Math.random() - 0.45) * 0.04))),
            change24h: Math.round((t.change24h + (Math.random() - 0.5) * 6) * 100) / 100,
            smartMoneyFlow: Math.max(0, Math.min(100, Math.round(t.smartMoneyFlow + j()))),
            holderGrowth: Math.max(0, Math.min(100, Math.round(t.holderGrowth + j()))),
            volumeExpansion: Math.max(0, Math.min(100, Math.round(t.volumeExpansion + j()))),
            liquidityHealth: Math.max(0, Math.min(100, Math.round(t.liquidityHealth + j() / 2))),
            buyPct: Math.max(35, Math.min(78, Math.round(t.buyPct + (Math.random() - 0.5) * 3))),
            holders: t.holders + (t.holderGrowth > 70 ? Math.round(Math.random() * 7) : Math.round(Math.random() * 2)),
            top10Pct: Math.max(5, Math.min(75, Math.round((t.top10Pct + (Math.random() - 0.5) * 0.6) * 10) / 10)),
            totalFeeSol: Math.round((t.totalFeeSol + Math.random() * 0.08) * 10) / 10,
          };
          u.history = [...t.history.slice(1), { t: t.history[t.history.length - 1].t + 1, mc: u.mcap }];
          return finalize(u);
        })
      );
    }, 2600);

    const spawn = setInterval(() => {
      const taken = new Set(tokensRef.current.map((t) => t.ticker));
      const tok = spawnToken(taken);
      setTokens((prev) => [tok, ...prev].slice(0, 40));
      setScanned((s) => s + Math.round(2 + Math.random() * 5));
      timers.current[tok.id] = setTimeout(() => {
        setTokens((prev) => prev.map((t) => (t.id === tok.id ? { ...t, _new: false } : t)));
        delete timers.current[tok.id];
      }, 2800);
    }, 6500);

    const snapshot = timers.current;
    return () => {
      clearInterval(drift);
      clearInterval(spawn);
      Object.values(snapshot).forEach(clearTimeout);
    };
  }, [live]);

  return { tokens, scanned };
}

/* =========================================================================
   REAL DATA LAYER  —  DexScreener · RugCheck · Pump.fun (PumpPortal) · Meteora
   -------------------------------------------------------------------------
   What is genuinely REAL from these free sources:
     • DexScreener  → price, market cap, liquidity, 24h volume/change, the DEX
                      (incl. Meteora vs Raydium vs Pump.fun), pair age, buy/sell.
     • RugCheck     → mint/freeze authority, top-10 holder %, rug status.
     • PumpPortal   → real-time NEW pump.fun launches (the earliest calls).
     • Meteora      → identified via DexScreener dexId; pool fees via DLMM API.
   DERIVED (these free APIs don't expose them — computed from real inputs and
   marked "~"; the included backend can fill them from Helius/Birdeye):
     • smart-money flow, holder growth, smart-wallet count, total fees,
       X-from-deploy, dev run/stay + dev history.
   Browser note: RugCheck/Meteora/pump.fun REST often block cross-origin calls,
   and the claude.ai sandbox restricts outbound network — so this falls back to
   the simulation and shows the real status per source. Set CONFIG.PROXY_BASE to
   the included backend to make all four reliable. ========================== */
const CONFIG = {
  MODE: "live",          // "live" attempts real APIs; "demo" forces the simulation
  PROXY_BASE: "",        // e.g. "http://localhost:8787/api" — routes through your backend (fixes CORS + adds Helius signals)
  MCAP_CEILING: 100000,
  REFRESH_MS: 25000,
  MAX_TOKENS: 60,
  RUGCHECK: true,
  PUMPPORTAL: true,
  HELIUS: true,          // real holders / top-10 / authorities / dev run-stay (proxy + HELIUS_API_KEY only)
  SMART: true,           // smart-money watchlist: which tracked wallets hold each token (proxy + Helius)
};

let SOL_USD = 0;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const dsBase = () => (CONFIG.PROXY_BASE ? `${CONFIG.PROXY_BASE}/dexscreener` : "https://api.dexscreener.com");
const rcBase = () => (CONFIG.PROXY_BASE ? `${CONFIG.PROXY_BASE}/rugcheck` : "https://api.rugcheck.xyz/v1");
const metBase = () => (CONFIG.PROXY_BASE ? `${CONFIG.PROXY_BASE}/meteora` : "https://dlmm-api.meteora.ag");

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round2 = (n) => Math.round(n * 100) / 100;
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "");

async function fetchJSON(url, ms = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(id); }
}

async function fetchSolPrice() {
  try {
    const d = await fetchJSON(`${dsBase()}/latest/dex/tokens/${SOL_MINT}`);
    const p = (d?.pairs || []).find((x) => x.priceUsd)?.priceUsd;
    if (p) SOL_USD = parseFloat(p);
  } catch {}
  return SOL_USD;
}

const venueOf = (dexId) => {
  const d = (dexId || "").toLowerCase();
  if (d.includes("meteora")) return "Meteora";
  if (d.includes("pump")) return "Pump.fun";
  if (d.includes("raydium")) return "Raydium";
  if (d.includes("orca")) return "Orca";
  if (d.includes("bonk")) return "Bonk";
  return dexId ? dexId[0].toUpperCase() + dexId.slice(1) : "DEX";
};

// DexScreener pair -> normalized token (market fields are REAL)
function fromPair(p) {
  const tx = p.txns?.h24 || {};
  const buys = tx.buys || 0, sells = tx.sells || 0;
  return {
    id: "t-" + p.baseToken.address,
    ticker: p.baseToken.symbol || "?",
    name: p.baseToken.name || p.baseToken.symbol || "Unknown",
    address: p.baseToken.address,
    preview: short(p.baseToken.address),
    pairAddress: p.pairAddress,
    venue: venueOf(p.dexId),
    mcap: p.marketCap || p.fdv || 0,
    liq: p.liquidity?.usd || 0,
    vol24h: p.volume?.h24 || 0,
    change24h: round2(p.priceChange?.h24 || 0),
    h1: p.priceChange?.h1 || 0,
    buyPct: buys + sells > 0 ? Math.round((buys / (buys + sells)) * 100) : 50,
    txH24: buys + sells,
    ageMs: p.pairCreatedAt ? Math.max(0, Date.now() - p.pairCreatedAt) : 0,
    live: true, source: "dexscreener",
  };
}

// PumpPortal new-token create -> fresh token (REAL launch, caught at age ~0)
function fromPumpCreate(m, mcUsd) {
  return {
    id: "t-" + m.mint,
    ticker: m.symbol || "?",
    name: m.name || m.symbol || "New launch",
    address: m.mint,
    preview: short(m.mint),
    venue: "Pump.fun",
    mcap: mcUsd,
    liq: (m.vSolInBondingCurve || 0) * SOL_USD,
    vol24h: 0, change24h: 0, h1: 0, buyPct: 60, txH24: 0,
    ageMs: 0, detectedAt: Date.now(),
    deployMcap: mcUsd || 5500,
    live: true, source: "pumpfun", _new: true,
  };
}

// RugCheck full report -> audit fields (REAL)
function mapRug(rep) {
  if (!rep) return {};
  const has = (k) => rep[k] !== undefined && rep[k] !== null;
  const norm = rep.score_normalised != null ? rep.score_normalised
    : (rep.score != null ? clamp(Math.round(rep.score / 200), 0, 100) : null);
  const rugStatus = norm == null ? "UNKNOWN" : norm >= 60 ? "DANGER" : norm >= 30 ? "WARNING" : "GOOD";
  const top = Array.isArray(rep.topHolders)
    ? rep.topHolders.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0) : null;
  let lpBurned = null;
  const mk = rep.markets?.[0];
  const lockedPct = mk?.lp?.lpLockedPct;
  if (lockedPct != null) lpBurned = lockedPct >= 90;
  return {
    rugStatus, rugScore: norm,
    top10Pct: top != null ? Math.round(top * 10) / 10 : null,
    mintable: "mintAuthority" in rep ? !!rep.mintAuthority : null,
    freezable: "freezeAuthority" in rep ? !!rep.freezeAuthority : null,
    lpBurned,
    holders: rep.totalHolders != null ? rep.totalHolders : null,
    rugged: !!rep.rugged,
  };
}

// copy only the defined (non-null) keys, so a later source can't null out an earlier real value
const assignDefined = (t, o) => { for (const k in o) if (o[k] != null) t[k] = o[k]; return t; };

// Map setter that evicts the oldest entry past a cap (keeps enrichment caches bounded)
const cacheSet = (m, k, v, max = 500) => { m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); };

// merge a Helius /enrich response onto a token (real holders/top10/authorities/dev)
function applyHelius(t, d) {
  if (!d || d.helius === false) return false;
  if (d.holders != null) { t.holders = d.holders; t.holdersCapped = !!d.holdersCapped; }
  if (d.top10Pct != null) t.top10Pct = d.top10Pct;
  if (d.mintable != null) t.mintable = d.mintable;
  if (d.freezable != null) t.freezable = d.freezable;
  if (d.dev) { t.devStatus = d.dev.status; t.devHoldPct = d.dev.holdPct; }
  return true;
}

// merge a /dev response (deployer track record) onto a token
function applyDev(t, d) {
  if (!d || d.deployed == null) return false;
  t.devDeployed = d.deployed;
  t.devAth = d.ath ?? 0;
  t.devRug = d.rug ?? 0;
  return true;
}

// merge a /smart response (tracked smart wallets holding the token) onto a token
function applySmart(t, d) {
  if (!d || d.count == null) return false;
  t.smartHolders = d.count;
  t.smartTracked = d.tracked || 0;
  t._smartReal = true;
  return true;
}

// fill the signals these free APIs don't expose, from real inputs (marked "~")
function deriveLive(t) {
  const liqRatio = t.mcap > 0 ? t.liq / t.mcap : 0;
  t.liquidityHealth = clamp(Math.round(20 + liqRatio * 170), 0, 100);
  const volRatio = t.mcap > 0 ? t.vol24h / t.mcap : 0;
  t.volumeExpansion = clamp(Math.round(35 + Math.log10(1 + volRatio) * 55), 0, 100);
  t.smartMoneyFlow = clamp(Math.round((t.buyPct - 40) * 2 + (t.change24h > 0 ? 18 : -6)), 0, 100);
  // real smart-money signal (tracked wallets holding) outweighs the buy-pressure proxy
  if (t.smartHolders > 0) t.smartMoneyFlow = clamp(62 + t.smartHolders * 12, 0, 100);
  if (t.holderGrowth == null)
    t.holderGrowth = clamp(Math.round(45 + (t.h1 || 0) / 3 + Math.min(40, (t.txH24 || 0) / 25)), 0, 100);
  if (t.smartWallets == null) t.smartWallets = clamp(Math.round(Math.min(60, (t.txH24 || 0) / 12)), 1, 60);
  if (t.snipers === undefined) t.snipers = null;
  if (t.totalFeeSol == null) t.totalFeeSol = SOL_USD ? Math.round((t.vol24h * 0.01 / SOL_USD) * 10) / 10 : null;
  if (t.deployMcap == null) t.deployMcap = t.venue === "Pump.fun" ? 5500 : clamp(t.mcap / 1.2, 1500, 6000);
  if (t.bundled === undefined) t.bundled = false;
  t._estimated = true;
  return t;
}

function finalizeLive(t) {
  deriveLive(t);
  t.currentX = t.deployMcap ? t.mcap / t.deployMcap : 1;
  if (t.rugStatus == null) t.rugStatus = "UNKNOWN";
  if (t._new && t.detectedAt && Date.now() - t.detectedAt > 6000) t._new = false;
  t.hunterScore = scoreToken(t);
  t.conviction = convictionOf(t.hunterScore);
  t.reasoning = reasoningFor(t);
  if (!t.history || !t.history.length) t.history = [{ t: 0, mc: t.mcap }];
  return t;
}

// orchestrates the real sources; returns live tokens + per-source status
function useRealFeed(active) {
  const [tokens, setTokens] = useState([]);
  const [sources, setSources] = useState({ dexscreener: "idle", rugcheck: "idle", pumpfun: "idle", meteora: "idle", helius: "idle" });
  const [blocked, setBlocked] = useState(false);
  const map = useRef(new Map());
  const rugCache = useRef(new Map());
  const heliusCache = useRef(new Map());
  const devCache = useRef(new Map());
  const smartCache = useRef(new Map());
  const pending = useRef(new Set());

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setBlocked(false); // fresh attempt (e.g. after toggling demo -> live)
    const setSrc = (k, v) => alive && setSources((s) => (s[k] === v ? s : { ...s, [k]: v }));

    let commitTimer = null;
    const doCommit = () => {
      commitTimer = null;
      // keep memory bounded — the pump.fun stream is endless
      if (map.current.size > CONFIG.MAX_TOKENS * 4) {
        const keep = [...map.current.values()]
          .sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0))
          .slice(0, CONFIG.MAX_TOKENS * 2);
        map.current = new Map(keep.map((t) => [t.address, t]));
      }
      const arr = [...map.current.values()]
        .filter((t) => t.mcap > 0 && t.mcap < CONFIG.MCAP_CEILING)
        .map((t) => finalizeLive({ ...t })) // fresh ref each commit so memo'd cards see enrichment
        .sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0))
        .slice(0, CONFIG.MAX_TOKENS);
      if (alive) setTokens(arr);
    };
    // throttle: a busy stream can fire many times/sec — coalesce into ~1.4 commits/s
    const commit = () => { if (!commitTimer) commitTimer = setTimeout(doCommit, 700); };

    // store a batch of DexScreener pairs into the map (keeps best pair per token)
    function ingestPairs(pairs) {
      const best = new Map();
      for (const p of pairs || []) {
        if (p.chainId !== "solana" || !p.baseToken?.address) continue;
        const cur = best.get(p.baseToken.address);
        if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(p.baseToken.address, p);
      }
      let meteora = false;
      for (const [a, p] of best) {
        const tok = fromPair(p);
        if (tok.mcap <= 0 || tok.mcap >= CONFIG.MCAP_CEILING) continue;
        if (tok.venue === "Meteora") meteora = true;
        const prev = map.current.get(a);
        const hist = prev?.history ? prev.history.slice() : [];
        hist.push({ t: hist.length, mc: tok.mcap });
        if (hist.length > 60) hist.shift();
        map.current.set(a, { ...prev, ...tok, detectedAt: prev?.detectedAt || Date.now(), history: hist });
      }
      return meteora;
    }

    // fetch full market data for a list of mints, 30 at a time (DexScreener cap)
    async function hydrate(addrs) {
      let meteora = false;
      for (let i = 0; i < addrs.length; i += 30) {
        const batch = addrs.slice(i, i + 30);
        try {
          const data = await fetchJSON(`${dsBase()}/latest/dex/tokens/${batch.join(",")}`);
          if (ingestPairs(data?.pairs)) meteora = true;
        } catch {}
      }
      return meteora;
    }

    // pull newest Meteora DLMM pools and feed their tokens in (proxy only — /pair/all is large)
    async function pullMeteora() {
      if (!CONFIG.PROXY_BASE) return [];
      try {
        setSrc("meteora", "connecting");
        const pools = await fetchJSON(`${metBase()}/pair/all`, 12000);
        const mints = (Array.isArray(pools) ? pools : [])
          .map((p) => p.mint_x === SOL_MINT ? p.mint_y : p.mint_x)
          .filter(Boolean).slice(0, 30);
        setSrc("meteora", mints.length ? "live" : "idle");
        return mints;
      } catch { setSrc("meteora", "blocked"); return []; }
    }

    async function pollDex() {
      setSrc("dexscreener", "connecting");
      fetchSolPrice(); // keep SOL/USD fresh for pump.fun mcap + fee math (self-catches)
      let okCount = 0;
      const grab = async (url) => { try { const r = await fetchJSON(url); okCount++; return r; } catch { return []; } };
      try {
        // discovery: latest profiles + latest boosts + top boosts → more coins
        const [profiles, boosts, topBoosts] = await Promise.all([
          grab(`${dsBase()}/token-profiles/latest/v1`),
          grab(`${dsBase()}/token-boosts/latest/v1`),
          grab(`${dsBase()}/token-boosts/top/v1`),
        ]);
        if (okCount === 0) {            // every DexScreener call failed (CORS / sandbox) — report honestly
          setSrc("dexscreener", "blocked");
          if (map.current.size === 0) setBlocked(true);
          return;
        }
        const fromList = (arr) => (Array.isArray(arr) ? arr : [])
          .filter((x) => x.chainId === "solana").map((x) => x.tokenAddress).filter(Boolean);
        const metMints = await pullMeteora();
        const pend = [...pending.current];
        const addrs = [...new Set([...fromList(profiles), ...fromList(boosts), ...fromList(topBoosts), ...metMints, ...pend])].slice(0, 90);
        if (addrs.length) {
          const meteora = await hydrate(addrs);
          if (meteora && !CONFIG.PROXY_BASE) setSrc("meteora", "live");
        }
        pend.forEach((x) => pending.current.delete(x));
        setSrc("dexscreener", "live");
        commit();
      } catch {
        setSrc("dexscreener", "blocked");
        if (map.current.size === 0) setBlocked(true);
      }
    }

    async function enrichRug() {
      if (!CONFIG.RUGCHECK) return;
      const list = [...map.current.values()].slice(0, 20);
      let ok = false, bad = false;
      for (const t of list) {
        if (rugCache.current.has(t.address)) { assignDefined(t, rugCache.current.get(t.address)); continue; }
        try {
          const rep = await fetchJSON(`${rcBase()}/tokens/${t.address}/report`);
          const a = mapRug(rep);
          cacheSet(rugCache.current, t.address, a);
          assignDefined(t, a); ok = true;
        } catch { bad = true; }
      }
      setSrc("rugcheck", ok ? "live" : bad ? "blocked" : "idle");
      if (ok) commit();
    }

    async function enrichHelius() {
      if (!CONFIG.PROXY_BASE || !CONFIG.HELIUS) return; // Helius runs server-side via the proxy
      const list = [...map.current.values()].slice(0, 14);
      let ok = false, bad = false, off = false;
      for (const t of list) {
        if (heliusCache.current.has(t.address)) { applyHelius(t, heliusCache.current.get(t.address)); continue; }
        try {
          const d = await fetchJSON(`${CONFIG.PROXY_BASE}/enrich/${t.address}`, 15000);
          if (d && d.helius === false) { off = true; continue; }
          cacheSet(heliusCache.current, t.address, d);
          if (applyHelius(t, d)) ok = true;
        } catch { bad = true; }
      }
      setSrc("helius", ok ? "live" : off ? "idle" : bad ? "blocked" : "idle");
      if (ok) commit();
    }

    // deployer track record (slow + changes rarely → fewer tokens, longer interval)
    async function enrichDev() {
      if (!CONFIG.PROXY_BASE || !CONFIG.HELIUS) return;
      const list = [...map.current.values()].filter((t) => t.devDeployed == null && !devCache.current.has(t.address)).slice(0, 8);
      let ok = false;
      for (const t of list) {
        if (devCache.current.has(t.address)) { if (applyDev(t, devCache.current.get(t.address))) ok = true; continue; }
        try {
          const d = await fetchJSON(`${CONFIG.PROXY_BASE}/dev/${t.address}`, 20000);
          if (d && d.helius === false) continue;
          cacheSet(devCache.current, t.address, d);
          if (applyDev(t, d)) ok = true;
        } catch {}
      }
      if (ok) commit();
    }

    // smart-money: which tracked wallets hold each token (index is server-side, so this is cheap)
    async function enrichSmart() {
      if (!CONFIG.PROXY_BASE || !CONFIG.HELIUS || !CONFIG.SMART) return;
      const list = [...map.current.values()].slice(0, 16);
      let ok = false;
      for (const t of list) {
        try {
          const d = await fetchJSON(`${CONFIG.PROXY_BASE}/smart/${t.address}`, 12000);
          if (!d || d.helius === false || !d.tracked) continue; // no watchlist configured → skip
          cacheSet(smartCache.current, t.address, d, 800);
          if (applySmart(t, d)) ok = true;
        } catch {}
      }
      if (ok) commit();
    }

    let ws = null;
    if (CONFIG.PUMPPORTAL) {
      try {
        setSrc("pumpfun", "connecting");
        const wsUrl = CONFIG.PROXY_BASE ? CONFIG.PROXY_BASE.replace("http", "ws") + "/ws" : "wss://pumpportal.fun/api/data";
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          setSrc("pumpfun", "live");
          if (!CONFIG.PROXY_BASE) {
            try {
              ws.send(JSON.stringify({ method: "subscribeNewToken" }));
              ws.send(JSON.stringify({ method: "subscribeMigration" }));
            } catch {}
          }
        };
        ws.onmessage = (ev) => {
          try {
            const m = JSON.parse(ev.data);
            if (m.txType === "create" && m.mint) {
              const mc = (m.marketCapSol || 0) * SOL_USD;
              if (mc > 0 && mc < CONFIG.MCAP_CEILING && !map.current.has(m.mint)) {
                map.current.set(m.mint, fromPumpCreate(m, mc));
                commit();
              }
            } else if ((m.txType === "migrate" || m.txType === "migration") && m.mint) {
              // graduating coin → queue it so DexScreener fills full market data next poll
              if (!map.current.has(m.mint) && pending.current.size < 200) pending.current.add(m.mint);
            }
          } catch {}
        };
        ws.onerror = () => setSrc("pumpfun", "blocked");
      } catch { setSrc("pumpfun", "blocked"); }
    }

    fetchSolPrice().then(pollDex);
    const pollId = setInterval(pollDex, CONFIG.REFRESH_MS);
    const rugId = setInterval(enrichRug, 12000);
    const rugKick = setTimeout(enrichRug, 4000);
    const hxId = setInterval(enrichHelius, 20000);
    const hxKick = setTimeout(enrichHelius, 6000);
    const dvId = setInterval(enrichDev, 45000);
    const dvKick = setTimeout(enrichDev, 8000);
    const smId = setInterval(enrichSmart, 30000);
    const smKick = setTimeout(enrichSmart, 7000);
    const wd = setTimeout(() => { if (alive && map.current.size === 0) setBlocked(true); }, 9000);

    return () => {
      alive = false;
      clearInterval(pollId); clearInterval(rugId); clearTimeout(rugKick);
      clearInterval(hxId); clearTimeout(hxKick);
      clearInterval(dvId); clearTimeout(dvKick);
      clearInterval(smId); clearTimeout(smKick); clearTimeout(wd);
      if (commitTimer) clearTimeout(commitTimer);
      try { ws && ws.close(); } catch {}
    };
  }, [active]);

  return { tokens, sources, blocked };
}

// composes real + simulation: real when it's flowing, demo otherwise
function useFeed() {
  const [forceDemo, setForceDemo] = useState(CONFIG.MODE === "demo");
  const real = useRealFeed(!forceDemo);
  const useReal = !forceDemo && real.tokens.length > 0;
  const sim = useFeedEngine(forceDemo || (!useReal)); // sim runs while real isn't ready
  const tokens = useReal ? real.tokens : sim.tokens;
  const mode = forceDemo ? "demo" : useReal ? "live" : real.blocked ? "blocked" : "connecting";
  return {
    tokens,
    scanned: useReal ? real.tokens.length : sim.scanned,
    sources: real.sources,
    mode, forceDemo, setForceDemo,
  };
}

/* ======================= small UI pieces ======================= */

function ScoreRing({ score, conviction, size = 50 }) {
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (score / 100) * c;
  const col = convColor(conviction);
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "0 0 auto" }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset .6s ease, stroke .4s ease" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: col, fontSize: size * 0.36, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{score}</span>
      </div>
    </div>
  );
}

function MetricBar({ label, value }) {
  const col = metricColor(value);
  return (
    <div style={{ marginTop: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: SUB, fontSize: 10.5, letterSpacing: ".06em", textTransform: "uppercase" }}>{label}</span>
        <span style={{ color: TXT, fontSize: 12, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      </div>
      <div style={{ height: 2, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: 2, width: value + "%", background: col, transition: "width .6s ease, background .4s ease" }} />
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ color: MUTE, fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ color: color || TXT, fontSize: 13.5, fontWeight: 600, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Badge({ text, color, filled }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase",
      padding: "3px 8px", borderRadius: 6, color,
      background: filled ? color + "1f" : "transparent",
      border: filled ? "none" : `1px solid ${color}55`,
    }}>{text}</span>
  );
}

function RugBadge({ status }) {
  const c = rugColor(status);
  const label = status === "UNKNOWN" || !status ? "UNVERIFIED" : status;
  return (
    <span title={"RugCheck: " + label} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: c, flex: "0 0 auto" }}>
      <Shield size={13} /> {label}
    </span>
  );
}

function BuyBar({ buyPct, smartWallets }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
        <span style={{ width: 6, height: 6, borderRadius: 6, background: GREEN, display: "inline-block" }} />
        <span style={{ color: TXT, fontSize: 12, fontWeight: 600 }}>{smartWallets}</span>
        <span style={{ color: SUB, fontSize: 11 }}>smart wallets</span>
      </span>
      <span style={{ width: 1, height: 12, background: BORDER }} />
      <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 4, overflow: "hidden" }}>
          <span style={{ display: "block", height: 4, width: buyPct + "%", background: GREEN, transition: "width .5s ease" }} />
        </span>
        <span style={{ color: SUB, fontSize: 11, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" }}>{buyPct}% buy</span>
      </span>
    </div>
  );
}

// compact audit checklist — green check = safe, red cross = risk, grey ? = unverified
function AuditRow({ mintable, freezable, lpBurned }) {
  const items = [
    ["Mint", mintable == null ? null : !mintable, mintable == null ? "Mint authority unverified" : mintable ? "Mint authority ACTIVE — dev can print supply" : "Mint authority revoked"],
    ["Freeze", freezable == null ? null : !freezable, freezable == null ? "Freeze authority unverified" : freezable ? "Freeze authority ACTIVE — dev can freeze wallets" : "Freeze authority revoked"],
    ["LP Burn", lpBurned == null ? null : lpBurned, lpBurned == null ? "LP status unverified" : lpBurned ? "Liquidity burned/locked — dev can't pull LP" : "LP NOT burned — dev can pull liquidity"],
  ];
  return (
    <div style={{ display: "flex", gap: 7, marginTop: 13 }}>
      {items.map(([label, ok, title]) => {
        const c = ok == null ? MUTE : ok ? GREEN : RED;
        const tcol = ok == null ? SUB : ok ? "#bbf7d0" : "#fecaca";
        return (
          <div key={label} title={title} style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
            padding: "6px 4px", borderRadius: 8, background: c + "12", border: `1px solid ${c}33`,
          }}>
            {ok == null ? <span style={{ color: c, fontSize: 12, fontWeight: 700, lineHeight: 1 }}>?</span> : ok ? <Check size={13} color={c} /> : <X size={13} color={c} />}
            <span style={{ fontSize: 10.5, color: tcol, fontWeight: 600 }}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// deployer wallet — run (sold) or stay (holding) + track record
function DevRow({ status, holdPct, deployed, ath, rug }) {
  if (!status) {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 13, padding: "8px 11px", borderRadius: 10, background: SURFACE2, border: `1px solid ${BORDER}` }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: 7, background: MUTE, display: "inline-block" }} />
          <span style={{ color: SUB, fontSize: 11 }}>Dev</span>
          <span style={{ color: MUTE, fontSize: 12, fontWeight: 700 }}>—</span>
        </span>
        <span style={{ fontSize: 10.5, color: MUTE }}>history n/a · needs Helius</span>
      </div>
    );
  }
  const c = status === "HOLDING" ? GREEN : RED;
  const hasHist = deployed != null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 13, padding: "8px 11px", borderRadius: 10, background: SURFACE2, border: `1px solid ${BORDER}` }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
        <span style={{ width: 7, height: 7, borderRadius: 7, background: c, display: "inline-block" }} />
        <span style={{ color: SUB, fontSize: 11 }}>Dev</span>
        <span style={{ color: c, fontSize: 12, fontWeight: 700 }}>{status === "HOLDING" ? "STAYED" : "RAN"}</span>
        {status === "HOLDING" && holdPct != null && <span style={{ color: SUB, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{holdPct}%</span>}
      </span>
      {hasHist ? (
        <span style={{ fontSize: 10.5, color: SUB, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
          {deployed} deploys · <span style={{ color: ath > 0 ? GREEN : MUTE }}>{ath} ATH</span> · <span style={{ color: rug > 0 ? RED : MUTE }}>{rug} rug</span>
        </span>
      ) : (
        <span style={{ fontSize: 10.5, color: MUTE }}>history n/a</span>
      )}
    </div>
  );
}

// neutral key/value row for the detail drawer
function KVRow({ label, value, color, last }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: last ? "none" : `1px solid ${BORDER}` }}>
      <span style={{ color: SUB, fontSize: 12.5 }}>{label}</span>
      <span style={{ color: color || TXT, fontSize: 12.5, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

const LinkBtn = ({ label, href }) => (
  <a
    href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
    style={{
      flex: 1, textAlign: "center", fontSize: 10.5, fontWeight: 600, letterSpacing: ".04em",
      color: SUB, padding: "7px 0", borderRadius: 7, border: `1px solid ${BORDER}`,
      textDecoration: "none", transition: "all .15s ease",
    }}
    onMouseEnter={(e) => { e.currentTarget.style.color = TXT; e.currentTarget.style.borderColor = BORDER2; }}
    onMouseLeave={(e) => { e.currentTarget.style.color = SUB; e.currentTarget.style.borderColor = BORDER; }}
  >{label}</a>
);

const links = (addr) => [
  ["DEXSCREENER", `https://dexscreener.com/solana/${addr}`],
  ["GMGN", `https://gmgn.ai/sol/token/${addr}`],
  ["PHOTON", `https://photon-sol.tinyastro.io/en/lp/${addr}`],
  ["RUGCHECK", `https://rugcheck.xyz/tokens/${addr}`],
];

/* ======================= token card ======================= */
const TokenCard = memo(function TokenCard({ t, onOpen }) {
  const isEarly = t.ageMs < 60 * 60 * 1000;
  const up = t.change24h >= 0;
  const gc = t.currentX >= 1 ? GREEN : RED;
  return (
    <div
      onClick={() => onOpen(t)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(t); } }}
      role="button"
      tabIndex={0}
      aria-label={`${t.ticker} — Hunter score ${t.hunterScore}, ${t.conviction}`}
      className={t._new ? "af-card af-new" : "af-card"}
      style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 16, cursor: "pointer", position: "relative" }}
    >
      {/* conviction + venue + age */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
          <Badge text={t.conviction} color={convColor(t.conviction)} filled />
          {isEarly && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: ORANGE, fontSize: 9.5, fontWeight: 700 }}>
              <Flame size={11} /> EARLY
            </span>
          )}
          {t.venue && (
            <span style={{ fontSize: 9.5, fontWeight: 700, color: venueColor(t.venue), border: `1px solid ${venueColor(t.venue)}40`, borderRadius: 5, padding: "2px 6px", whiteSpace: "nowrap" }}>{t.venue}</span>
          )}
          {t.smartHolders > 0 && (
            <span title={`${t.smartHolders} tracked smart wallet${t.smartHolders > 1 ? "s" : ""} holding`} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, fontWeight: 700, color: "#c4b5fd", background: "#8b5cf61f", border: "1px solid #8b5cf655", borderRadius: 5, padding: "2px 6px", whiteSpace: "nowrap" }}>
              <Wallet size={10} /> {t.smartHolders} SMART
            </span>
          )}
        </div>
        <div style={{ color: MUTE, fontSize: 11, whiteSpace: "nowrap", flex: "0 0 auto" }}>AGE {fmtAge(t.ageMs)} · {fmtAge(Date.now() - t.detectedAt)} ago</div>
      </div>

      {/* name + score */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: TXT, fontSize: 17, fontWeight: 700, lineHeight: 1.1 }}>${t.ticker}</div>
          <div style={{ color: SUB, fontSize: 12.5, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
          <div style={{ color: MUTE, fontSize: 11, marginTop: 5, fontVariantNumeric: "tabular-nums" }}>{t.preview}</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <ScoreRing score={t.hunterScore} conviction={t.conviction} />
          <div style={{ color: MUTE, fontSize: 8.5, letterSpacing: ".12em", marginTop: 3 }}>HUNTER</div>
        </div>
      </div>

      {/* X-gain from deploy + RugCheck */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 12, padding: "8px 11px", borderRadius: 10, background: SURFACE2, border: `1px solid ${BORDER}` }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <TrendingUp size={14} color={gc} />
          <span style={{ color: gc, fontWeight: 800, fontSize: 15, fontVariantNumeric: "tabular-nums" }}>{(t._estimated ? "~" : "") + fmtX(t.currentX)}</span>
          <span style={{ color: SUB, fontSize: 11, whiteSpace: "nowrap" }}>from deploy</span>
        </span>
        <RugBadge status={t.rugStatus} />
      </div>

      {/* market stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 14 }}>
        <Stat label="MCAP" value={fmtUsd(t.mcap)} />
        <Stat label="LIQ" value={fmtUsd(t.liq)} />
        <Stat label="VOL 24H" value={fmtUsd(t.vol24h)} />
        <Stat label="24H" value={fmtPct(t.change24h)} color={up ? GREEN : RED} />
      </div>

      {/* holders / top10 / fees / snipers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 12 }}>
        <Stat label="Holders" value={t.holders != null ? t.holders.toLocaleString() + (t.holdersCapped ? "+" : "") : "—"} />
        <Stat label="Top 10" value={t.top10Pct != null ? t.top10Pct + "%" : "—"} color={t.top10Pct != null ? top10Color(t.top10Pct) : MUTE} />
        <Stat label="Total Fee" value={t.totalFeeSol != null ? (t._estimated ? "~" : "") + fmtSol(t.totalFeeSol) : "—"} />
        <Stat label="Snipers" value={t.snipers != null ? t.snipers : "—"} color={t.snipers == null ? MUTE : t.snipers > 25 ? RED : t.snipers > 15 ? AMBER : TXT} />
      </div>

      <BuyBar buyPct={t.buyPct} smartWallets={t.smartWallets} />

      <MetricBar label="Smart Money Flow" value={t.smartMoneyFlow} />
      <MetricBar label="Holder Growth" value={t.holderGrowth} />
      <MetricBar label="Volume Expansion" value={t.volumeExpansion} />
      <MetricBar label="Liquidity Health" value={t.liquidityHealth} />

      {/* audit checklist */}
      <AuditRow mintable={t.mintable} freezable={t.freezable} lpBurned={t.lpBurned} />

      {/* deployer run / stay + track record */}
      <DevRow status={t.devStatus} holdPct={t.devHoldPct} deployed={t.devDeployed} ath={t.devAth} rug={t.devRug} />

      {/* risk */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 13 }}>
        <Badge text={t.risk + " RISK"} color={riskColor(t.risk)} filled />
        {t.bundled && <Badge text="Bundled" color={AMBER} />}
      </div>

      {/* links */}
      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        {links(t.address).map(([l, h]) => <LinkBtn key={l} label={l} href={h} />)}
      </div>
    </div>
  );
});

/* ======================= detail drawer ======================= */
function ChartTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#16171c", border: `1px solid ${BORDER2}`, borderRadius: 8, padding: "6px 10px", fontSize: 12, color: TXT, fontVariantNumeric: "tabular-nums" }}>
      MC {fmtUsd(payload[0].value)}
    </div>
  );
}

function SectionLabel({ children, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, color: color || MUTE, fontSize: 10.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8, marginTop: 18 }}>
      {children}
    </div>
  );
}

function AuditDetailRow({ label, value, ok, last }) {
  const c = ok == null ? MUTE : ok ? GREEN : RED;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: last ? "none" : `1px solid ${BORDER}` }}>
      <span style={{ color: SUB, fontSize: 12.5 }}>{label}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: c, fontSize: 12.5, fontWeight: 600 }}>
        {value} {ok == null ? null : ok ? <Check size={14} /> : <X size={14} />}
      </span>
    </div>
  );
}

function Detail({ t, onClose }) {
  const [copied, setCopied] = useState(false);
  const up = t.change24h >= 0;
  const col = up ? GREEN : RED;
  const gc = t.currentX >= 1 ? GREEN : RED;

  const copy = async () => {
    try { await navigator.clipboard.writeText(t.address); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked in sandbox — links still work */ }
  };

  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 50, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: 16, overflowY: "auto", backdropFilter: "blur(4px)" }}>
      <div onClick={(e) => e.stopPropagation()} className="af-sheet" style={{ width: "100%", maxWidth: 520, background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 18, padding: 22, marginTop: 24, marginBottom: 24 }}>
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <ScoreRing score={t.hunterScore} conviction={t.conviction} size={64} />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ color: TXT, fontSize: 22, fontWeight: 700 }}>${t.ticker}</span>
                <Badge text={t.conviction} color={convColor(t.conviction)} filled />
                {t.venue && <span style={{ fontSize: 10, fontWeight: 700, color: venueColor(t.venue), border: `1px solid ${venueColor(t.venue)}40`, borderRadius: 5, padding: "2px 6px" }}>{t.venue}</span>}
              </div>
              <div style={{ color: SUB, fontSize: 13, marginTop: 2 }}>{t.name}</div>
              <button onClick={copy} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6, background: "transparent", border: "none", color: MUTE, fontSize: 11, cursor: "pointer", fontVariantNumeric: "tabular-nums", padding: 0 }}>
                {t.preview}{copied ? <Check size={12} color={GREEN} /> : <Copy size={12} />}
              </button>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: SUB, cursor: "pointer", padding: 4 }}><X size={20} /></button>
        </div>

        {/* X-gain banner */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 16, padding: "12px 14px", borderRadius: 12, background: gc + "10", border: `1px solid ${gc}33` }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <TrendingUp size={18} color={gc} />
            <span style={{ color: gc, fontWeight: 800, fontSize: 22, fontVariantNumeric: "tabular-nums" }}>{(t._estimated ? "~" : "") + fmtX(t.currentX)}</span>
            <span style={{ color: SUB, fontSize: 12 }}>from deploy · {fmtUsd(t.deployMcap)}</span>
          </span>
          <RugBadge status={t.rugStatus} />
        </div>

        {/* agent reasoning */}
        <div style={{ marginTop: 14, background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: convColor(t.conviction), fontSize: 10.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 7 }}>
            <Zap size={13} /> Agent read
          </div>
          <div style={{ color: "#d4d4d8", fontSize: 13.5, lineHeight: 1.55 }}>{t.reasoning}</div>
        </div>

        {/* chart */}
        <SectionLabel>Market cap · {fmtPct(t.change24h)}</SectionLabel>
        <div style={{ height: 150 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={t.history} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="mcg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={col} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={col} stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Tooltip content={<ChartTip />} cursor={{ stroke: BORDER2 }} />
              <Area type="monotone" dataKey="mc" stroke={col} strokeWidth={1.6} fill="url(#mcg)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* stat grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginTop: 16 }}>
          <Stat label="MCAP" value={fmtUsd(t.mcap)} />
          <Stat label="Liquidity" value={fmtUsd(t.liq)} />
          <Stat label="Vol 24h" value={fmtUsd(t.vol24h)} />
          <Stat label="24h" value={fmtPct(t.change24h)} color={col} />
          <Stat label="From deploy" value={(t._estimated ? "~" : "") + fmtX(t.currentX)} color={gc} />
          <Stat label="Deploy MC" value={fmtUsd(t.deployMcap)} />
          <Stat label="Total fees" value={t.totalFeeSol != null ? (t._estimated ? "~" : "") + fmtSol(t.totalFeeSol) : "—"} />
          <Stat label="Age" value={fmtAge(t.ageMs)} />
          <Stat label="Holders" value={t.holders != null ? t.holders.toLocaleString() + (t.holdersCapped ? "+" : "") : "—"} />
          <Stat label="Top 10" value={t.top10Pct != null ? t.top10Pct + "%" : "—"} color={t.top10Pct != null ? top10Color(t.top10Pct) : MUTE} />
          <Stat label={t._smartReal || t.smartHolders != null ? "Smart $" : "Wallets"} value={t.smartHolders != null ? t.smartHolders : (t.smartWallets != null ? t.smartWallets : "—")} color={t.smartHolders > 0 ? "#c4b5fd" : undefined} />
          <Stat label="Buy %" value={t.buyPct + "%"} color={GREEN} />
        </div>

        {/* signals */}
        <SectionLabel>Signals</SectionLabel>
        <MetricBar label="Smart Money Flow" value={t.smartMoneyFlow} />
        {t.smartHolders > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, padding: "9px 12px", borderRadius: 10, background: "#8b5cf61a", border: "1px solid #8b5cf655" }}>
            <Wallet size={15} color="#c4b5fd" />
            <span style={{ color: "#ddd6fe", fontSize: 12.5 }}>
              <b style={{ color: "#c4b5fd" }}>{t.smartHolders}</b> tracked smart wallet{t.smartHolders > 1 ? "s" : ""} holding
              {t.smartTracked ? <span style={{ color: SUB }}> · of {t.smartTracked} watched</span> : null}
            </span>
          </div>
        )}
        <MetricBar label="Holder Growth" value={t.holderGrowth} />
        <MetricBar label="Volume Expansion" value={t.volumeExpansion} />
        <MetricBar label="Liquidity Health" value={t.liquidityHealth} />

        {/* security / rugcheck */}
        <SectionLabel color={rugColor(t.rugStatus)}><Shield size={13} /> Security · RugCheck {t.rugStatus === "UNKNOWN" || !t.rugStatus ? "unverified" : t.rugStatus}</SectionLabel>
        <div style={{ background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "4px 14px" }}>
          <AuditDetailRow label="Mint authority" value={t.mintable == null ? "Unverified" : t.mintable ? "Enabled" : "Revoked"} ok={t.mintable == null ? null : !t.mintable} />
          <AuditDetailRow label="Freeze authority" value={t.freezable == null ? "Unverified" : t.freezable ? "Enabled" : "Revoked"} ok={t.freezable == null ? null : !t.freezable} />
          <AuditDetailRow label="Liquidity (LP)" value={t.lpBurned == null ? "Unverified" : t.lpBurned ? "Burned" : "Not burned"} ok={t.lpBurned == null ? null : t.lpBurned} />
          <AuditDetailRow label="Top 10 holders" value={t.top10Pct != null ? t.top10Pct + "% of supply" : "Unverified"} ok={t.top10Pct == null ? null : t.top10Pct < 30} />
          <AuditDetailRow label="Snipers in early" value={t.snipers != null ? t.snipers : "Unverified"} ok={t.snipers == null ? null : t.snipers <= 20} />
          <AuditDetailRow label="Risk tier" value={t.risk || "—"} ok={t.risk ? t.risk === "LOW" : null} last />
        </div>

        {/* deployer */}
        <SectionLabel color={t.devStatus === "HOLDING" ? GREEN : t.devStatus === "SOLD" ? RED : MUTE}><Wallet size={13} /> Deployer · {t.devStatus === "HOLDING" ? "stayed" : t.devStatus === "SOLD" ? "ran" : "unverified"}</SectionLabel>
        <div style={{ background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "4px 14px" }}>
          {t.devStatus ? (
            t.devDeployed != null ? (
              <>
                <AuditDetailRow label="Dev position" value={t.devStatus === "HOLDING" ? `Holding ${t.devHoldPct}%` : "Sold / exited"} ok={t.devStatus === "HOLDING"} />
                <KVRow label="Coins deployed (incl. this)" value={t.devDeployed} />
                <KVRow label="Past launches still alive" value={t.devAth} color={t.devAth > 0 ? GREEN : MUTE} />
                <KVRow label="Past launches dead / rugged" value={t.devRug} color={t.devRug > 0 ? RED : MUTE} />
                <AuditDetailRow
                  label="Dev rug rate"
                  value={t.devDeployed > 1 ? Math.round((t.devRug / (t.devDeployed - 1)) * 100) + "%" : "no history"}
                  ok={t.devDeployed <= 1 || t.devRug / (t.devDeployed - 1) <= 0.25}
                  last
                />
              </>
            ) : (
              <>
                <AuditDetailRow label="Dev position" value={t.devStatus === "HOLDING" ? `Holding ${t.devHoldPct}%` : "Sold / exited"} ok={t.devStatus === "HOLDING"} />
                <KVRow label="Deploy history" value="needs indexing" color={MUTE} last />
              </>
            )
          ) : (
            <KVRow label="Dev run / stay + history" value="needs Helius (run backend)" color={MUTE} last />
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
          {t.bundled && <Badge text="Bundled launch" color={AMBER} />}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          {links(t.address).map(([l, h]) => <LinkBtn key={l} label={l} href={h} />)}
        </div>
      </div>
    </div>
  );
}

/* ======================= controls ======================= */
const SORTS = [
  ["score", "Hunter Score"], ["new", "Newest"], ["gain", "X-Gain"],
  ["change", "24h Change"], ["vol", "Volume"],
];
function Pill({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 12, fontWeight: 500, padding: "6px 12px", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap",
      color: active ? "#0a0a0a" : SUB, background: active ? TXT : "transparent",
      border: `1px solid ${active ? TXT : BORDER}`, transition: "all .15s ease",
    }}>{children}</button>
  );
}

function HeaderStat({ icon, label, value, accent }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: accent || MUTE }}>{icon}</span>
      <span style={{ color: MUTE, fontSize: 11.5 }}>{label}</span>
      <span style={{ color: accent || TXT, fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

// isolated so the fast block counter doesn't re-render the whole grid
function LiveTicker({ live }) {
  const [blocks, setBlocks] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setBlocks((b) => b + 1), 440);
    return () => clearInterval(id);
  }, [live]);
  return <HeaderStat icon={<Radio size={13} />} label="Scanning block" value={"#" + (286401000 + blocks).toLocaleString()} />;
}

const srcDot = (s) => (s === "live" ? GREEN : s === "connecting" ? AMBER : s === "blocked" ? RED : MUTE);
function SourceStatus({ sources }) {
  const items = [["DexScreener", "dexscreener"], ["RugCheck", "rugcheck"], ["Pump.fun", "pumpfun"], ["Meteora", "meteora"], ["Helius", "helius"]];
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ color: MUTE, fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase" }}>Feeds</span>
      {items.map(([label, key]) => {
        const st = sources[key] || "idle";
        return (
          <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: SUB }}>
            <span className={st === "connecting" ? "af-blink" : ""} style={{ width: 7, height: 7, borderRadius: 7, background: srcDot(st), display: "inline-block" }} />
            {label}
            <span style={{ color: srcDot(st), fontWeight: 600 }}>{st === "idle" ? "·" : st === "live" ? "live" : st === "connecting" ? "…" : "blocked"}</span>
          </span>
        );
      })}
    </div>
  );
}

function ModeBanner({ mode }) {
  if (mode === "live") return null;
  const map = {
    connecting: [AMBER, "Connecting to live Solana feeds… showing demo data meanwhile."],
    blocked: [AMBER, "Live feeds are blocked here (browser CORS / claude.ai sandbox). Showing the demo. To get real data: run the included backend and set CONFIG.PROXY_BASE, or run this frontend outside the sandbox. DexScreener + Pump.fun work browser-side; RugCheck + Meteora need the proxy."],
    demo: [MUTE, "Demo mode. Tap the toggle to attempt live DexScreener / RugCheck / Pump.fun / Meteora feeds."],
  };
  const [c, msg] = map[mode] || [MUTE, ""];
  return (
    <div style={{ maxWidth: 1320, margin: "0 auto", padding: "0 20px" }}>
      <div style={{ marginTop: 12, padding: "9px 13px", borderRadius: 10, background: c + "12", border: `1px solid ${c}33`, color: "#d4d4d8", fontSize: 12, lineHeight: 1.5 }}>
        {msg}
      </div>
    </div>
  );
}

/* ======================= app ======================= */
export default function App() {
  const { tokens, scanned, sources, mode, forceDemo, setForceDemo } = useFeed();
  const [sort, setSort] = useState("score");
  const [conv, setConv] = useState("all");
  const [riskMax, setRiskMax] = useState("all");
  const [venueF, setVenueF] = useState("all");
  const [safeOnly, setSafeOnly] = useState(false);
  const [smartOnly, setSmartOnly] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);

  const openLive = useMemo(
    () => (open ? tokens.find((t) => t.id === open.id) || open : null),
    [open, tokens]
  );

  const view = useMemo(() => {
    let list = tokens.filter((t) => {
      if (t.mcap >= MCAP_CEILING) return false; // sub-$100K only
      if (conv === "high" && t.conviction !== "HIGH CONVICTION") return false;
      if (conv === "mod" && t.conviction === "WATCH") return false;
      if (riskMax === "low" && !(t.risk === "LOW" || t.rugStatus === "GOOD")) return false;
      if (venueF !== "all" && t.venue !== venueF) return false;
      if (safeOnly && (t.mintable === true || t.freezable === true || t.lpBurned === false)) return false;
      if (smartOnly && !(t.smartHolders > 0)) return false;
      if (q && !(`${t.ticker} ${t.name}`.toLowerCase().includes(q.toLowerCase()))) return false;
      return true;
    });
    const by = {
      score: (a, b) => b.hunterScore - a.hunterScore,
      new: (a, b) => b.detectedAt - a.detectedAt,
      gain: (a, b) => b.currentX - a.currentX,
      change: (a, b) => b.change24h - a.change24h,
      vol: (a, b) => b.vol24h - a.vol24h,
    }[sort];
    return [...list].sort(by);
  }, [tokens, conv, riskMax, venueF, safeOnly, smartOnly, q, sort]);

  const high = view.filter((t) => t.conviction === "HIGH CONVICTION").length;
  const avg = view.length ? Math.round(view.reduce((s, t) => s + t.hunterScore, 0) / view.length) : 0;

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TXT, fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <style>{`
        @keyframes afIn { from { opacity:0; transform: translateY(-8px) scale(.985); } to { opacity:1; transform:none; } }
        @keyframes afPulse { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,.5); } 100% { box-shadow: 0 0 0 12px rgba(34,197,94,0); } }
        @keyframes afSheet { from { opacity:0; transform: translateY(12px); } to { opacity:1; transform:none; } }
        @keyframes afBlink { 0%,100%{opacity:1} 50%{opacity:.25} }
        .af-card { transition: border-color .15s ease, transform .15s ease, background .15s ease; }
        .af-card:hover { border-color: ${BORDER2}; background: ${SURFACE2}; transform: translateY(-2px); }
        .af-card:focus-visible { outline: 2px solid ${GREEN}; outline-offset: 2px; }
        button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid ${GREEN}; outline-offset: 2px; }
        .af-new { animation: afIn .45s ease, afPulse 2.4s ease 1; border-color: rgba(34,197,94,.5) !important; }
        .af-sheet { animation: afSheet .25s ease; }
        .af-blink { animation: afBlink 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce){ *{ animation:none !important; transition:none !important; } }
        ::-webkit-scrollbar{ width:10px; height:10px; }
        ::-webkit-scrollbar-thumb{ background:#26272c; border-radius:8px; }
      `}</style>

      {/* header */}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: "rgba(8,9,10,0.85)", backdropFilter: "blur(10px)", borderBottom: `1px solid ${BORDER}` }}>
        <div style={{ maxWidth: 1320, margin: "0 auto", padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ display: "inline-flex", width: 32, height: 32, borderRadius: 9, background: GREEN + "1a", border: `1px solid ${GREEN}55`, alignItems: "center", justifyContent: "center" }}>
                <Crosshair size={17} color={GREEN} />
              </span>
              <div>
                <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: ".02em" }}>ALPHA FEED</div>
                <div style={{ color: SUB, fontSize: 11.5, marginTop: 1 }}>Solana early-call scanner · under $100K · real feeds + fallback</div>
              </div>
            </div>
            <button
              onClick={() => setForceDemo((v) => !v)}
              aria-label={forceDemo ? "Switch to live data" : "Switch to demo data"}
              title={mode === "blocked" ? "Live feeds blocked by the sandbox — run the backend for real data" : "Toggle live / demo"}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 600, padding: "7px 13px", borderRadius: 9, cursor: "pointer",
                color: mode === "live" ? GREEN : mode === "demo" ? SUB : AMBER,
                background: mode === "live" ? GREEN + "14" : mode === "demo" ? "transparent" : AMBER + "12",
                border: `1px solid ${mode === "live" ? GREEN + "55" : mode === "demo" ? BORDER : AMBER + "44"}` }}
            >
              <span className={mode === "connecting" ? "af-blink" : ""} style={{ width: 7, height: 7, borderRadius: 7, display: "inline-block",
                background: mode === "live" ? GREEN : mode === "demo" ? MUTE : AMBER }} />
              {mode === "live" ? "LIVE · Solana" : mode === "connecting" ? "Connecting…" : mode === "blocked" ? "Demo (live blocked)" : "Demo"}
            </button>
          </div>

          <div style={{ display: "flex", gap: 22, marginTop: 14, flexWrap: "wrap" }}>
            <LiveTicker live={mode !== "demo"} />
            <HeaderStat icon={<Activity size={13} />} label={mode === "live" ? "Tokens live" : "Tokens seen"} value={scanned.toLocaleString()} />
            <HeaderStat icon={<Zap size={13} />} label="Signals" value={view.length} />
            <HeaderStat icon={<Flame size={13} />} label="High conviction" value={high} accent={GREEN} />
            <HeaderStat icon={<TrendingUp size={13} />} label="Avg score" value={avg} />
          </div>

          <div style={{ marginTop: 12 }}>
            <SourceStatus sources={sources} />
          </div>
        </div>
      </div>

      <ModeBanner mode={mode} />

      {/* controls */}
      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "18px 20px 8px" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: MUTE, fontSize: 11, marginRight: 2 }}>
            <ArrowUpDown size={13} /> SORT
          </div>
          {SORTS.map(([k, l]) => <Pill key={k} active={sort === k} onClick={() => setSort(k)}>{l}</Pill>)}

          <div style={{ width: 1, height: 22, background: BORDER, margin: "0 4px" }} />
          <Pill active={conv === "all"} onClick={() => setConv("all")}>All</Pill>
          <Pill active={conv === "high"} onClick={() => setConv("high")}>High conviction</Pill>
          <Pill active={conv === "mod"} onClick={() => setConv("mod")}>Moderate+</Pill>

          <div style={{ width: 1, height: 22, background: BORDER, margin: "0 4px" }} />
          <Pill active={riskMax === "low"} onClick={() => setRiskMax(riskMax === "low" ? "all" : "low")}>Low risk only</Pill>
          <Pill active={safeOnly} onClick={() => setSafeOnly((v) => !v)}>Audit clean only</Pill>
          <Pill active={smartOnly} onClick={() => setSmartOnly((v) => !v)}>Smart money</Pill>

          <div style={{ width: 1, height: 22, background: BORDER, margin: "0 4px" }} />
          {["all", "Pump.fun", "Meteora", "Raydium", "Bonk"].map((v) => (
            <Pill key={v} active={venueF === v} onClick={() => setVenueF(v)}>{v === "all" ? "All venues" : v}</Pill>
          ))}

          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 9, padding: "7px 11px", minWidth: 180 }}>
            <Search size={14} color={MUTE} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ticker…" aria-label="Search by ticker or name" style={{ background: "transparent", border: "none", outline: "none", color: TXT, fontSize: 13, width: "100%" }} />
          </div>
        </div>
      </div>

      {/* grid */}
      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "12px 20px 60px" }}>
        {view.length === 0 ? (
          <div style={{ textAlign: "center", padding: "80px 0", color: SUB }}>
            <Crosshair size={28} color={MUTE} style={{ marginBottom: 12 }} />
            <div style={{ fontSize: 15, color: TXT, fontWeight: 600 }}>No signals match your filters</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>Loosen the conviction, risk, or audit filter, or clear the search.</div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {view.map((t) => <TokenCard key={t.id} t={t} onOpen={setOpen} />)}
          </div>
        )}

        <div style={{ textAlign: "center", marginTop: 32, color: MUTE, fontSize: 11.5, lineHeight: 1.6, maxWidth: 660, marginLeft: "auto", marginRight: "auto" }}>
          Scanning only sub-$100K launches. Hunter Score is a momentum + safety read, not a price prediction.
          The audit (mint / freeze / LP) and RugCheck status reduce — but never remove — rug risk. Most early
          memecoins go to zero. Nothing here is financial advice — size positions you can afford to lose.
        </div>
      </div>

      {openLive && <Detail t={openLive} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* =========================================================================
   DATA LAYER — what's wired (see CONFIG near the top to switch it on)
   -------------------------------------------------------------------------
   The feed runs the real sources first and falls back to the simulation when
   the network is blocked (CORS / claude.ai sandbox). Set CONFIG.MODE and
   CONFIG.PROXY_BASE to control it; the included server.js proxy makes the
   CORS-blocked sources work and adds the Helius signals.

   REAL (straight from source):
   • New launches + migrations  → pump.fun via the PumpPortal websocket
                                  (subscribeNewToken + subscribeMigration).
   • Price / liq / vol / venue  → DexScreener (profiles + boosts discovery,
                                  batch token reads). Identifies Meteora /
                                  Raydium / Pump.fun / Orca / Bonk.
   • Meteora pools              → DexScreener dexId + the DLMM /pair/all list
                                  (via the proxy).
   • Mint / freeze / LP / top10 → RugCheck (/tokens/<mint>/report).
   • Holders, top-10 %, dev     → Helius via the proxy: /api/enrich (holders,
     run/stay, dev history        authorities, top-10, dev run-stay) and
                                  /api/dev (deployer launch history).

   DERIVED from the above (shown with "~", filled from real inputs):
   • smart-money flow, volume expansion, total fees, X-from-deploy.

   Flow: each source fills a token's fields → finalizeLive(token) computes the
   X-gain, Hunter Score, conviction, and agent read. Sources layer without
   clobbering (assignDefined / non-null merges), and every commit emits fresh
   token objects so memoized cards reflect late-arriving enrichment.
   ========================================================================= */
