# CLAUDE.md

Project: a real-time low-float momentum screener with a multi-panel web dashboard. The original implementation is a bash script (`screener-poll_breakout.sh`) — it stays as-is. The web port lives in `apps/api` (Express + Kysely + Postgres) and `apps/web` (React + Antd + Vite). Multi-user with JWT auth.

The web service runs a singleton `PollerService` that does the same Finviz + Yahoo + Benzinga work as the bash script (plus SEC EDGAR filings and Nasdaq trade halts), persists every cycle to Postgres, and pushes live deltas to the browser via SSE.

**Continuing a session? Start with [`docs/HANDOVER.md`](docs/HANDOVER.md)** — the live "where we are + what's open" layer; its CURRENT FOCUS and PENDING TASK headers say what matters right now. Then:

**Status & roadmap:** what's built, recent work, and what's next live in [`docs/web-dashboard.md`](docs/web-dashboard.md). The low-float runner-detection strategy and its phased plan: [`docs/catching-runners.md`](docs/catching-runners.md); the Ignition screener spec: [`docs/ignition-screener-spec.md`](docs/ignition-screener-spec.md); the in-progress multi-day Swing screener spec: [`docs/swing-screener-spec.md`](docs/swing-screener-spec.md). **The early-detection chain (📰 news radar → 🤫 quiet accumulation → 📈 EMA cross → 👀/🛰️ tick watch/confirm → screens) is documented layer-by-layer in [`docs/detection-layers.md`](docs/detection-layers.md)** — read it before touching the tick feed, the poller's tier logic, or `tier_events`.

## Environment Variables

Required in `.env` (copy from `.env.example`):

```bash
DATABASE_URL=postgres://app:app@localhost:5438/app?sslmode=disable
FINVIZ_API_TOKEN=your-token-here
BENZINGA_API_TOKEN=bz.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # optional — comment out to park the sub (radar goes dark; Finviz/Yahoo/SEC/halt news continue)
SEC_EDGAR_USER_AGENT=App Name (you@example.com)          # optional — SEC requires a descriptive UA; a default is used if unset
JWT_SECRET=your-secret-key-here
JWT_EXPIRES_IN=7d
REGISTRATION_OPEN=true                                   # public sign-up — closed unless exactly 'true'
TELEGRAM_BOT_TOKEN=...                                   # optional — Telegram bot token for push alerts + commands
TELEGRAM_CHAT_ID=...                                     # optional — destination chat id for alerts + command auth
TELEGRAM_USER_ID=...                                     # optional — dashboard user uuid the bot acts as for /hidden + /unhide
DATABENTO_API_KEY=db-...                                 # optional — Databento live (EQUS.MINI) for the tick-feed early-ignition detector
TICKFEED_ENABLED=true                                    # optional — turn on the live tick feed (needs DATABENTO_API_KEY + a Standard/US-Equities subscription); off unless exactly 'true'
TICKFEED_PYTHON=python3                                  # optional — python interpreter for the sidecar (default python3)
ALERTS_DISABLED=tick_watch,accum                         # optional — mute these components' TELEGRAM pushes only; detection, grading, and the dashboard keep running (also: edge_armed, edge_entry, edge_bailout, vwap_reclaim)
COMPONENTS_DISABLED=ignition,momo,setups,ema,swing,outcomes,continuation,edge # optional product gates; this lean set is the default. Empty = enable all; "faders" aliases "continuation"
```

## Database Schema

Postgres, migrations via `dbmate` in `db/migrations/`.

| Table | Purpose |
|---|---|
| `users` | Accounts (JWT auth) |
| `screener_cycles` | One row per poll: `polled_at`, `filter_snapshot` (jsonb), `row_count` |
| `screener_results` | Tickers seen in each cycle: `cycle_id`, `ticker`, `change_pct`, `float_m`, `price`, `volume`, `mcap`, `country`, `status` (NEW/ACC/UP/NEWS/-), `prev_change_pct` |
| `news_articles` | Deduped news: `source` (finviz/yahoo/benzinga/sec/halt), `url` UNIQUE, `title`, `published_at`, `fetched_at`, `raw` (jsonb) |
| `news_ticker_links` | M:N — `article_id`, `ticker` |
| `user_filter_presets` | Per-user saved filters: `user_id`, `name`, `filter` (jsonb), `is_default` |
| `user_panel_layout` | Per-user panel sizing/visibility: `user_id`, `layout` (jsonb) |
| `user_chart_prefs` | Per-user chart slots: `user_id`, `slot` (1..4), `ticker`, `interval` |
| `user_edge_presets` | Per-user/per-ticker Edge rules: custom EMA pair, proximity and bailout buffers, alert switches |
| `edge_bars_1m` | Small shared 1-minute warmup store for saved Edge tickers only (not the parked global technical universe) |
| `edge_events` | Durable Armed/Entry/Bailout transitions with indicator snapshot for review and later journal attribution |
| `broker_imports` | Per-user uploaded broker statement (IBKR `.tlg`): `account`, `file_hash`, period, fill counts |
| `trade_executions` | Per-user broker fills: `exec_id` (UNIQUE per user — idempotent re-import), `symbol`, `side`, signed `quantity`/`amount`, `commission`, `executed_at` (ET wall clock), `et_date`. Round-trip *trades* (flat-to-flat, P&L by exit date) are derived in `services/ibkr-tlg.ts`, not stored. Powers the `/journal` P&L calendar |

## Code Conventions

- **API responses:** `{ data: ... }` for success, `{ error: ... }` for failure
- **DB:** `getDb()` for lazy initialization (ensures env vars loaded). For quick queries: `source .env && psql "$DATABASE_URL"`
- **Validation:** Zod schemas at route boundaries
- **Naming:** camelCase in TypeScript, snake_case in Postgres
- **Types:** Kysely `Database` interface in `apps/api/src/db/types.ts` mirrors migrations
- **Imports:** ESM only (`type: module`); local imports keep the `.js` extension at runtime (`import x from './foo.js'`)
- **Frontend state:** TanStack Query for server state; React Context only for cross-cutting concerns (auth)

## Polling architecture (how the web service replicates the bash script)

`apps/api/src/services/poller.ts` is a long-lived singleton. On API startup it begins a 20s loop:

1. Fetch Finviz `v=131` (ownership: gives float, mcap, price, change, volume) **and** `v=110` (overview: gives country) in parallel. Join by ticker. Post-filter `float < FLOAT_MAX_M` (default 35M).
2. Per cycle, fetch news from five sources:
   - **Finviz** `news_export?v=3&t=<batch>` — one call for all current tickers, today only
   - **Yahoo RSS** `feeds.finance.yahoo.com/rss/2.0/headline?s=<ticker>` — per-ticker fan-out, today only
   - **Benzinga delta** `api.benzinga.com/api/v2/news?updatedSince=<watermark>` with `Accept: application/json` header — only articles with `ts > stored_max` count as "fresh" (audio-worthy)
   - **SEC EDGAR** `browse-edgar?action=getcurrent` — the "latest filings" firehose (one call), matched to screener tickers via the `company_tickers.json` CIK map. Surfaces offerings/dilution (424B*, S-1/S-3), 8-Ks, M&A, and 13D/G stakes. Watermark = filing dissemination ts.
   - **Nasdaq trade halts** `nasdaqtrader.com/rss.aspx?feed=tradehalts` — the market-wide halt feed (one call), filtered to screener tickers. A T1 ("news pending") halt scores as a major catalyst. Watermark = halt ts.
3. Merge precedence (highest wins): **halt > sec > Benzinga > Yahoo > Finviz**
4. Cross-cycle state lives in service memory (per-ticker `prev_change_pct`, Benzinga headline cache, three ts watermarks — Benzinga / SEC / halt). Auto-cleared at midnight ET.
5. Classify rows: `NEW` (first appearance), `ACC` (`change% delta > 2`), `UP` (any positive delta), `NEWS` (no movement but has today's news).
6. Persist cycle + rows + new news articles to DB.
7. Broadcast a delta payload to all connected SSE clients on `/api/screener/stream`.
8. Push a Telegram alert (if `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set) for any row with fresh news and a strong/major catalyst — once per article URL, so it never spams. Server-side, so alerts arrive even with no browser open.

When enabled, each cycle also runs a second **Ignition screen** alongside the Momentum one. In the default lean profile it is parked by `COMPONENTS_DISABLED`, so its fetch, score, writes, payload and UI list do not run. The same gate parks MOMO/SETUPS/EMA, Swing, Outcomes, Continuation and Edge (parked 2026-08-21 — `EdgeService` does not start and `/api/edge` answers 503); the shared daily-bar and technical-bar engines start only when one of their consumers is enabled. Databento Live Ticks remains active in detector-only mode. See `docs/HANDOVER.md` for the current operating profile and `docs/ignition-screener-spec.md` for the preserved experiment.

A standalone `ShelfService` (`services/shelf.ts`) runs alongside the poller: for every screener ticker it does a rate-limited 12-month SEC submissions lookback (`data.sec.gov/submissions`) and grades dilution risk `shelf` / `effective` / `active` — an effective shelf is the runner's kill-switch. The flag rides on each enriched row, penalises the `runner_score`, and shows in Telegram alerts.

**Single-instance only:** the service holds cross-cycle state in memory. Don't deploy multiple replicas without moving state to Redis or DB.

## Finviz API Quick Reference

**Important:** Add `-A "Mozilla/5.0"` to curl commands to avoid blocks. Add `-L` to follow the `export.ashx` → `export` redirect (Finviz silently moved this in early 2026).

**Rate limit:** Finviz Elite's real ceiling is **~1 request/second** (measured 2026-06-11: a 2nd call 300ms after the 1st gets a 429). All API-side Finviz HTTP goes through `rateLimitGate()` in `apps/api/src/services/finviz.ts` (≥1.1s spacing) and 429s raise a typed `FinvizRateLimitError`. Keep manual curl probing under ~1/s too — hammering faster starves the live poller.

```bash
# Screen stocks (v=111 overview, v=171 technical, v=131 ownership, v=161 financial)
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/export?v=171&f=sh_price_o20,sh_price_u30,cap_midover&auth=$FINVIZ_API_TOKEN"

# Price history (daily bars only — Finviz API doesn't expose intraday)
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/quote_export?t=AAPL&p=d&auth=$FINVIZ_API_TOKEN" | tail -30

# News (batch via comma-separated tickers)
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/news_export?v=3&t=AAPL,MSFT&auth=$FINVIZ_API_TOKEN"
```

### Reliable Fetch Patterns

News and quote exports sometimes return empty on first call. Use:
- **News:** don't pipe — let it complete fully, then process
- **Quotes:** save to file then read (most reliable for large data)

```bash
source .env

# QUOTES (large data) — save to file first
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/quote_export?t=TICKER&p=d&auth=$FINVIZ_API_TOKEN" > /tmp/ticker.csv && tail -60 /tmp/ticker.csv

# MULTIPLE TICKERS — Technical
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/export?v=171&t=AAPL,MSFT,GOOGL&auth=$FINVIZ_API_TOKEN"

# MULTIPLE TICKERS — Ownership
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/export?v=131&t=AAPL,MSFT,GOOGL&auth=$FINVIZ_API_TOKEN"
```

### View Types for Screening

| View | Code | Data Returned |
|------|------|---------------|
| Overview | v=111 / v=110 | Ticker, company, sector, market cap, P/E, price, change, volume, country |
| Technical | v=171 | Beta, ATR, SMA 20/50/200, 52W High/Low, RSI, price, change, volume |
| Ownership | v=131 | Market cap, shares, insider/inst ownership & transactions, short float/ratio, **shares float** |
| Financial | v=161 | P/E, EPS, profit margin, ROE, debt/equity, dividend yield |

**Key gotcha:** No single view returns both `Float` AND `Country`. The poller calls `v=131` + `v=110` in parallel and joins by ticker.

**If a fetch returns empty:** retry without piping to `head`/`tail` first; pipe after confirming data returns.

## Single Stock Analysis Template

When the user asks for analysis of a single stock (demand/support zones + trade setups), use this structure:

### 1. Current Stats Table
| Metric | Value |
|--------|-------|
| **Price** | $XX.XX (+/-X.XX%) |
| **Market Cap** | $X.XB |
| **RSI** | XX.XX (oversold <30 / neutral 30-70 / overbought >70) |
| **Beta** | X.XX |
| **vs 52W High** | -XX.XX% |
| **vs 52W Low** | +XX.XX% |
| **Short Float** | XX.XX% |
| **Inst Trans** | +/-XX.XX% |
| **Insider Trans** | +/-XX.XX% |

### 2. Technical Position Table
| SMA | vs Price | Trend |
|-----|----------|-------|
| 20 SMA | +/-X.XX% | Bullish/Bearish |
| 50 SMA | +/-X.XX% | Bullish/Bearish |
| 200 SMA | +/-X.XX% | Bullish/Bearish |

### 3. Price Structure (ASCII)
```
$XX.XX ─── 52W High / Resistance
$XX.XX ─── Resistance level
$XX.XX ─── Current price ◀ CURRENT
$XX.XX ─── Support level
$XX.XX ─── Demand zone
$XX.XX ─── 52W Low
```

### 4. Support & Demand Zones
- **Support:** lows tested multiple times that held
- **Demand:** consolidation areas before significant rallies (accumulation)
- **Strength:** more tests + longer consolidation = stronger zone

### 5. Catalysts / Concerns / Positives — short tables
### 6. Trade Setup
| Scenario | Entry | Stop | Target | R/R | Time Stop |
|----------|-------|------|--------|-----|-----------|
| Aggressive | ... | ... | ... | X:1 | 5d |
| Moderate | ... | ... | ... | X:1 | 5d |
| Conservative | ... | ... | ... | X:1 | 7d |

### 7. Verdict — bias, best entry, key risks, BUY/WATCH/SKIP

## Key Metrics Interpretation

### RSI
| Range | Interpretation |
|-------|----------------|
| < 30 | Oversold — potential bounce |
| 30-50 | Neutral-bearish |
| 50-70 | Neutral-bullish |
| > 70 | Overbought — potential pullback |

### Short Float
| Short Float | Risk |
|-------------|------|
| < 5% | Low |
| 5-15% | Medium |
| 15-25% | High |
| > 25% | Very high (squeeze + downside both elevated) |

### Insider/Inst Activity
| Activity | Interpretation |
|----------|----------------|
| Inst Trans > +5% | Institutions accumulating (bullish) |
| Inst Trans < -5% | Institutions distributing (bearish) |
| Insider Trans > 0 | Insiders buying (very bullish) |
| Insider Trans -3% to 0 | Minimal selling, not alarming |
| Insider Trans -3% to -10% | Moderate selling |
| Insider Trans < -10% | Heavy insider selling (red flag) |

### Beta
| Beta | Volatility |
|------|------------|
| < 1.0 | Less volatile than market |
| 1.0-2.0 | Normal |
| 2.0-4.0 | High |
| > 4.0 | Extreme |

### Market Regime
| Signal | Regime | Action |
|--------|--------|--------|
| SPY/QQQ above SMA20, VIX < 20 | Risk-On | Screen normally |
| SPY/QQQ near SMA20, VIX 20-25 | Neutral | Reduce picks, smaller positions |
| SPY/QQQ below SMA20, VIX > 25 | Risk-Off | Pause screening, favor defensives |
| Multiple sectors down >3%/day | Broad Selloff | Do NOT enter new positions |

## Direct Database Access

For quick queries:

```bash
source .env
psql "$DATABASE_URL" -c "SELECT * FROM screener_cycles ORDER BY polled_at DESC LIMIT 5;"
```
