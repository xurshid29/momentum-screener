# Momentum Screener

A real-time low-float momentum scanner with a multi-panel web dashboard. Polls Finviz Elite every 20s, enriches with Yahoo Finance RSS + Benzinga news, and pushes live updates to a browser dashboard with embedded TradingView charts.

This project began as a single bash script (`screener-poll_breakout.sh`) and is being ported to a multi-user web app while keeping the bash version available for terminal use.

## Features

- **Live screener** — top low-float momentum runners (filter customizable in UI), updated every 20s via Server-Sent Events
- **Multi-source news** — Finviz news + Yahoo Finance RSS + Benzinga delta API, deduped & merged with the freshest source winning
- **Visual + audio alerts** — 🔥 (today catalyst), 🚨 (fresh news this cycle), `NEW` / `ACC` / `UP` row markers; browser notification + sound on actionable events
- **4 TradingView charts** — embedded Advanced Real-Time widgets in a 2×2 grid, intervals `1m / 5m / 15m / 1h` (per-chart, persisted per user); click "Open in TradingView" to use seconds intervals (`1S / 10S / 30S`) on tradingview.com with your Premium account
- **Persistence** — every poll cycle, every news article, and every user pref written to Postgres. Enables retrospective analysis: *which news sources/types preceded the biggest moves?*
- **Multi-user** — JWT auth, per-user filter presets, per-user chart settings

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/api  (Express + Kysely + Postgres)                         │
│  ├─ PollerService (singleton background loop)                   │
│  │    Finviz v=131 + v=110 → join                               │
│  │    + Finviz news_export (batch)                              │
│  │    + Yahoo RSS (per-ticker, parallel)                        │
│  │    + Benzinga delta (cumulative cache)                       │
│  │    → write screener_cycles + news_articles                   │
│  │    → broadcast to SSE subscribers                            │
│  └─ Routes: /api/auth, /api/screener, /api/news, /api/prefs     │
└─────────────────────────────────────────────────────────────────┘
                                ↓ SSE (live) + REST (history/prefs)
┌─────────────────────────────────────────────────────────────────┐
│ apps/web  (React + Antd + Vite + react-grid-layout)             │
│  Left half (3 panels stacked):                                  │
│    1. Screener (live table)                                     │
│    2. Selected stock + per-ticker news                          │
│    3. News room (all-tickers feed)                              │
│  Right half (2×2 grid):                                         │
│    4 TradingView Advanced Real-Time Chart widgets               │
└─────────────────────────────────────────────────────────────────┘
```

The bash script `screener-poll_breakout.sh` continues to work standalone — it does not share state with the web service.

## Quick Start

### Prerequisites

- Node.js 25+
- Docker (for Postgres)
- dbmate (`brew install dbmate`)
- Finviz Elite, Benzinga (free tier OK), TradingView Premium subscription

### Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Fill in FINVIZ_API_TOKEN, BENZINGA_API_TOKEN, JWT_SECRET

# 3. Database
docker compose up -d
dbmate up

# 4. Dev servers
npm run dev:api   # http://localhost:3001
npm run dev:web   # http://localhost:5173
```

Register a user at `/login`, then the dashboard loads. The poller starts automatically when the API boots and runs in the background — open the browser to see live cycles.

## Project structure

```
momentum_screener/
├── apps/
│   ├── api/                      # Express backend
│   │   └── src/
│   │       ├── services/
│   │       │   ├── poller.ts     # The 20s polling loop (TS port of bash)
│   │       │   ├── finviz.ts     # Finviz screener + news client
│   │       │   ├── yahoo.ts      # Yahoo RSS news client
│   │       │   ├── benzinga.ts   # Benzinga delta news client
│   │       │   └── sse.ts        # SSE broadcaster
│   │       └── routes/
│   │           ├── screener.ts
│   │           ├── news.ts
│   │           └── prefs.ts
│   └── web/                      # React frontend
│       └── src/
│           ├── pages/DashboardPage.tsx
│           └── components/
│               ├── screener/     # Live screener table
│               ├── charts/       # 4-chart grid + TradingView widget
│               ├── news/         # News room + per-ticker headlines
│               └── filters/      # Filter preset editor
├── db/migrations/                # SQL via dbmate
├── docs/                         # Reference docs
│   ├── finviz-api.md
│   └── screener-poll-breakout.md # Bash script reference
└── screener-poll_breakout.sh     # Original CLI scanner (still works)
```

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create user |
| POST | `/api/auth/login` | Get JWT |
| GET | `/api/auth/me` | Current user |
| GET | `/api/screener/latest` | Most recent cycle's rows |
| GET | `/api/screener/cycles` | Paginated history |
| GET | `/api/screener/stream` | **SSE** — live cycle deltas |
| GET | `/api/news?ticker=X` | News history for a ticker |
| GET | `/api/news/feed` | All-tickers news feed |
| GET/PUT | `/api/prefs/filters` | Per-user filter presets |
| GET/PUT | `/api/prefs/charts` | Per-user chart slot prefs |
| GET/PUT | `/api/prefs/layout` | Panel layout JSON |

All non-auth endpoints require `Authorization: Bearer <jwt>`.

## Environment variables

See `.env.example`. Required: `DATABASE_URL`, `FINVIZ_API_TOKEN`, `JWT_SECRET`. Optional: `BENZINGA_API_TOKEN` (without it, only Finviz + Yahoo news).

## Documentation

- [CLAUDE.md](CLAUDE.md) — project conventions for Claude Code sessions
- [docs/web-dashboard.md](docs/web-dashboard.md) — what's built, key decisions, roadmap
- [docs/screener-poll-breakout.md](docs/screener-poll-breakout.md) — bash scanner reference
- [docs/finviz-api.md](docs/finviz-api.md) — Finviz API quick reference

## License

MIT
