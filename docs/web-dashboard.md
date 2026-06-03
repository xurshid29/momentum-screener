# Momentum Screener — Web Dashboard

Status as of 2026-05-29 (end of day). The bash scanner (`screener-poll_breakout.sh`) and the web dashboard are both functional; the bash version remains the reference implementation. The web port lives in `apps/api` + `apps/web` and runs in parallel without sharing state with it.

**Snapshot for a continuing session** — the screener has five tabs now (`[Momentum] [Continuation] [Swing] [History] [Outcomes]`), the Ignition sidebar stays always-visible on the left, three Telegram alert paths fire (Momentum / Ignition / Swing / Continuation-dual-signal 🎯), and one cached view (Continuation) refreshes every ~10 min, seeding from **both** screens (`screener_results ∪ ignition_results`) and forward-tracking each name via `daily_bars`. The intended next direction is **tuning from data, not new features** — see `Remaining work / roadmap`. Every Swing-spec step (1–6) and the Continuation/History/dual-signal additions are now shipped.

**Strategy shift (2026-06-02) — read this before building.** The operator's current thinking, which should steer priorities: (1) **Continuation is weak as a *predictor*** — guessing whether a name continues up next session is closer to gambling than edge; keep the tab (zero-cost DB derivative) but don't treat "showed up N days" as a buy signal. (2) **The Momentum screen + catalyst is the higher-value play**: enter when a name *first appears* with a good bullish catalyst, ride it, and **exit when the larger pullback begins** (topping tails, MACD rolling, heavy red volume) — the exit is discretionary chart-reading the screener can only *assist*, not automate. (3) **Catalyst quality is the operator's stated #1 factor.** The **forward outcome tracking** instrument (shipped — see Recent additions + "Reading the outcome data") now exists precisely to *test* these claims with data rather than intuition; the gap going forward is letting it accrue ~2 weeks of go-forward depth, then retuning scores/alerts and possibly building an "exit-assist" + a small outcomes view. Caveat: do not act on the first backfill's numbers — samples are tiny.

See **Recent additions** for what shipped lately and **Remaining work** for what's next. The low-float runner-detection strategy + roadmap lives in [`catching-runners.md`](catching-runners.md); the Ignition screener design in [`ignition-screener-spec.md`](ignition-screener-spec.md); the multi-day Swing screener design in [`swing-screener-spec.md`](swing-screener-spec.md).

## High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/api  (Express + Kysely + Postgres)                         │
│  ├─ PollerService (singleton background loop, every 20s)        │
│  │   • Momentum + Ignition Finviz screens every cycle           │
│  │   • Swing screen on a ~20-min cadence + 16:30 ET post-close  │
│  │   • Finviz news_export · Yahoo RSS · Benzinga delta          │
│  │   • SEC EDGAR filings · Nasdaq trade halts                   │
│  │   • Catalyst classifier (rules + optional LLM)               │
│  │   • Per-ticker 5-min RVol + anchored VWAP rolling state      │
│  │   → persists cycles / results / ignition_results /           │
│  │     swing_results / news                                     │
│  │   → broadcasts deltas via SSE · pushes Telegram alerts       │
│  ├─ DailyBarsService — Finviz quote_export backfill + nightly   │
│  │   refresh feeding daily_bars; reservoir for the swing-score  │
│  │   (SMAs, 52w high, ATR, base/breakout detection)             │
│  └─ Routes: /api/auth, /api/screener, /api/news, /api/prefs     │
└─────────────────────────────────────────────────────────────────┘
                                ↓ SSE (live) + REST (history/prefs)
┌─────────────────────────────────────────────────────────────────┐
│ apps/web  (React + Antd + Vite + react-resizable-panels)        │
│  Ignition sidebar │ [Momentum] [Continuation] [Swing]           │
│  (left edge)      │ [History] tabs · Quote Details ·            │
│                   │ News Room (3 stacked panels)        │ 0–4   │
│                                                          │ charts│
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
| Catalyst classifier (rules + optional LLM) | ✅ | `catalyst-rules.ts`, `catalyst-claude.ts`, `classify-article.ts` |
| Ignition screener + runner-score | ✅ | `poller.ts`, `runner-score.ts` |
| Swing screener + swing-score | ✅ | `poller.ts`, `swing-score.ts`, `daily-bar-features.ts` |
| Continuation list (Ignition repeat-aggregation) | ✅ | `services/continuation.ts`, cached & refreshed every ~10 min; news lookup is a 3-day window |
| Dual-signal 🎯 Telegram alert | ✅ | `pushDualSignalAlerts` in `poller.ts` — Continuation ∩ live Ignition with `score ≥ 40`, dedup per ET day |
| History-by-day endpoint | ✅ | `GET /api/screener/history-by-day` — per-(ticker, session) aggregation of `ignition_results` or `screener_results` for a chosen ET date, with the day's top catalyst classification left-joined |
| Daily-bar backfill service (Phase 3b) | ✅ | `services/daily-bars.ts`, Finviz `quote_export` |
| SEC shelf/dilution lookup (Phase 3) | ✅ | `services/shelf.ts` |
| Telegram push alerts (Momentum / Ignition / Swing) | ✅ | `services/telegram.ts`, `pushSwingAlerts` in `poller.ts` |
| Telegram bot — `/swing`, `/ignition`, `/momentum`, `/ticker` … | ✅ | `services/telegram-bot.ts` |
| SSE broadcaster | ✅ | `services/sse.ts` |
| Persistence (cycles, results, ignition, swing, news, daily_bars) | ✅ | `db/migrations/*.sql` |
| After-hours session screening | ✅ | `poller.ts` (`session` label) |
| Live filter editing / config persistence | ✅ | `PATCH /api/screener/config`, `screener_settings` |
| Per-user filter presets | ⚠️ API exists, no save-preset UI | `user_filter_presets`, `/api/prefs/filters` |

### Frontend

| Area | Status | Notes |
|---|---|---|
| Auth pages; registration gated by `REGISTRATION_OPEN` | ✅ | Register tab hidden when sign-up is closed |
| Multi-panel resizable dashboard | ✅ | `react-resizable-panels`, sizes via localStorage |
| Screener live table (SSE) — `[Momentum] [Continuation] [Swing] [History]` tabs | ✅ | Momentum: NEW/ACC/UP/NEWS badges, 🔥/🚨 markers. Continuation: days-in-run (active days, screen + bar-carried) + from-base move + last day-over-day + off-peak liveness (⚡ when hot today) + price range + live M/I/S presence strip, 3-day news lookup. Swing: score + setup flags (B/↑10/↑5/C) + vs 52WH + vs 20-SMA + Vol×Avg. History: DatePicker + Ignition/Momentum toggle, per-(ticker, session) rollup with catalyst column |
| Ignition sidebar — New + Top split | ✅ | Pinned "New" section above the score-ranked feed (left edge); ▲/▼ above/below anchored-VWAP arrow next to chg% |
| Catalyst news modal | ✅ | Click a row's 🔥 badge → catalyst verdict + ticker news |
| Quote Details — Stats + Sentiment + History + Ignition | ✅ | Color-coded per CLAUDE.md bands; per-ticker Momentum history *and* Ignition history sub-tabs |
| News Room (current screener tickers) | ✅ | |
| TradingView chart grid — adjustable 0–4 | ✅ | At `0` the pane unmounts (iframes torn down) |
| Hardcoded indicators per interval | ✅ | VWAP + MACD + EMA(20) on 1m; Volume elsewhere |
| Audio + browser-notification alerts | ✅ | "Arm alerts" unlocks AudioContext + permissions |
| Filter editor dialog | ✅ | Price range, min change %, min RVol, max float, top N |

## Recent additions (since the 2026-05-04 snapshot)

- **Forward outcome tracking (2026-06-02) — the measurement instrument.** The first "tuning from data" piece. Until now the screeners made claims (runner-score 58, bullish catalyst) with no record of whether they were right; tuning was intuition + a few case studies. This records what *actually happened* after every detection so "did the score/catalyst/shelf predict the move?" becomes one SQL query instead of a debate.
  - **What:** new `screener_outcomes` table — one row per `(screen, ticker, et_date)` across **all three screens** (momentum / ignition / swing). Stores the **entry context** at detection (`entry_score`, `first_change_pct`, `peak_change_pct`, catalyst score/direction/urgency/type, `shelf_level`, `sessions`) and the **forward result** off `daily_bars`: `chg_1d/3d/5d`, `peak_5d` (best case), `drawdown_5d` (worst case), `bars_forward` (completeness). Anchor = the **detection-day close** (the honest overnight/multi-day-hold reference); intraday `first/peak_change_pct` kept so "already-extended entries fade" is testable.
  - **How:** `services/outcomes.ts` `computeOutcomes()` runs once/ET day from the poller's post-close window (16:30 ET; `lastOutcomesDate` guard, reset at midnight), fire-and-forget. **Idempotent upsert that revisits each row until `bars_forward >= 5`** — a name detected today gets `chg_1d` tomorrow, `chg_3d` in 3 days, `chg_5d` in 5. A boot-time catch-up (`index.ts`, +60s after start) backfilled the existing ~2 weeks. **Zero new live API calls:** reads `daily_bars`, and `dailyBars.trackUniverse()`s detected tickers so sub-$1 nano-caps that never entered the Swing universe get backfilled (their outcomes populate once bars land). Catalyst direction/urgency/type come from the `news_classifications` join (momentum rows carry no catalyst column; only `impact_score` lives on ignition/swing rows) bucketed to ET publish date.
  - **Dashboard:** an **[Outcomes] tab** (5th Screener tab, shipped 2026-06-02 — see entry below) reads this table. Still no scores/alerts *changed* by it — acting on the numbers waits for ~2 weeks of go-forward depth. An "exit-assist" (pullback signals: topping tails, MACD roll, red-volume spike) on the selected name is a candidate next step, not built.
  - **Status:** `/health` → `outcomes`. Verify/query via the "Reading the outcome data" block under Operational notes.
- **Outcomes / backtest tab (2026-06-02).** A 5th Screener tab `[Momentum] [Continuation] [Swing] [History] [Outcomes]` — the interactive read of `screener_outcomes` (the psql breakdowns turned into UI). Controls: **Group-by** (catalyst direction / urgency / shelf / score bucket / entry-extension / screen) × **Horizon** (1/3/5d) × **Screen** (all/mom/ign/swing); table shows per-bucket **N · avg chg · avg peak (best case) · avg drawdown (worst case) · win-rate**, sortable. `GET /api/screener/outcomes-summary` — one aggregation gated on `bars_forward >= horizon`, server-controlled CASE per group_by (zod enum), coverage header (total/ready). `OutcomesPanel.tsx`. **Anti-overconfidence by design:** N is prominent, thin buckets (<10) dimmed + ⚠, and a banner warns while horizon-ready coverage is shallow (<200) — early numbers are a direction check, not a verdict. Read-only; does not change any score/alert. Verified on prod across all group-bys + 400 on bad params.
- **News windows widened to 7 days (2026-05-31).** A second, distinct news-visibility bug from the DBGI one. AGPU was on the Continuation list with its news already in the DB (latest 05-27 "$43M payment", 05-26 Q1 call) — but viewed on Sunday 05-31 it showed no news, because the windows were too narrow to reach back across a weekend: the Continuation badge looked back only 3 days (`NEWS_LOOKBACK_DAYS`) and the click surfaces 4 (`days=4`), both excluding 05-27 (4 calendar days back). Fix: couple each surface's news window to its analytical horizon — `continuation.ts` `NEWS_LOOKBACK_DAYS → LOOKBACK_DAYS` (7, so the badge spans the same window the continuation does), and `WATCHLIST_NEWS_DAYS` / `TICKER_NEWS_DAYS` (Quote Details) / `MODAL_NEWS_DAYS` (catalyst modal) all 4→7. Verified on prod: `GET /api/news?ticker=AGPU&days=4` → 0 articles (the bug), `days=7` → 3 (fixed; the 05-27 + 05-26 items surface). Deliberately did **not** add a fallback-to-latest — a "Recent News" panel surfacing month-old news would mislead; >7-day-stale is genuinely no recent news.
- **On-demand per-ticker news (2026-05-31).** The poller only ingests news for tickers **currently in the screener universe** (it builds the news-fetch ticker list from the live screens). So a name that drops off the screens — DBGI, last screened 05-27 — or any watchlist ticker that isn't actively screening stops accruing news in our DB, even though Finviz/Yahoo/Benzinga still carry fresh items. That's why DBGI showed no news in the dashboard while Finviz/Benzinga had it. Fix: new `services/ticker-news.ts` `fetchAndStoreTickerNews(ticker)` pulls a single ticker's recent **multi-day** news live (Finviz with the date filter off → multi-day window, plus Yahoo), upserts into `news_articles` + `news_ticker_links` (dedup by url, same shape as the poller's persist path), and rule-classifies each new article. Rate-bounded by a 2-min per-ticker cache so rapid clicks don't hammer Finviz. `GET /api/news?ticker=X` now calls it best-effort *before* the DB query, so clicking any ticker's news — Quote Details "Recent News" and the catalyst modal, both already on `days=4` — surfaces the last few days regardless of whether the ticker is screening. Verified on prod: DBGI went from 2 stale rows (a 05-21 halt + a 05-11 blurb) to 41 after one read, pulling its actual recent Finviz/Yahoo PRs (05-28 AI-strategy, 05-21 partnership, 05-12 guidance, …).
- **Watchlist v2 — star-from-anywhere + news indicator (2026-05-31).** Reworked the watchlist from the initial add-form version. Capture is now a one-click **★** (`common/WatchlistStar.tsx`) on every row surface — Momentum / Swing / Continuation tables, the Ignition sidebar, and the Quote Details header — so a ticker goes on the list from wherever you spot it; filled gold = on the list (click removes), hollow = add. Default expiry dropped to **+2 ET days** (editable per row via an inline Popover DatePicker on the days-left chip; `PATCH /api/prefs/watchlist/:ticker`). Each watchlist row now surfaces its most recent catalyst (shared `CatalystBadge` + headline, 4-day news window like Continuation) **and a 🆕 "new news" dot** when an article landed after you added / last viewed the entry — so a catalyst breaking while a ticker sits in the list lights up on its own (the panel refetches every 5 min). Opening the row's news clears the dot (`user_watchlist.news_seen_at` column + `POST /api/prefs/watchlist/:ticker/seen`; the GET computes `has_new_news = latest published_at > coalesce(news_seen_at, created_at)`). The add-form and free-text notes were removed (the `note` column stays in the DB, unused). Added a `patch()` method to the web api client. Verified on prod: star-add → +2d default, list carries catalyst + `has_new_news`, mark-seen flips it to false, PATCH expiry, delete.
- **Watchlist / favorites with expiry (2026-05-31).** A persistent, per-user watchlist for the "park a ticker while the market's closed, analyze it, enter at the open" workflow. Each entry = ticker + free-text note (the thesis) + an expiration date. Expired entries auto-remove server-side via an ET-day cleanup on GET (same pattern as `user_hidden_tickers`), so the list stays trimmed to what's still live with no manual housekeeping. Always-visible **WatchlistPanel** stacked under the Ignition sidebar in the left rail (vertical split, ~35% default) — both visible while scanning the screener tabs. Add form prefills the ticker from the current selection + a note + an expiry DatePicker (default +7d, past dates disabled); list shows note + a colour-tiered days-left badge; clicking a row drives the shared selection (charts + Quote Details), × removes. `db/migrations/…_user_watchlist.sql` (PK `(user_id, ticker)` so re-adding updates note/expiry), `/api/prefs/watchlist` GET/POST/DELETE, `useWatchlist` hook, `WatchlistPanel.tsx`. Verified on prod: add → 201, past-expiry → 400, list/delete/expiry-cleanup all correct.
- **Per-ticker news — multi-day lookback (2026-05-30).** `GET /api/news?ticker=X` was hard-scoped to today (ET), so a Continuation/Swing name whose catalyst landed yesterday showed "No news yet" in both the Quote Details "Recent News" section and the catalyst modal — even with the news in the DB (STG: $50M buyback + asset disposal, all 05-29, viewed 05-30 with the market closed → today=0, 4-day window=5, verified on prod). Today-only is right for a fast intraday mover but wrong for the swing timeframe, where a 2–3-day-old catalyst still drives the stock. Added an optional `?days=N` param (default `1` = today only, unchanged momentum behavior; `days=N` filters `published_at::date >= today_ET-(N-1)::int`, clamped [1,30]). Quote Details + the catalyst modal request `days=4` (today + previous 3 ET calendar days, so a Friday headline shows the next Monday); `TickerNewsList` shows `Mon DD · HH:MM` for older items and bare time for today; section renamed "News Headline" → "Recent News". **Gotcha caught in this work:** Kysely binds the interpolated `${days-1}` as an *untyped* parameter, and Postgres has no `date - unknown` operator (error 42883) — the route 500'd (→ 502) on every per-ticker news call until an explicit `::int` cast was added. The Continuation row badge already used a 3-day window in the builder, so it was unaffected. `routes/news.ts`, `api/news.ts`, `SelectedStockPanel.tsx`, `CatalystNewsModal.tsx`, `TickerNewsList.tsx`.
- **Continuation reworked — seed-both-screens + daily-bar forward-track (2026-05-30).** The original Continuation list seeded *and* tracked from `ignition_results` only, so it had two structural blind spots: (1) a Momentum-style runner (bigger float, no nano-float volume burst) never entered `ignition_results`, so it could never appear; (2) staying on the list required *re-passing the strict real-time screen filter on a 2nd day* — the exact thing the signal is meant to transcend, so a name that gapped up day-2 on calmer volume (below the relvol/change gates) silently fell off. The rebuild separates **seed** from **track**: seed = appeared in *either* screen (`screener_results ∪ ignition_results`) on any day in a 7-day window; track = each seed's subsequent days read from **`daily_bars`** (unfiltered EOD OHLCV), where a day counts ACTIVE if it hit a screen *or* the bar shows a real move (close-to-close ≥ +5% or volume ≥ 1.5× the pre-window baseline). `days_in_run` = distinct active days from the trigger; multi-day-confirmed at ≥ 2; then a **liveness gate** drops anything whose latest close has round-tripped below 50% of the run's peak close (a dead pump isn't a continuation). New columns: **Run** (days_in_run + `scr/total` subtext showing how many days a screen actually flagged vs. the daily bar carried alone), **Move** (cumulative % from the run's base close + last day-over-day), **Off peak** (liveness %, with a ⚡ when the name is live on Ignition today). Crucially this adds **zero live API calls** — `daily_bars` is kept fresh by the existing once-per-day-per-ticker `DailyBarsService`, off the poll hot path; the builder just calls `dailyBars.trackUniverse(seeds)` to extend coverage to continuation seeds. Dual-signal 🎯 alert message updated to lead with active-days + from-base move. `services/continuation.ts`, `ContinuationTable.tsx`, types.
- **History tab — shipped (2026-05-29).** Fourth tab inside the Screener panel — `[Momentum] [Continuation] [Swing] [History]`. Pick an ET trading date + Ignition or Momentum, see every ticker that appeared on that day grouped by session (PM / REG / AH / closed). Per-`(ticker, session)` row with: first → last ET time, peak runner-score (Ignition) or status (Momentum, collapsed via `coalesce(NEW > ACC > UP > NEWS)`), two-tone chg range, price range with cumulative %lift, ticks. The day's most-impactful catalyst classification rides as a clickable 🔥/✨ badge next to each ticker. Static query — no SSE, refetches on date or screen change. `GET /api/screener/history-by-day?date=YYYY-MM-DD&screen=ignition|momentum`; single `sql` template branched at the CTE level for the two source tables; day_catalyst CTE for the news join. ~600 ms on a busy day.
- **Continuation refinements — shipped (2026-05-29).** Tab order is `[Momentum] [Continuation] [Swing]` (Continuation as the bridge between intraday and multi-day). Days column sorts ASC by default so early-stage setups float to the top (5-6-day rows are already extended — CODX at day 5 was $7+, well past entry). Shared `common/TickerLinks.tsx` extracted — Finviz + TradingView icons on Momentum, Continuation, and Swing all use it. News/catalyst badge on Continuation reads off the row's own data with a **3-day lookback** (multi-day window so a catalyst from 2 days ago still surfaces); the 🚨 "this cycle" indicator stays driven by the live payload.
- **Dual-signal 🎯 Telegram alert — shipped (2026-05-29).** Fires once per ticker per ET day when a ticker on the Continuation list (≥ 2 days of Ignition history) also clears `runner_score ≥ 40` in the live cycle. The CODX-day-2/3 trigger — the *confirmation* that the move is multi-day, not just a one-session pump. Bullish-only (skips bearish catalysts and crashing moves). Lower score floor than the vanilla Ignition alert (40 vs 58) since the multi-day prior already de-risks the signal. Message leads with `Day N · score first → today` so the trajectory is immediate.
- **Continuation tab — shipped (2026-05-29).** Third tab inside the Screener panel — `[Momentum] [Swing] [Continuation]`. Surfaces every ticker that appeared in `ignition_results` on **≥ 2 distinct ET days within the last 5**, ordered by *today's-list-presence DESC* → *days_seen DESC* → *today_peak DESC*. Pure derivative of the Ignition stream — no separate scan, no new persistence. Columns: Ticker (with live shelf badge looked up from `payload.{rows,ignition,swing}`), Days seen (color-tiered), Window (`first → last` ET dates), **Score Day-1 → Today** with trajectory arrow ↑/→/↓/· (climbing = conviction growing, falling = move rolling over), Price range with cumulative %lift, and a compact **`M I S`** live-presence strip showing which of Momentum/Ignition/Swing currently flag the ticker. The CTE-based aggregation costs ~1.5 s on the prod-sized dataset, so the poller caches the result and refreshes it every ~10 min (every 30 cycles); errors keep the previous list so a transient DB blip doesn't blank the tab. The motivating insight (catching-runners.md): a name that keeps showing up in Ignition day after day isn't an intraday flicker — it's the multi-day setup that CODX/SBFM/FATN all illustrate. Click a Continuation row + look at its 1-h chart = the swing-trader's eye-line.
- **Swing screener — shipped (2026-05-29).** A separate multi-day setup screen running inside the same poll loop on a ~20-min cadence + a forced 16:30 ET post-close refresh. Different universe than Momentum/Ignition: `$2–$50`, float `5M–100M`, mcap `≥ $50M`. Score 0–100 (Trend 25 + Strength 15 + Setup 25 + Volume 15 + Catalyst 20, shelf penalty −25); setup composite = base detection + 10/5-day breakout + close-strength. Surfaced as a `[Momentum] [Swing]` tab pair in the Screener panel — Ignition sidebar stays put (different axis: real-time discovery vs daily-setup detection). Persisted to `swing_results` (one snapshot per scan, full daily-bar context frozen for backtests). Telegram `/swing` command + alerts at `score ≥ 65` with `broke_out` or a fresh bullish strong/major catalyst. Full spec: [`swing-screener-spec.md`](swing-screener-spec.md).
- **Daily-bar backfill (Phase 3b — unpaused, shipped with Swing).** New `daily_bars` table; `DailyBarsService` pulls Finviz `quote_export?p=d` at 1 req/sec, upserts via `ON CONFLICT DO UPDATE`. Backfill mode writes full ~250-bar history on first sight, refresh mode overwrites the trailing 10 bars (catches after-close corrections). Midnight ET invalidates every cached ticker so today's just-closed bar gets re-fetched. Bootstrap surface: `POST /api/screener/swing/backfill`; verify with `GET /api/screener/swing/bars?ticker=X`. Was the hard prerequisite for the Swing score — SMAs, 52w high, ATR, base/breakout detection all need ~250 days of daily OHLCV per ticker.
- **Quote Details — Ignition history sub-tab.** Per-ticker per-cycle runner-score evolution from `ignition_results` (`GET /api/screener/ignition-history?ticker=X`). Closes the UX gap where the existing History tab silently showed nothing for ignition-only sub-$1 names that never met the Momentum filter.
- **Ignition sidebar — news indicators + anchored-VWAP arrow.** Shared `CatalystBadge` (🚨 fresh / ✨ pending / 🔥-tier classified) sits next to each ticker after the shelf badge, clicking opens the same modal as the Momentum table. ▲/▼ above/below-VWAP arrow next to the change%; the VWAP is anchored to first detection today and persists across PM → regular → AH to match a chart's day-session VWAP.
- **Ignition Telegram alerts — first-detection change% cap.** `IGNITION.alert_entry_chg_max = 40` — if a ticker's first qualifying cycle is already > 40% extended, the alert is suppressed (but not added to the dedup set, so a pullback under the cap re-fires a fresh second-leg alert). Grounded in the 05-21/05-22 data: every catastrophic loser (WHLR +146→−119, FRGT +93→−104, ORIS +54→−59) entered above this cap; every winner (SBFM +3→+47, AKTX +50→+93, BIYA +30→+51) entered below.
- **Tab-title surfaces new Ignition entries** — when the tab is hidden, a new `is_new` ignition flips the title to `PNL Dash (⚡ N ignition)`. Static, doesn't downgrade an in-progress 🔥 flash, resets on tab focus. Priority chain: flash (Momentum NEW+catalyst) > ignition > static-no-news.
- **Ignition: drop score-0 rows from the broadcast** — the volume-led Finviz filter has no change% gate (volume leads price by design), so crashes and dilution-flagged names pass through; the runner-score then clamps them at 0. Those rows used to fill the sidebar bottom anyway. Now filtered at the broadcast layer: `runner_score > 0`. Cold-start fresh entries and volume-led turnarounds (which score 48+) still surface.
- **Sidebar UX cleanup** — shelf-badge popover and ignition-score breakdown now open on **click**, not hover (and stop the click from also selecting the row); sidebar ticker symbols are `TickerLink`s (click copies + toasts); per-row × hide button uses the same global `useHiddenTickers` mechanism as the Momentum table; Finviz/TradingView icon buttons added to the Quote Details header for the selected ticker.
- **CI deploy bug fix (load-bearing)** — the rollout script is piped to `ssh ... 'bash -se'` over stdin, and `docker compose exec -T` was silently consuming stdin and swallowing the rest of the script after `nginx -t`. Every deploy since the "deploy hardening" change was skipping the nginx restart **and** the migration step, yet still reporting success. Fix: `</dev/null` on every `docker compose exec` in the deploy. **Any future edits to the deploy script must keep this redirect** or the same silent truncation returns.
- **Telegram alert tuning** — three related changes bundled (the CNEY post-mortem):
  - **Momentum alerts are bullish-only** — `pushAlerts` skips bearish strong/major catalysts (dilutive offerings, SEC probes, regulatory halts). Neutral signals (T1 "news pending" halts) still alert.
  - **Volume cold-start fix** — `rel_vol_5min` is extrapolated from the oldest sample once ~75s of history exists; volume burst measurable ~80s after a ticker appears, not 5 min.
  - **Shelf penalty no longer suppresses the Ignition alert** — `pushIgnitionAlerts` tests the threshold against the score *minus* the shelf component. Dilution still ranks the row and rides as the ⚠️, but doesn't hide the ignition.
- **Session-aware Ignition filter — looser pre-market gate.** The Ignition Finviz screen now uses a relaxed current-volume floor (`sh_curvol_o100` vs the regular-session `sh_curvol_o500`) when `session === 'premarket'`. Pre-market liquidity is thin enough that a sub-2M-float pump can rip +100% before crossing 500K cumulative shares, so the standard filter gated it out until the move was largely over. The relvol > 2 gate stays the same. Came out of the WHLR post-mortem — first appeared at +146% under the old filter.
- **LLM classifier moved from OpenAI to Anthropic.** Catalyst refinement now uses Claude Sonnet 4.6 via `messages.parse()` with a Zod schema + prompt caching on the static system prompt (Sonnet's 2048-token cache minimum makes this engage out of the box). The rule engine is unchanged. Direction calls on dilution-disguised-as-PR headlines were the motivating gap. Old `openai_*` classifier values stay valid for historical rows; new rows tag `anthropic_sonnet`. Requires `ANTHROPIC_API_KEY` instead of `OPENAI_API_KEY` (one migration adjusts the `news_classifications.classifier` CHECK).
- **Telegram bot — two-way commands.** The same bot that pushes alerts now answers queries from the configured chat. Long-polling via `getUpdates`; single-chat auth (`TELEGRAM_CHAT_ID`). Commands: `/ignition` and `/momentum` (current top-N), `/status` (poller health), `/ticker SYMBOL` (quick stats for one ticker), `/hidden` + `/unhide` (gated on optional `TELEGRAM_USER_ID`), `/alerts on|off` (runtime mute). New service `services/telegram-bot.ts` reads from `poller.getLastPayload()` — no DB writes except `/unhide`.
- **Ignition sidebar — New/Top split** — the sidebar now pins a "New" section above the score-ranked list: tickers that just entered the Ignition set (< 2 min), surfaced *regardless* of runner-score. Closes a blind spot — a fresh ignition's 5-min RVol isn't measurable yet, so it scored low and sank to the bottom or off the broadcast list entirely. The poller bypasses the `broadcast_n` cutoff for new rows.
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

## Empirical session performance (2026-05-18 → 2026-05-21)

A four-day sample of `ignition_results` rows (peak chg ≥ 10%), measured by *end-of-session* P&L from first detection (`last_chg − first_chg`, accounting for drawdowns):

| Session | Profitable days | Win rate | Avg final P&L | Notes |
|---|---|---|---:|---|
| **Regular** (09:30–16:00 ET / 18:30–01:00 UTC+5) | 3 of 4 | 50–76% | +5 to +8 | Steady; one bad day (-18). Best session you can trade live in UTC+5. |
| **After-hours** (16:00–20:00 ET / 01:00–05:00 UTC+5) | 3 of 3 | 52–76% | +3 to +22 | Most profitable, but user asleep. Telegram alerts useful as overnight intel. |
| **Pre-market** (04:00–09:30 ET / 13:00–18:30 UTC+5) | 1 of 4 outlier | 14–35% | **−15 to −30** | **Consistently money-losing if held from first detection to session close.** Drawdowns swamp the upside. |

**Key takeaway:** the Ignition screener's edge lives in AH and Regular; pre-market is a buy-the-top-and-bleed pattern. Pre-market alerts still fire useful continuations (a name that rips in PM often runs further in Regular), but **holding from first PM detection through session close consistently loses money**. The `move_after = peak − first` upside metric used internally is one-sided (`max ≥ first` by construction, so it's always ≥0); to evaluate trade outcomes use `final_pnl = last − first` and `drawdown = first − floor` together.

Worked diagnostic query — per-session per-ticker outcomes with drawdown:

```sql
with rows as (
  select c.session, (c.polled_at at time zone 'America/New_York')::date et_date,
    i.ticker, c.polled_at, i.change_pct,
    row_number() over (partition by c.session, (c.polled_at at time zone 'America/New_York')::date, i.ticker order by c.polled_at) rn_asc,
    row_number() over (partition by c.session, (c.polled_at at time zone 'America/New_York')::date, i.ticker order by c.polled_at desc) rn_desc,
    min(i.change_pct) over (partition by c.session, (c.polled_at at time zone 'America/New_York')::date, i.ticker) min_chg,
    max(i.change_pct) over (partition by c.session, (c.polled_at at time zone 'America/New_York')::date, i.ticker) peak_chg
  from ignition_results i join screener_cycles c on c.id = i.cycle_id
  where c.polled_at > now() - interval '6 days'
)
select et_date, session, ticker,
  max(change_pct) filter (where rn_asc = 1)  as entry,
  peak_chg, min_chg as floor,
  max(change_pct) filter (where rn_desc = 1) as last_chg,
  max(change_pct) filter (where rn_asc = 1) - min_chg as drawdown,
  max(change_pct) filter (where rn_desc = 1) - max(change_pct) filter (where rn_asc = 1) as final_pnl
from rows
group by et_date, session, ticker, peak_chg, min_chg
having peak_chg >= 10
order by et_date, session, peak_chg desc;
```

## Remaining work / roadmap

**Next-session orientation — the actionable items live under "Tuning from data"
below.** Building has largely caught up to the spec; the gap is grading the
shipped alerts/scores against actual outcomes so the thresholds and weights
can be retuned from real distributions rather than first-pass guesses. The
shipped pipeline is dense enough now that adding more features without that
feedback loop will be wasted work.

### Tuning from data (priority — earliest valuable work for a continuing session)

- ✅ **Forward outcome tracking** — SHIPPED 2026-06-02 (`services/outcomes.ts`,
  `screener_outcomes` table). Daily post-close job (16:30 ET, fired from the
  poller; boot-time catch-up backfills history) that rolls each ET day's
  Momentum / Ignition / Swing detections to **one row per (screen, ticker,
  et_date)** and joins `daily_bars` forward for `chg_1d/3d/5d`, `peak_5d`,
  `drawdown_5d`, anchored to the detection-day close. Idempotent upsert that
  revisits each row until `bars_forward >= 5`. Entry context denormalized
  (entry_score, first/peak_change_pct, catalyst from the news join,
  shelf_level, sessions). Zero new live API calls — reads `daily_bars` and
  `trackUniverse()`s detected tickers so nano-caps off the Swing universe get
  backfilled. **"Did the score/catalyst/shelf predict the move?" is now one
  GROUP BY.** See the worked queries in "Reading the outcome data" below.
  Status on `/health` → `outcomes`. **Still headless — no UI yet (by design:
  measure first).**
- **Retune scores from outcomes** — once outcome data has a couple of weeks
  of GO-FORWARD depth (not just the boot backfill), regress final P&L against
  each component-score bucket. Most likely candidates: Swing `Catalyst 20`
  weight, Ignition `change_score` (PM-fade → steeper penalty on extended PM
  entries), dual-signal `min_ignition_score = 40`. **Do not retune off the
  first backfill — samples are tiny and rows overlap across screens.** First
  reads (2026-06-02, small N, directional only): bearish catalyst reliably
  bad (≈ −15% 5d); bullish-catalyst names have the HIGHEST peak but give it
  back by close (the "trade the spike, don't hold" signature — endorses the
  exit-into-strength play); `active` shelf had the best mean return + worst
  drawdown (so "skip effective shelves" is NOT supported as a return filter —
  dilution = volatility, not lower upside); drawdown rises cleanly with entry
  extension.
- **Dual-signal alert outcome study** — separate forward-track. The 🎯
  alert is the highest-conviction signal we ship; its hit rate over the
  next 1, 3, 5 trading days is the most important number to know.
- **PM-specific alert handling** — see the §"Empirical session performance"
  analysis above. The Ignition PM hit rate is materially below Regular;
  the right next move is raising the PM alert threshold (or attaching a
  "PM entry recommendation" flag tied to `entry_change_pct < ceiling`).

### Runner-detection roadmap — see [`catching-runners.md`](catching-runners.md)

- **Phase 3 — refinements.** Fully shipped.
  - ✅ **EDGAR shelf/dilution flag** — a 12-month per-ticker SEC submissions lookback grades each name `shelf` / `effective` / `active`; surfaced on rows + alerts and penalised in the runner-score (`services/shelf.ts`).
  - ✅ **Phase 3b — Finviz daily-bar backfill** (was paused; shipped 2026-05-29 alongside the Swing screener). `daily_bars` table + `DailyBarsService` keeps ~250 bars/ticker fresh against `quote_export?p=d`. Repeat-runner prior is the next analytical lift — `historical_runs` per ticker is one SQL query off the backfilled data.
- **PR-wire news source** — GlobeNewswire / ACCESSWIRE firehose matched against the live screener universe. The deliberately-deferred follow-up to EDGAR + halts.

### Swing screener — deferred / tuning

- Swing filter is a code constant (`SWING.filter`) — wire to the existing Filters dialog for per-user override, mirroring the Momentum path.
- No backtest UI — `swing_results` records the score + daily-bar context with each scan; tuning is ad-hoc psql. A query view/endpoint over the score-vs-N-day-outcome would close the loop.
- **Retune from data** — the `swing_score ≥ 65` alert threshold and the §3 component weights are first-pass estimates. After 5–10 trading days of `swing_results`, retune against the actual score-vs-outcome distribution.
- **Forward outcome tracking** — schedule a daily job at 16:30 ET that joins each prior swing snapshot to today's bar, computes `chg` / `peak` / `drawdown` over N days, and writes back a `swing_outcomes` row. Makes "did the score predict the move?" a single query.
- **Sector-strength bonus** — the spec §3 reserves space for a sector-regime input (e.g. SPY/QQQ above SMA20 = risk-on, sector ETF above its 50-SMA = sector tailwind). Currently 0.
- ✅ **Dual-signal 🎯 Telegram alert** (shipped 2026-05-29) — fires once per ticker per ET day when a Continuation candidate (≥ 2 days of Ignition history) also clears `runner_score ≥ 40` in the live cycle. `pushDualSignalAlerts()` in `poller.ts`; message leads with "Day N · score first→today" so the multi-day context is immediate.

### Ignition screener — deferred / tuning

- Ignition filter is a code constant — make it user-editable, like the Momentum filter dialog.
- No backtest UI — tuning the runner-score is ad-hoc psql for now; a query view/endpoint would close the loop.
- **Retune from data** — the alert threshold (currently 58) and the runner-score weights are first-pass estimates. After several sessions of `ignition_results`, retune both against the actual score-vs-outcome distribution.
- **PM-specific alert handling** — given the empirical-findings section above (PM is consistently money-losing on hold-to-close), consider either raising the alert threshold during `session === 'premarket'` (e.g. require runner_score ≥ 65), or suppressing PM alerts entirely for the user with `TELEGRAM_USER_ID` set, or adding a separate "PM entry recommendation" flag that only fires when `up_after` is plausibly still ahead (e.g. first_chg below some ceiling).
- **LLM classifier cache verification** — check `usage.cache_creation_input_tokens` vs `cache_read_input_tokens` from the Anthropic SDK after a few classifications; if reads stay 0, the system prompt is under Sonnet's 2048-token cache minimum and we should pad it with more worked examples (also improves quality).
- **`regulatory_approval` catalyst type** — the SBFM Health Canada amoxicillin case (May 21) classified as `fda_clinical` because the schema doesn't have a separate bucket for non-FDA drug approvals. Adding it to the Zod enum + system prompt is a one-line change; no DB migration (catalyst_type is unconstrained `text`).

### Continuation / Dual-signal — deferred / tuning

- **`/dual` Telegram command** — answer with the current Continuation ∩ live Ignition intersection on demand, same shape as `/swing` / `/ignition` / `/momentum`. Mirrors the dual-signal alert criteria.
- **🎯 visual marker in the dashboard** — show on Continuation rows that *currently* qualify (dual-signal active), even if not freshly alerted. Either a column or a separate badge in the existing M/I/S live-presence strip.
- **Cache cadence retune** — `CONTINUATION_REFRESH_CYCLES = 30` (~10 min) is a guess at the right cost/freshness balance. The refresh now does the union-of-both-screens day rollup *plus* a `daily_bars` read for every seed, so it's heavier than the old ignition-only aggregation; an index on `screener_cycles((polled_at at time zone 'America/New_York')::date)` would let the cadence drop.
- **News window** — currently 3 days (`NEWS_LOOKBACK_DAYS`). Once outcome data exists, check whether 2 days / 5 days correlates better with successful Continuation trades.
- **Forward-track thresholds** — the rebuilt builder has several first-pass knobs to tune against outcomes: `LOOKBACK_DAYS = 7` (seed window), `ACTIVE_UP_PCT = 5` / `ACTIVE_RVOL = 1.5` (what counts as a bar-derived active day), `LIVENESS_MIN_FRAC = 0.5` (drop a name once it round-trips below 50% of its run's peak close). All in `services/continuation.ts`.

### History tab — follow-ups

- **Daily summary header** — top-of-day stats (total tickers, busiest session, biggest mover by chg, biggest mover by score). Visible at a glance without scrolling the table.
- **Cross-day diff** — checkbox to highlight tickers that also appeared on the *previous* ET trading day. Visual continuation hint — every name highlighted has a built-in Day-N story.
- **Date range / heatmap** — pick a 5–7 day window, get a heatmap of which tickers appeared in which (date, session) cells. Surfaces the multi-day pattern that the single-day view can only hint at.
- **Per-session filter chip** — quick "show only PM rows" without sort gymnastics.

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

# Swing screener — current top setups (latest scan)
source .env && psql "$DATABASE_URL" -c \
  "select ticker, swing_score, in_base, broke_out, close_in_top_q from swing_results \
   where created_at > now() - interval '30 min' order by swing_score desc limit 20;"

# Daily-bar reservoir depth — how many bars per ticker we have
source .env && psql "$DATABASE_URL" -c \
  "select count(distinct ticker) as tickers, count(*) as bars, \
   min(date) as oldest, max(date) as newest from daily_bars;"

# Continuation SEEDS — distinct ET screen-days per ticker over the last 7,
# unioned across BOTH screens (Momentum + Ignition). This is the seed set;
# the live tab then forward-tracks each via daily_bars (active days, liveness),
# so the tab is stricter than this raw rollup. See services/continuation.ts.
source .env && psql "$DATABASE_URL" -c \
  "with recent as ( \
     select i.ticker, (c.polled_at at time zone 'America/New_York')::date as et_date, i.runner_score \
       from ignition_results i join screener_cycles c on c.id = i.cycle_id \
       where c.polled_at > now() - interval '7 days' \
     union all \
     select s.ticker, (c.polled_at at time zone 'America/New_York')::date as et_date, null::numeric \
       from screener_results s join screener_cycles c on c.id = s.cycle_id \
       where c.polled_at > now() - interval '7 days' \
   ) select ticker, count(distinct et_date) screen_days, max(runner_score) peak_ig_score \
     from recent group by ticker having count(distinct et_date) >= 2 \
     order by screen_days desc, peak_ig_score desc nulls last limit 20;"

# News ingest by source
source .env && psql "$DATABASE_URL" -c \
  "select source, count(*) from news_articles where fetched_at > now() - interval '1 hour' group by source;"
```

### Reading the outcome data (`screener_outcomes`)

The forward-outcome instrument (shipped 2026-06-02, `services/outcomes.ts`).
Always gate on `bars_forward >= 5` so you only compare rows whose 5-day
horizon has actually filled. **Caveat that matters: the boot backfill is ~2
weeks, samples per cell are small, and the same runner appears across multiple
screens (rows are NOT independent) — treat early reads as a direction check,
not a verdict. Wait for ~2 weeks of GO-FORWARD depth before retuning weights.**

```bash
source .env

# Coverage — how much is ready per screen
psql "$DATABASE_URL" -c \
  "select screen, count(*) n, count(*) filter (where bars_forward>=5) ready, \
   round(avg(chg_5d),1) avg5, round(avg(peak_5d),1) peak, round(avg(drawdown_5d),1) dd \
   from screener_outcomes group by 1 order by 1;"

# THE core hypothesis — does catalyst direction predict the 5-day move?
psql "$DATABASE_URL" -c \
  "select screen, coalesce(catalyst_direction,'(none)') dir, count(*) n, \
   round(avg(chg_5d),1) avg5, round(avg(peak_5d),1) peak, round(avg(drawdown_5d),1) dd \
   from screener_outcomes where bars_forward>=5 group by 1,2 order by 1, avg5 desc nulls last;"

# Shelf level — settles 'is it OK to skip effective shelves?'
psql "$DATABASE_URL" -c \
  "select coalesce(shelf_level,'(none)') shelf, count(*) n, round(avg(chg_5d),1) avg5, \
   round(avg(peak_5d),1) peak, round(avg(drawdown_5d),1) dd \
   from screener_outcomes where bars_forward>=5 group by 1 order by avg5 desc nulls last;"

# Entry-extension bucket — the WHLR/FRGT 'entered already extended' loser-trait
psql "$DATABASE_URL" -c \
  "select case when first_change_pct>=40 then 'd_>=40%' when first_change_pct>=20 then 'c_20-40%' \
          when first_change_pct>=0 then 'b_0-20%' else 'a_<0%' end bucket, \
   count(*) n, round(avg(chg_5d),1) avg5, round(avg(drawdown_5d),1) dd \
   from screener_outcomes where bars_forward>=5 and first_change_pct is not null group by 1 order by 1;"
```

**First reads (2026-06-02, small N — directional only):** bearish catalyst
reliably bad (≈ −15% 5d, worst drawdowns); **bullish-catalyst names show the
HIGHEST peak but give it back by close** — the "trade the spike, don't hold 5
days" signature, which *endorses* the exit-into-strength play rather than
refuting "catalyst matters"; `active` shelf had the *best* mean return + worst
drawdown (so "skip effective shelves" is NOT a return filter — dilution =
volatility, not lower upside); drawdown rises cleanly with entry extension.
"(none)" catalyst is contaminated — it means "no article we captured/classified
that day," not "no news."

### Migrations

The poller's column writes match `apps/api/src/db/types.ts`. Bumping those types without a matching migration causes `column "X" does not exist` errors in the poll cycle. The CI deploy runs `dbmate up` and verifies the schema against the app database; if it reports a schema behind, apply manually on the droplet with `dbmate up`.

### Deploy-script stdin footgun (fixed, but don't reintroduce)

The rollout step in `.github/workflows/build-images.yml` pipes the deploy script to `ssh ... 'bash -se'` over stdin. Any `docker compose exec -T <svc> <cmd>` inside that script will consume bash's stdin (the script body itself) and silently truncate the rest of the deploy — bash hits EOF and exits 0, the workflow reports success, but the nginx restart and `dbmate up` never ran. This was caught after the EDGAR shelf migration's CI run reported success but the column didn't actually exist on the droplet.

**Every `docker compose exec` in the deploy script must end with `</dev/null`.** Two call sites exist today (the nginx `nginx -t` check and the migration-verification `psql ... select count(*) from schema_migrations`) — both are redirected. If you add a third, add `</dev/null` or you'll reintroduce the silent-truncation bug.
