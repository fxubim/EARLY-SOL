# ALPHA FEED — Solana early-call scanner

A sub-$100K Solana memecoin scanner. Real data from DexScreener, pump.fun
(PumpPortal), Meteora, RugCheck, and Helius, with a built-in demo fallback.

```
alpha-feed-scanner/
├── frontend/   → the React app (deploy to Vercel)
└── backend/    → the proxy + websocket (deploy to Render)
```

You can deploy the **frontend alone** (you get DexScreener + pump.fun live) or
**frontend + backend** (everything live, including RugCheck, Meteora, Helius
holders / dev / smart-money). The backend keeps your API keys server-side.

---

## 0) What you need

- A free [GitHub](https://github.com) account
- A free [Render](https://render.com) account (for the backend)
- A free [Vercel](https://vercel.com) account (for the frontend)
- (Recommended) a free [Helius](https://helius.dev) API key for the premium signals
- Git on your computer **or** just use GitHub's web upload (drag-and-drop)

You do **not** need Node installed locally — Render and Vercel build it for you.

---

## 1) Put the code on GitHub

**Option A — command line**

```bash
cd alpha-feed-scanner
git init
git add .
git commit -m "ALPHA FEED scanner"
# make an empty repo on github.com first, then:
git remote add origin https://github.com/YOUR_NAME/alpha-feed-scanner.git
git branch -M main
git push -u origin main
```

**Option B — no command line**

1. On github.com click **New repository** → name it `alpha-feed-scanner` → Create.
2. On the repo page click **uploading an existing file**.
3. Drag the **contents** of the `alpha-feed-scanner` folder in → Commit.

> `.gitignore` already excludes `node_modules`, `.env`, and `smart-wallets.json`
> so you never upload secrets.

---

## 2) Deploy the BACKEND to Render

1. Render dashboard → **New** → **Web Service** → connect your GitHub repo.
2. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
3. **Environment** → add variables (all optional but recommended):
   - `HELIUS_API_KEY` = your Helius key  → unlocks holders / dev / smart-money
   - `SMART_WALLETS` = `wallet1,wallet2,...`  → your smart-money watchlist
4. **Create Web Service.** When it finishes you'll get a URL like
   `https://alpha-feed-backend.onrender.com`. **Copy it.**
5. Test it: open `https://...onrender.com/api/health` — you should see
   `{"ok":true,...}`.

> Render's free tier sleeps after ~15 min idle, so the first load after a nap
> takes ~30s to wake. Fine for personal use; upgrade for always-on.

---

## 3) Point the frontend at your backend

Open `frontend/src/App.jsx`, find the `CONFIG` block near the top, and set
`PROXY_BASE` to your Render URL **with `/api` on the end**:

```js
const CONFIG = {
  MODE: "live",
  PROXY_BASE: "https://alpha-feed-backend.onrender.com/api",  // <-- your URL + /api
  ...
};
```

Commit and push that change (or edit it directly on GitHub and Commit).

> Use the **https** URL. The app automatically turns it into `wss://…` for the
> pump.fun stream, so secure pages and secure sockets just work.

---

## 4) Deploy the FRONTEND to Vercel

1. Vercel dashboard → **Add New** → **Project** → import your repo.
2. Settings:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Vite (auto-detected)
   - **Build Command:** `npm run build`  (default)
   - **Output Directory:** `dist`  (default)
3. **Deploy.** You'll get a URL like `https://alpha-feed-scanner.vercel.app`.

Open it on your phone. The **Feeds** row should turn green (DexScreener,
RugCheck, Pump.fun, Meteora, Helius) and real sub-$100K tokens stream in.

---

## Frontend only (skip the backend)

If you just want the quickest live deploy: leave `PROXY_BASE: ""`, do step 4
only. DexScreener + the pump.fun websocket work straight from the browser, so
you'll see live price / launches; RugCheck, Meteora, and the Helius signals will
show as "blocked / unverified" (they need the proxy for CORS + keys).

---

## Updating later

Push to GitHub → Render and Vercel redeploy automatically. To change your
smart-money list, just edit the `SMART_WALLETS` variable in Render and redeploy.

---

## Troubleshooting

- **Feeds stay on "Demo"** → `PROXY_BASE` is empty or wrong. It must be your
  Render URL ending in `/api`, over **https**.
- **Helius dot grey** → no `HELIUS_API_KEY` set in Render (holders / dev /
  smart-money need it).
- **No SMART badges** → `SMART_WALLETS` empty, or those wallets don't currently
  hold any of the shown tokens.
- **Backend slow on first hit** → Render free tier waking up (~30s).
- **Pump.fun "blocked" on Vercel without backend** → expected; the browser
  allows the websocket only some of the time. Use the backend for reliability.

---

## Not financial advice

Most sub-$100K memecoins go to zero. The Hunter Score is a momentum + safety
read, not a prediction. Audit / RugCheck / dev / smart-money reduce — never
remove — rug risk. Only risk what you can afford to lose.
