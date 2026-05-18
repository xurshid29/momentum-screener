# Momentum Screener — Web Dashboard

Status as of 2026-05-18. The bash scanner (`screener-poll_breakout.sh`) and the web dashboard are both functional; the bash version remains the reference implementation. The web port lives in `apps/api` + `apps/web` and runs in parallel without sharing state with it.

See **Recent additions** for what shipped lately and **Remaining work** for what's next. The low-float runner-detection strategy + roadmap lives in [`catching-runners.md`](catching-runners.md); the Ignition screener design in [`ignition-screener-spec.md`](ignition-screener-spec.md).

## High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/api  (Express + Kysely + Postgres)                         │
│  ├─ PollerService (singleton background loop, every 20s)        │
│  │   • Two Finviz screens — Momentum + Ignition (volume-led)    │
│  │   • Finviz news_export · Yahoo RSS · Benzinga delta          │
│  │   • SEC EDGAR filings · Nasdaq trade halts                   │
│  │   • Catalyst classifier (rules + optional LLM)               │
│  │   • Per-ticker 5-min RVol rolling window                     │
│  │   → persists cycles / results / ignition_results / news      │
│  │   → broadcasts deltas via SSE · pushes Telegram alerts       │
│  └─ Routes: /api/auth, /api/screener, /api/news, /api/prefs     │
└─────────────────────────────────────────────────────────────────┘
                                ↓ SSE (live) + REST (history/prefs)
┌─────────────────────────────────────────────────────────────────┐
│ apps/web  (React + Antd + Vite + react-resizable-panels)        │
│  Ignition sidebar │ Screener · Quote Details · News Room │ 0–4  │
│  (left edge)      │ (3 stacked panels)                  │ charts│
└─────────────────────────────────────────────────────────────────┘
```

## What's built

### Backend

| Area | Status | Key files |
|---|---|---|
| Auth (JWT, bcrypt, register/login/me) | ✅ | `routes/auth.ts`, `services/auth.ts` |
| PollerService — two-screen 20s loop | ✅ | `services/poller.ts` |
| Finviz screener client (v=131 ⨝ v=110) | ✅ | `services/finviz.ts` |
| Yahoo RSS / Benzinga delta news clients | ✅ | `services/yahoo.ts`, `benzinga.ts` |
| SEC EDGAR filings client | ✅ | `services/edgar.ts` |
| Nasdaq trade-halts client | ✅ | `services/halts.ts` |
| Catalyst classifier (rules + optional LLM) | ✅ | `catalyst-rules.ts`, `catalyst-openai.ts`, `classify-article.ts` |
| Ignition screener + runner-score | ✅ | `poller.ts`, `runner-score.ts` |
| SEC shelf/dilution lookup (Phase 3) | ✅ | `services/shelf.ts` |
| Telegram push alerts | ✅ | `services/telegram.ts` |
| SSE broadcaster | ✅ | `services/sse.ts` |
| Persistence (cycles, results, ignition, news) | ✅ | `db/migrations/*.sql` |
| After-hours session screening | ✅ | `poller.ts` (`session` label) |
| Live filter editing / config persistence | ✅ | `PATCH /api/screener/config`, `screener_settings` |
| Per-user filter presets | ⚠️ API exists, no save-preset UI | `user_filter_presets`, `/api/prefs/filters` |

### Frontend

| Area | Status | Notes |
|---|---|---|
| Auth pages; registration gated by `REGISTRATION_OPEN` | ✅ | Register tab hidden when sign-up is closed |
| Multi-panel resizable dashboard | ✅ | `react-resizable-panels`, sizes via localStorage |
| Screener live table (SSE) | ✅ | NEW/ACC/UP/NEWS badges, 🔥/🚨 markers |
| Ignition sidebar | ✅ | Always-visible ranked runner-score feed (left edge) |
| Catalyst news modal | ✅ | Click a row's 🔥 badge → catalyst verdict + ticker news |
| Quote Details — Stats + Sentiment + History | ✅ | Color-coded per CLAUDE.md bands; per-ticker history tab |
| News Room (current screener tickers) | ✅ | |
| TradingView chart grid — adjustable 0–4 | ✅ | At `0` the pane unmounts (iframes torn down) |
| Hardcoded indicators per interval | ✅ | VWAP + MACD + EMA(20) on 1m; Volume elsewhere |
| Audio + browser-notification alerts | ✅ | "Arm alerts" unlocks AudioContext + permissions |
| Filter editor dialog | ✅ | Price range, min change %, min RVol, max float, top N |

## Recent additions (since the 2026-05-04 snapshot)

- **EDGAR shelf/dilution flag (Phase 3)** — a per-ticker SEC submissions lookup (`data.sec.gov/submissions`) over a 12-month window, grading each screener name's dilution risk `shelf` / `effective` / `active`. The "pump-and-dilute kill-switch": surfaced as a tiered warning marker on Momentum + Ignition rows, a line in Telegram alerts, and a penalty in the runner-score. Catches a shelf loaded *before* the pump — which the `getcurrent` firehose (only a few hours deep) misses. A standalone background service (`shelf.ts`), rate-limited well under SEC's fair-access limit.
- **SEC EDGAR filings** as a news source — the `getcurrent` firehose matched to screener tickers via the CIK map; surfaces offerings/dilution (424B*, S-1/S-3), 8-Ks, M&A, 13D/G stakes.
- **Nasdaq trade halts** as a news source — the market-wide halt feed; a T1 ("news pending") halt scores as a major catalyst.
- **Catalyst classification** — every headline scored (impact / direction / urgency / risk flags) by a rule engine, optionally refined by an LLM; drives the 🔥 badges.
- **Catalyst news modal** — clicking a row's fire badge opens the catalyst verdict + that ticker's news.
- **Hideable chart pane** — the Charts control accepts `0`; the chart pane unmounts entirely.
- **Telegram push alerts** — server-side, 24/5, independent of any open browser. Fires for the Momentum screener (fresh news + strong/major catalyst) and the Ignition screener (runner-score ≥ 58 **or** a bullish strong/major catalyst). All triggers are direction-aware — a bearish catalyst or a crash never alerts.
- **Ignition screener (Phase 2)** — a second, volume-led Finviz screen run each cycle; a composite, **direction-aware** runner-score (a bearish catalyst or a down-move sinks the score, so crashes don't rank as ignitions); always-visible sidebar; persisted to `ignition_results` for backtesting.
- **Registration gating** — public sign-up closed unless `REGISTRATION_OPEN=true`.
- **Deploy hardening** — CI restarts nginx after rollout (kills stale-upstream 502s) and verifies migrations against the app database after `dbmate up`.

## Key decisions & trade-offs

### TradingView free embed widget

We use the public `tv.js` "Advanced Real-Time Chart" widget. Limitations driving everything chart-related:

- **One-way config only** — we pass `symbol/interval/studies` at init; we can't read user changes or receive state callbacks, so in-chart edits don't survive a refresh. Workaround: hardcoded indicators + click-out to tradingview.com.
- **`studies_overrides` for style is unreliable** — colors/`linewidth` work sometimes; input params (lengths) work consistently.
- **Auth doesn't extend to embeds** — a TV Premium account doesn't apply to the iframe.

TradingView restricts the Advanced Charts library to companies (personal use disallowed). The real alternative is **Lightweight Charts** (Apache 2.0) — see Remaining work.

### Single-instance poller

`PollerService` is a singleton holding cross-cycle state in API-process memory: `prevChange`, `volHistory` (5-min RVol), `bzHeadlineCache`, the Benzinga/SEC/halt watermarks, `classificationCache`, and the Telegram alert-dedup sets. Implications:

- **All users see the same screener** — the filter is global. Fine for personal/team use.
- **Restart resets cross-cycle state** — tickers briefly re-classify `NEW`, 5-min RVol is null until samples accrue.
- **No horizontal scaling** without moving state to Redis/DB.

### Finviz `avg_volume` scale gotcha

Finviz's `v=131` `Average Volume` is an implicit-K decimal (`"42.99"` = 42,990 shares) while `Volume` is a raw count. The `numScaled` parser in `services/finviz.ts` documents this. Also: never put `Float` in the Finviz filter string — Finviz drops null-float rows; the float ceiling is post-filtered in code.

### Cycle-driven SSE replays + alert dedup

On connect, the server pushes the last cached cycle so the dashboard isn't empty for ~20s. `useScreenerAlerts` dedupes by `cycle_id` and skips the first payload so reconnects don't replay stale audio. Telegram alerts dedupe per article URL (news) / per ticker per ET day (ignition).

## Remaining work / roadmap

### Runner-detection roadmap — see [`catching-runners.md`](catching-runners.md)

- **Phase 3 — refinements.** Partially shipped.
  - ✅ **EDGAR shelf/dilution flag** — a 12-month per-ticker SEC submissions lookback grades each name `shelf` / `effective` / `active`; surfaced on rows + alerts and penalised in the runner-score (`services/shelf.ts`).
  - ⏸️ **Paused** — backfill ~12 months of Finviz daily bars per float-qualified ticker → a `historical_runs` count (repeat-runner prior). Needed because the live DB only holds weeks of history.
- **PR-wire news source** — GlobeNewswire / ACCESSWIRE firehose matched against the live screener universe. The deliberately-deferred follow-up to EDGAR + halts.

### Ignition screener — deferred / tuning

- Ignition filter is a code constant — make it user-editable, like the Momentum filter dialog.
- No backtest UI — tuning the runner-score is ad-hoc psql for now; a query view/endpoint would close the loop.
- **Retune from data** — the alert threshold (currently 58) and the runner-score weights are first-pass estimates. After several sessions of `ignition_results`, retune both against the actual score-vs-outcome distribution.

### Dashboard / smaller items

- **Filter presets UI** — the table + `/api/prefs/filters` exist; wire a save/load-named-presets UI.
- **Cycle history / news retrospective view** — browse persisted cycles; "which source/type preceded the biggest moves."
- **Technical fields (Finviz v=171)** — RSI / Beta / ATR / SMAs; adds a Technical section + sortable RSI.
- **Per-user panel layout persistence** — currently localStorage; wire fully to `/api/prefs/layout`.
- **Per-user filter scoping** — the poller runs one global filter; per-user subscriptions need Finviz rate-limit headroom.

### Infrastructure

- **GitHub Actions Node 20 deprecation** — `actions/checkout@v4` et al. run on Node 20; bump the action versions before GitHub forces Node 24 (mid-2026).
- **Lightweight Charts migration** (large, ~3–4 days + a data add-on) — replaces the TradingView free embed with a self-rendered chart: true seconds candles, full state persistence (drawings/indicators/zoom), free of TV's licensing.

## Known limitations / caveats

- **The filter is global**, not per-user.
- **Old DB rows** from pre-migration cycles show `—` for fields added later; new rows are correct.
- **Pre-market often returns zero Momentum rows** — Finviz's `change ≥ 20%` filter is rarely met before the open. Normal. (The Ignition screen, being volume-led, surfaces names earlier.)
- **Yahoo RSS coverage for micro-caps is sparse** — the multi-source stack mitigates by treating each source as additive.
- **Deploy `.env` is manual** — the CI deploy ships code + migrations but never `.env`; new env vars must be added to the droplet by hand.

## Operational notes

### When you need to restart

| Change to | Restart? |
|---|---|
| Migration applied | No — next poll picks it up |
| `apps/api/src/**` (dev) | `tsx watch` auto-reloads |
| `apps/web/src/**` (dev) | Vite HMR |
| `.env` change | Manual API restart / `docker compose up -d` |

### Common diagnostics

```bash
# Recent cycles
source .env && psql "$DATABASE_URL" -c \
  "select polled_at, row_count from screener_cycles order by polled_at desc limit 10;"

# Ignition candidates by runner-score
source .env && psql "$DATABASE_URL" -c \
  "select ticker, runner_score from ignition_results order by created_at desc limit 25;"

# News ingest by source
source .env && psql "$DATABASE_URL" -c \
  "select source, count(*) from news_articles where fetched_at > now() - interval '1 hour' group by source;"
```

### Migrations

The poller's column writes match `apps/api/src/db/types.ts`. Bumping those types without a matching migration causes `column "X" does not exist` errors in the poll cycle. The CI deploy runs `dbmate up` and verifies the schema against the app database; if it reports a schema behind, apply manually on the droplet with `dbmate up`.
