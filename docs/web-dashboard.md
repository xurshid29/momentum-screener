# Momentum Screener — Web Dashboard

Status as of 2026-05-04. The bash scanner (`screener-poll_breakout.sh`) and the web dashboard are now both functional. The bash version remains the reference implementation; the web port lives in `apps/api` + `apps/web` and runs in parallel without sharing state with it.

## High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/api  (Express + Kysely + Postgres)                         │
│  ├─ PollerService (singleton background loop, every 20s)        │
│  │   • Finviz v=131 + v=110 → join, post-filter                 │
│  │   • Finviz news_export (batch)                               │
│  │   • Yahoo RSS (per-ticker, parallel)                         │
│  │   • Benzinga delta (cumulative cache, midnight-ET reset)     │
│  │   • Per-ticker volume rolling window for 5-min RVol          │
│  │   → persists every cycle + new news to Postgres              │
│  │   → broadcasts deltas to SSE subscribers                     │
│  └─ Routes: /api/auth, /api/screener, /api/news, /api/prefs     │
└─────────────────────────────────────────────────────────────────┘
                                ↓ SSE (live) + REST (history/prefs)
┌─────────────────────────────────────────────────────────────────┐
│ apps/web  (React + Antd + Vite + react-resizable-panels)        │
│  Resizable layout (sizes persist in localStorage):              │
│   ┌────────────────┬─────────────────┐                          │
│   │ Screener live  │ Chart 1m        │                          │
│   │  (SSE table)   │  (TradingView)  │                          │
│   ├────────────────┼─────────────────┤                          │
│   │ Quote Details  │ Chart 5m        │                          │
│   │  Details/Hist  │                 │                          │
│   ├────────────────┼─────────────────┤                          │
│   │ News Room      │ Chart 15m / 1h  │                          │
│   └────────────────┴─────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

## What's built

### Backend

| Area | Status | Key files |
|---|---|---|
| Auth (JWT, bcrypt, register/login/me) | ✅ | `apps/api/src/routes/auth.ts`, `services/auth.ts` |
| PollerService — port of bash poll loop | ✅ | `apps/api/src/services/poller.ts` |
| Finviz screener client (v=131 ⨝ v=110) | ✅ | `apps/api/src/services/finviz.ts` |
| Yahoo RSS news client | ✅ | `apps/api/src/services/yahoo.ts` |
| Benzinga delta news client | ✅ | `apps/api/src/services/benzinga.ts` |
| SSE broadcaster | ✅ | `apps/api/src/services/sse.ts` |
| Persistence (cycles, results, news) | ✅ | `db/migrations/*.sql` |
| Live filter editing via REST | ✅ | `PATCH /api/screener/config` |
| Per-user filter presets | ⚠️ schema only, no UI | `user_filter_presets` table |
| Per-user chart layout persistence | ⚠️ schema only, no API hookup | `user_panel_layout` table |

### Frontend

| Area | Status | Notes |
|---|---|---|
| Auth pages (login/register) | ✅ | |
| Multi-panel resizable dashboard | ✅ | `react-resizable-panels`, sizes via localStorage |
| Screener live table (SSE) | ✅ | NEW/ACC/UP/NEWS badges, 🔥/🚨 markers |
| Quote Details — Stats + Sentiment side-by-side | ✅ | 3-column grids, color-coded per CLAUDE.md bands |
| Quote Details — History tab | ✅ | Per-ticker historical screener appearances with `(N in Tsec)` streak label |
| News Room filtered to current screener tickers | ✅ | |
| 4 TradingView chart widgets, 2×2 grid | ✅ | Free embed; intervals saved per slot |
| Hardcoded indicators on 1m chart | ✅ | VWAP (orange, thick) + MACD + EMA(20). Other intervals: Volume only |
| Extended hours on charts | ✅ | `extended_hours: true` + `session: 'extended'` passed to TV widget |
| Per-slot fullscreen toggle | ✅ | |
| "Open in TradingView" click-out | ✅ | For seconds intervals + drawings (uses your TV Premium account) |
| Audio + browser-notification alerts | ✅ | Web Audio API beeps; "Arm alerts" button unlocks AudioContext + permissions |
| Auto-select first ticker on dashboard load | ✅ | Stops once user clicks anything |
| Filter editor dialog | ✅ | Price range, min change %, min RVol, max float, top N |
| Loading overlay during chart rebuild | ✅ | Prevents the white-flash on TV iframe remount |

### Specific metrics on the screener

| Column | Source | Notes |
|---|---|---|
| Status | computed (NEW/ACC/UP/NEWS) | Mirrors bash logic, cross-cycle state in poller memory |
| Chg % | Finviz v=131 col 13 | `accel_delta` from prev cycle in tooltip |
| Float | Finviz v=131 col 4 | In millions, post-filter ceiling enforced |
| Price | Finviz v=131 col 12 | |
| Volume | Finviz v=131 col 14 | Raw count |
| **RVol Day** | volume / avg_volume | Highlights green ≥2×, yellow ≥5× |
| **RVol 5m %** | (5min vol diff) / (avg_volume / 78) × 100 | Computed via in-memory rolling window |
| MCap | Finviz v=131 col 2 | |
| Country | Finviz v=110 col 5 | |

### Quote Details — Sentiment section

All from Finviz v=131 (no extra HTTP calls), color-coded per bands documented in CLAUDE.md:

| Field | Source col | Color rule |
|---|---|---|
| Short Float | 9 | <5% default · 5–15 yellow · 15–25 orange · ≥25 red |
| Short Ratio | 10 | uncolored (informational) |
| Insider Trans | 6 | >0 green · -3..0 default · -3..-10 orange · <-10 red |
| Insider Own | 5 | uncolored |
| Inst Trans | 8 | >+5 green · <-5 red · between default |
| Inst Own | 7 | uncolored |
| Shs Out | 3 | uncolored |

## Key decisions & trade-offs

### TradingView free embed widget — what we live with

We use the public `tv.js` "Advanced Real-Time Chart" widget. Critical limitations driving everything chart-related:

- **One-way config only** — we pass `symbol/interval/studies/studies_overrides` at init; we cannot read what the user added in the native UI, nor receive any state callbacks. So in-chart changes (added indicators, drawings, zoom) don't survive a refresh. Workaround: hardcoded indicator loadout per interval + click-out to tradingview.com for serious work.
- **studies_overrides for style is unreliable** — color and `linewidth` work *sometimes*. Input parameters (lengths, periods) work consistently.
- **Multiple instances of the same study** are tricky — `studies_overrides` applies globally per study type. Indexed-path syntax (`...length.1`) sometimes works but isn't formally documented for the free embed.
- **Auth doesn't extend to embeds** — your TradingView Premium account doesn't apply to the iframe widget. Real-time data inside the embed comes from TV's general feeds (CBOE BZX is free, partial coverage). For real-time everywhere on tradingview.com, the $9.95/mo US Stock Markets data add-on lights up the click-out path but doesn't help the embed.

**Why we didn't switch to TradingView Advanced Charts library**: TV restricted it to companies for "use in public web projects" — confirmed via their FAQ. Personal use is explicitly disallowed. The remaining option for full chart control is **Lightweight Charts** (Apache 2.0) but it requires bringing your own data feed.

### Single-instance poller

`PollerService` is a singleton in API process memory. State that lives in memory:

- `prevChange` — `ticker → last seen change%` for delta classification
- `bzHeadlineCache` — Benzinga headlines, cleared at midnight ET
- `bzWatermark` — newest seen Benzinga `updated` timestamp
- `volHistory` — per-ticker rolling samples for 5-min RVol

Implications:

- **All connected users see the same screener result** — filter changes via the dialog affect everyone. Fine for personal/team use; would need rework for multi-tenant.
- **Restart resets cross-cycle state** — every ticker is briefly classified `NEW` again, RVol 5m is null until 5 minutes of samples accrue.
- **Horizontal scaling is not possible without moving state** to Redis or DB.

### Postgres bigint/numeric type parsers

`pg` returns `numeric` and `bigint` columns as strings by default to preserve precision. We override with `pg.types.setTypeParser` to coerce to JS numbers — fine because price/volume/relvol values fit comfortably in JS number precision. Documented in `apps/api/src/db/index.ts`.

### Finviz's avg_volume scale gotcha

Finviz returns `Average Volume` in `v=131` exports as an implicit-K (thousands) decimal — e.g. `"42.99"` means 42,990 shares. Volume in the same row is raw count. Took two iterations and a curl test to figure this out. The `numScaled` parser in `apps/api/src/services/finviz.ts` documents this; future fields with similar quirks may need their own handling.

### Cycle-driven SSE replays + alert dedup

When a client connects, the server immediately pushes the last cached cycle so the dashboard doesn't sit empty for up to 20s. The frontend's `useScreenerAlerts` hook dedupes by `cycle_id` and skips the very first payload — otherwise reconnects would replay the audio for stale catalysts.

### Why the dashboard auto-selects the top ticker on load

Without it, the chart pane and Quote Details start blank, which looks broken before the user understands the click-to-load model. Auto-select stops firing once the user makes any explicit choice, so it never fights with user intent.

## Roadmap

Ranked roughly by effort vs. value. Pick one when you're ready.

### Near-term (small wins)

1. **Phase 2 sentiment fields from Finviz v=171** — RSI, Beta, ATR, SMAs, 52W H/L. One extra parallel HTTP call per cycle, ~30 minutes of work. Adds the "Technical" section to Quote Details, unlocks sortable RSI in the screener. Already discussed; deferred until Phase 1 sentiment fields prove useful.
2. **Filter presets UI** — `user_filter_presets` table already exists. Wire the dialog to save/load named presets per user.
3. **Audio/notification preferences** — let users mute or pick different sounds per event class. UI for opt-in/out per event type.
4. **History tab — search & date range** — currently shows last 100 rows for a ticker. Add a date-range picker and filter.
5. **More columns** in the screener: SMA20, RSI (after Phase 2). Sortable.

### Medium-term (multi-day work)

6. **Per-user persistence of panel layout** — currently `react-resizable-panels` autoSaveId stores in localStorage. Wire to `/api/prefs/layout` so layout follows you across browsers.
7. **Per-user filter scoping** — the poller currently runs one global filter. Refactor so each connected user can run their own filter subscription. Trade-off: multiplies HTTP load to Finviz; need to think about rate-limit headroom.
8. **Cycle history view** — UI to browse past cycles (we already persist them). "What was the screener showing at 9:35 ET this morning?" — useful for backtesting alert efficacy.
9. **News retrospective query** — "Which news source most often preceded ≥30% intraday moves?" — this is the analytical use case the persistence schema was designed for. Build a query view.

### Larger projects

10. **Massive Stocks Starter ($29/mo) + Lightweight Charts migration** — replaces the TradingView free embed with a self-rendered chart. Buys us:
    - True 10s/30s candles (15-min delayed data)
    - Full state persistence (drawings, indicators, layouts, zoom) via a `save_load_adapter` against our DB
    - Free of TV's restrictive licensing
    
    Costs ~3-4 days work + $29/mo data. Drawings UI is the long pole; basic line/rectangle primitives ship quickly, full drawing toolbar takes ~1 week.
    
11. **Massive Stocks Advanced ($199/mo) for real-time** — only meaningful upgrade path if Starter's 15-minute delay becomes painful for active trading. Combine with #10.
12. **NASDAQ trade-halts RSS as 4th news source** — surfaces circuit-breaker halt notices (BZ-Wire content) for free. Use a 🛑 marker.
13. **Article URLs in news suffix** — clickable headlines next to the screener row. The bash script's roadmap mentions this too.

## Known limitations / caveats

- **Filter editor changes are global**, not per-user, until item #7 above lands.
- **Filter changes don't persist** across API restarts — config lives in poller memory only.
- **Old DB rows have null sentiment/volume fields** from pre-migration cycles. They'll show `—` in History; new rows are correct.
- **Existing pre-fix `rel_volume` rows** in the DB are off by 1000× (the K-vs-M parsing bug). New rows are correct. Optional cleanup: `update screener_results set rel_volume = null, avg_volume = null where polled_at < '<bug_fix_timestamp>';`
- **Pre-market hours often return zero rows** — Finviz's `change >=20%` filter is rarely met before market open. Normal.
- **The ChartGrid `studies` JSONB column** is unused legacy from the indicator-picker iteration. Harmless. Drop it later if it bothers you.
- **The Benzinga API tier excludes "Benzinga Wire" auto-content** (LULD halt notices, Movers feed). Mitigation in roadmap item #12.
- **Yahoo RSS coverage for micro-caps is sparse**. The 3-source stack mitigates by treating each source as additive.

## Operational notes

### When you need to restart

| Change to | Restart? |
|---|---|
| Migration applied | No (next poll picks it up — ALTER TABLE is online) |
| Code in `apps/api/src/**` | `tsx watch` auto-reloads. If you bypassed it, restart manually. |
| Code in `apps/web/src/**` | Vite HMR — usually instant. Hard refresh if state gets weird. |
| `.env` change | Manual API restart |

### Common diagnostics

```bash
# Confirm poller is alive and what filter it's running
curl -s http://localhost:3001/health | jq .poller

# Direct Finviz spot-check (see avg_volume format etc.)
source .env && curl -sL -A "Mozilla/5.0" \
  "https://elite.finviz.com/export?v=131&t=AAPL&auth=$FINVIZ_API_TOKEN" | head -2

# Recent cycles
source .env && psql "$DATABASE_URL" -c \
  "select polled_at, row_count from screener_cycles order by polled_at desc limit 10;"

# Check news ingest is working
source .env && psql "$DATABASE_URL" -c \
  "select source, count(*) from news_articles where fetched_at > now() - interval '1 hour' group by source;"
```

### When migrations are needed

The poller's column writes match `apps/api/src/db/types.ts`. If you bump those types without applying a matching migration, you'll see `column "X" does not exist` errors in the poll cycle log. Always run `dbmate up` after pulling code that adds columns.
