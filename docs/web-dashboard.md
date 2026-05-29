# Momentum Screener — Web Dashboard

Status as of 2026-05-29 (late). The bash scanner (`screener-poll_breakout.sh`) and the web dashboard are both functional; the bash version remains the reference implementation. The web port lives in `apps/api` + `apps/web` and runs in parallel without sharing state with it.

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
│  Ignition sidebar │ [Momentum] [Swing] [Continuation] tabs ·    │
│  (left edge)      │ Quote Details · News Room            │ 0–4  │
│                   │ (3 stacked panels)                  │ charts│
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
| Continuation list (Ignition repeat-aggregation) | ✅ | `services/continuation.ts`, cached & refreshed every ~10 min |
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
| Screener live table (SSE) — `[Momentum] [Swing] [Continuation]` tabs | ✅ | Momentum: NEW/ACC/UP/NEWS badges, 🔥/🚨 markers. Swing: score + setup flags (B/↑10/↑5/C) + vs 52WH + vs 20-SMA + Vol×Avg. Continuation: days seen + score day-1→today trajectory + price range + live M/I/S presence strip |
| Ignition sidebar — New + Top split | ✅ | Pinned "New" section above the score-ranked feed (left edge); ▲/▼ above/below anchored-VWAP arrow next to chg% |
| Catalyst news modal | ✅ | Click a row's 🔥 badge → catalyst verdict + ticker news |
| Quote Details — Stats + Sentiment + History + Ignition | ✅ | Color-coded per CLAUDE.md bands; per-ticker Momentum history *and* Ignition history sub-tabs |
| News Room (current screener tickers) | ✅ | |
| TradingView chart grid — adjustable 0–4 | ✅ | At `0` the pane unmounts (iframes torn down) |
| Hardcoded indicators per interval | ✅ | VWAP + MACD + EMA(20) on 1m; Volume elsewhere |
| Audio + browser-notification alerts | ✅ | "Arm alerts" unlocks AudioContext + permissions |
| Filter editor dialog | ✅ | Price range, min change %, min RVol, max float, top N |

## Recent additions (since the 2026-05-04 snapshot)

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
- **Dual-signal flag** — the strongest setups historically appear in BOTH lists the same day (ignition score ≥ 40 AND swing score ≥ 40 on the same ET day). Surface as a separate `🎯` marker in the sidebar / alert.

### Ignition screener — deferred / tuning

- Ignition filter is a code constant — make it user-editable, like the Momentum filter dialog.
- No backtest UI — tuning the runner-score is ad-hoc psql for now; a query view/endpoint would close the loop.
- **Retune from data** — the alert threshold (currently 58) and the runner-score weights are first-pass estimates. After several sessions of `ignition_results`, retune both against the actual score-vs-outcome distribution.
- **PM-specific alert handling** — given the empirical-findings section above (PM is consistently money-losing on hold-to-close), consider either raising the alert threshold during `session === 'premarket'` (e.g. require runner_score ≥ 65), or suppressing PM alerts entirely for the user with `TELEGRAM_USER_ID` set, or adding a separate "PM entry recommendation" flag that only fires when `up_after` is plausibly still ahead (e.g. first_chg below some ceiling).
- **LLM classifier cache verification** — check `usage.cache_creation_input_tokens` vs `cache_read_input_tokens` from the Anthropic SDK after a few classifications; if reads stay 0, the system prompt is under Sonnet's 2048-token cache minimum and we should pad it with more worked examples (also improves quality).
- **`regulatory_approval` catalyst type** — the SBFM Health Canada amoxicillin case (May 21) classified as `fda_clinical` because the schema doesn't have a separate bucket for non-FDA drug approvals. Adding it to the Zod enum + system prompt is a one-line change; no DB migration (catalyst_type is unconstrained `text`).

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

# Continuation candidates (≥ 2 distinct ET days in last 5) — derived from
# ignition_results, so this query mirrors what the Continuation tab shows.
source .env && psql "$DATABASE_URL" -c \
  "with recent as ( \
     select i.ticker, (c.polled_at at time zone 'America/New_York')::date as et_date, i.runner_score \
     from ignition_results i join screener_cycles c on c.id = i.cycle_id \
     where c.polled_at > now() - interval '5 days' \
   ) select ticker, count(distinct et_date) days_seen, max(runner_score) peak \
     from recent group by ticker having count(distinct et_date) >= 2 \
     order by days_seen desc, peak desc limit 20;"

# News ingest by source
source .env && psql "$DATABASE_URL" -c \
  "select source, count(*) from news_articles where fetched_at > now() - interval '1 hour' group by source;"
```

### Migrations

The poller's column writes match `apps/api/src/db/types.ts`. Bumping those types without a matching migration causes `column "X" does not exist` errors in the poll cycle. The CI deploy runs `dbmate up` and verifies the schema against the app database; if it reports a schema behind, apply manually on the droplet with `dbmate up`.

### Deploy-script stdin footgun (fixed, but don't reintroduce)

The rollout step in `.github/workflows/build-images.yml` pipes the deploy script to `ssh ... 'bash -se'` over stdin. Any `docker compose exec -T <svc> <cmd>` inside that script will consume bash's stdin (the script body itself) and silently truncate the rest of the deploy — bash hits EOF and exits 0, the workflow reports success, but the nginx restart and `dbmate up` never ran. This was caught after the EDGAR shelf migration's CI run reported success but the column didn't actually exist on the droplet.

**Every `docker compose exec` in the deploy script must end with `</dev/null`.** Two call sites exist today (the nginx `nginx -t` check and the migration-verification `psql ... select count(*) from schema_migrations`) — both are redirected. If you add a third, add `</dev/null` or you'll reintroduce the silent-truncation bug.
