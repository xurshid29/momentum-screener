# Momentum Screener

A real-time low-float momentum scanner with a multi-panel web dashboard. Polls Finviz Elite every 20s, enriches with Yahoo Finance RSS, Benzinga, SEC EDGAR filings, and Nasdaq trade halts, scores each catalyst, and pushes live updates to a browser dashboard with embedded TradingView charts.

This project began as a single bash script (`screener-poll_breakout.sh`) and is being ported to a multi-user web app while keeping the bash version available for terminal use.

## Features

- **Live screener** — top low-float momentum runners (filter customizable in UI), updated every 20s via Server-Sent Events; screens the pre-market, regular, and after-hours sessions
- **Ignition screener** — a second, volume-led screen that catches low-float names in the *first minutes* of a move; ranked by a composite runner-score, shown in an always-visible sidebar, persisted for backtesting, and pushed to Telegram
- **Multi-source catalysts** — Finviz + Yahoo RSS + Benzinga news, plus **SEC EDGAR filings** (offerings/dilution, 8-Ks, M&A, 13D/G stakes) and **Nasdaq trade halts** — deduped & merged, primary sources outranking aggregators
- **Catalyst scoring** — every headline is classified by a rule-based engine (and optionally refined by an LLM): impact score, direction, urgency, and risk flags drive the 🔥 badges; click a badge for a modal with the verdict + that ticker's news
- **Visual + audio alerts** — 🔥 (today catalyst), 🚨 (fresh news this cycle), `NEW` / `ACC` / `UP` row markers; browser notification + sound on actionable events; optional **Telegram push alerts** — server-side, so they reach you 24/5 even with no browser open
- **TradingView charts** — embedded Advanced Real-Time widgets, an adjustable `0–4` grid (charts can be hidden entirely), intervals `1m / 5m / 15m / 1h` (per-chart, persisted per user); click "Open in TradingView" to use seconds intervals (`1S / 10S / 30S`) on tradingview.com with your Premium account
- **Persistence** — every poll cycle, every news article, and every user pref written to Postgres. Enables retrospective analysis: *which news sources/types preceded the biggest moves?*
- **Multi-user** — JWT auth (public sign-up gated by `REGISTRATION_OPEN`), per-user filter presets, per-user chart settings

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/api  (Express + Kysely + Postgres)                         │
│  ├─ PollerService (singleton background loop)                   │
│  │    Finviz v=131 + v=110 → join                               │
│  │    + Finviz news_export (batch)                              │
│  │    + Yahoo RSS (per-ticker, parallel)                        │
│  │    + Benzinga / SEC EDGAR / Nasdaq halts                     │
│  │    → classify catalysts → write screener_cycles + news       │
│  │    → broadcast to SSE subscribers                            │
│  └─ Routes: /api/auth, /api/screener, /api/news, /api/prefs     │
└─────────────────────────────────────────────────────────────────┘
                                ↓ SSE (live) + REST (history/prefs)
┌─────────────────────────────────────────────────────────────────┐
│ apps/web  (React + Antd + Vite + react-resizable-panels)        │
│  Left half (3 panels stacked):                                  │
│    1. Screener (live table)                                     │
│    2. Selected stock + per-ticker news                          │
│    3. News room (all-tickers feed)                              │
│  Right half (adjustable 0–4 grid):                              │
│    TradingView Advanced Real-Time Chart widgets                 │
└─────────────────────────────────────────────────────────────────┘
```

The bash script `screener-poll_breakout.sh` continues to work standalone — it does not share state with the web service.

## Quick Start

### Prerequisites

- Node.js 25+
- Docker (for Postgres)
- dbmate (`brew install dbmate`)
- Finviz Elite; optionally Benzinga (free tier OK) and a TradingView Premium subscription

### Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Fill in at least FINVIZ_API_TOKEN and JWT_SECRET

# 3. Database
docker compose up -d
dbmate up

# 4. Dev servers
npm run dev:api   # http://localhost:3001
npm run dev:web   # http://localhost:5173
```

With `REGISTRATION_OPEN=true` (the `.env.example` default), register a user at `/login` — then the dashboard loads. The poller starts automatically when the API boots and runs in the background; open the browser to see live cycles.

## Project structure

```
pnldash/
├── apps/
│   ├── api/                          # Express backend
│   │   └── src/
│   │       ├── index.ts              # Entry — mounts routes, starts the poller
│   │       ├── db/                   # Kysely setup + Database type definitions
│   │       ├── middleware/           # JWT auth middleware
│   │       ├── routes/               # auth.ts, screener.ts, news.ts, prefs.ts
│   │       └── services/
│   │           ├── poller.ts         # The 20s polling loop (TS port of bash)
│   │           ├── finviz.ts         # Finviz screener + news client
│   │           ├── yahoo.ts          # Yahoo RSS news client
│   │           ├── benzinga.ts       # Benzinga delta news client
│   │           ├── edgar.ts          # SEC EDGAR filings client
│   │           ├── halts.ts          # Nasdaq trade-halt feed client
│   │           ├── universe.ts       # Broad ticker universe (Universe News)
│   │           ├── catalyst-rules.ts # Rule-based catalyst classifier
│   │           ├── catalyst-openai.ts# Optional LLM catalyst refinement
│   │           ├── classify-article.ts # On-demand single-article classifier
│   │           ├── auth.ts           # JWT + bcrypt user service
│   │           └── sse.ts            # SSE broadcaster
│   └── web/                          # React frontend
│       └── src/
│           ├── pages/                # DashboardPage, LoginPage
│           ├── context/              # Auth / Selection / Layout providers
│           ├── hooks/                # SSE stream, alerts, hidden tickers
│           └── components/
│               ├── screener/         # Live table + catalyst news modal
│               ├── charts/           # Chart grid + TradingView widget
│               ├── news/             # News room + per-ticker news list
│               ├── auth/             # Login form
│               ├── layout/           # App header / shell
│               ├── dashboard/        # Dashboard-level pieces
│               └── common/           # Shared bits (FireBadge, TickerLink)
├── db/migrations/                    # SQL via dbmate
├── deploy/                           # Dockerfiles + nginx config (prod)
├── docs/                             # Reference docs (see Documentation below)
├── docker-compose.yml                # Local Postgres
├── docker-compose.prod.yml           # Prod stack (api/web/nginx/postgres/certbot)
└── screener-poll_breakout.sh         # Original CLI scanner (+ 1min / 2min variants)
```

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create user (gated by `REGISTRATION_OPEN`) |
| POST | `/api/auth/login` | Get JWT |
| GET | `/api/auth/me` | Current user |
| GET | `/api/auth/config` | Public — whether registration is open |
| GET | `/api/screener/latest` | Most recent cycle's rows |
| GET | `/api/screener/cycles` | Paginated cycle history |
| GET | `/api/screener/history` | Per-ticker row history |
| GET | `/api/screener/cycles/:id/results` | One cycle's rows |
| PATCH | `/api/screener/config` | Update the live poller filter/config |
| GET | `/api/screener/stream` | **SSE** — live cycle deltas |
| GET | `/api/news?ticker=X` | News history for a ticker |
| GET | `/api/news/feed` | All-tickers news feed |
| POST | `/api/news/:id/classify` | On-demand AI catalyst classification |
| GET/POST/DELETE | `/api/prefs/filters` | Per-user filter presets |
| GET/PUT | `/api/prefs/charts` | Per-user chart slot prefs |
| GET/POST/DELETE | `/api/prefs/hidden-tickers` | Per-user hidden tickers (current ET day) |
| GET/PUT | `/api/prefs/layout` | Panel layout JSON (incl. chart count) |

`/api/screener`, `/api/news`, and `/api/prefs` endpoints require an `Authorization: Bearer <jwt>` header (the SSE stream takes the token as a query param, since `EventSource` can't set headers).

## Environment variables

See `.env.example`.

- **Required:** `DATABASE_URL`, `FINVIZ_API_TOKEN`, `JWT_SECRET`
- **Optional:**
  - `BENZINGA_API_TOKEN` — Benzinga news (without it, only Finviz + Yahoo + SEC + halts)
  - `SEC_EDGAR_USER_AGENT` — SEC requires a descriptive UA with a contact address; a default is used if unset
  - `OPENAI_API_KEY` — enables LLM refinement of catalyst scores
  - `REGISTRATION_OPEN` — public sign-up; closed unless set to exactly `true`
  - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — enable Telegram push alerts
  - `JWT_EXPIRES_IN` — token lifetime (default `7d`)

## Documentation

- [CLAUDE.md](CLAUDE.md) — project conventions for Claude Code sessions
- [docs/web-dashboard.md](docs/web-dashboard.md) — what's built, key decisions, roadmap
- [docs/catching-runners.md](docs/catching-runners.md) — low-float runner detection strategy & roadmap
- [docs/ignition-screener-spec.md](docs/ignition-screener-spec.md) — Phase 2 implementation spec
- [docs/screener-poll-breakout.md](docs/screener-poll-breakout.md) — bash scanner reference
- [docs/finviz-api.md](docs/finviz-api.md) — Finviz API quick reference
- [docs/smart-money-concepts.md](docs/smart-money-concepts.md) — Smart Money Concepts reference

## License

MIT
