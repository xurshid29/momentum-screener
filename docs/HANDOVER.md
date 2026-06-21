# Session Handover — updated 2026-06-21

A running handover so a fresh session can continue without re-deriving context.
**Read `docs/web-dashboard.md` first** (the canonical status doc); this file is
the "where we are right now + what's open" layer on top of it. Memory files
under `…/memory/` also carry the durable facts.

**CURRENT FOCUS (2026-06-21): Trade Journal — IBKR import + P&L calendar 📅,
the first piece of the trade-journal/report system.** Built locally + verified
(builds green, integration test vs real Postgres passes, P&L matches the
operator's Tradervue to the penny) but **NOT yet committed/deployed** — operator
pushes via VPN, and `dbmate up` (new `broker_imports` + `trade_executions`
tables) runs on the CI deploy. See the top "What shipped" entry (TJ) for state +
the next step (the screener-attribution join). No new env vars. Prior focus —
the tick-feed detector 🛰️ — remains live with its own open items (entry 000000).

**CURRENT FOCUS (2026-06-18): the live tick-feed early-ignition detector 🛰️** —
built, activated, validated in prod, and Option B shipped (catches → dashboard
🛰️ LIVE TICKS section, Telegram rebalanced to high-conviction only). See the
top "What shipped" entry (000000) for the full state + the OPEN items to pick
up next (outcome tracking, re-surge suppression, baseline restart-seeding,
candidate enrichment). The detailed durable record is the [[tick_feed_scoping]]
memory. ⚠️ Process note: that work briefly looked reverted in the working tree
but was committed (`3903b9e`) — **trust the commits/origin, not the tree.**

---

## Operating norms (how the operator likes work done)

- **Measure before acting.** We have `screener_outcomes` (forward 1/3/5-day
  returns per detection) — use it to validate/kill features with data, not
  intuition. Always gate `bars_forward >= horizon`; early/small samples are a
  direction check, not a verdict.
- **Ship via CI.** Commit to `main` → GitHub Actions builds + deploys (runs
  `dbmate up`). Always: build web locally (`npm run build --workspace=apps/web`)
  AND api typecheck (`cd apps/api && npx tsc --noEmit`) before pushing — the CI
  matrix is fail-fast (a web tsc error silently cancels the api build).
- **Find the real CI run id** via `gh run list` — don't guess it.
- **Push needs VPN** (operator's region blocks GitHub port 22; the agent path
  may also be blocked — if `git push` gives "No route to host", the operator
  pushes from their own terminal with VPN on).
- **Prod = DigitalOcean droplet** `root@165.245.210.95`, `/root/projects/pnldash`,
  `docker-compose.prod.yml`. Admin login admin/123456. psql via
  `docker compose -f docker-compose.prod.yml exec -T postgres psql -U pnldash -d pnldash`.
- **Operator TZ is UTC+5** (Asia/Tashkent); the app is ET-anchored.

## Current strategy thesis (operator's, evolved 2026-06-02 → 06-12)

- **Catalyst quality is the #1 factor.** Momentum + catalyst, entered on the
  FIRST appearance, ride it, **exit when the larger pullback begins** (topping
  tails, MACD roll, heavy red volume). The exit is discretionary; the dashboard
  can only *assist*.
- **Fresh first-day names are where the edge is** — confirmed by outcomes
  (below). Multi-day "continuation" is a *negative* signal.
- Two scoring axes on news: **impact_score** (catalyst quality) and
  **hype_score** (pump/crowd potential, orthogonal — the STI +700% case).

---

## What shipped this session (newest first, all on prod unless noted)

TJ. **Trade Journal — IBKR import + Tradervue-style P&L calendar 📅 (2026-06-21, BUILT + VERIFIED LOCAL, not yet deployed).** New top-level `/journal` page (header Dashboard|Journal switch). Drag-drop an IBKR TradeLog `.tlg` → server parses + dedupes + stores; a month P&L calendar (net/gross toggle, green/red day cells with trade counts, weekly + monthly totals, month summary strip); click a day → round-trip drill-down.
   - **Model:** `broker_imports` (file meta + sha256) + `trade_executions` (one row/fill, `UNIQUE(user_id, exec_id)` → idempotent re-import). Round-trip *trades* are **derived in code** (`services/ibkr-tlg.ts` `matchTrades`), not stored — flat-to-flat per symbol, P&L `−Σamount` (`+Σcommission` net), attributed to the **exit date** (overnight holds land on close day). Routes under `/api/trades` (import/calendar/day/imports + DELETE). `express.json` limit 100kb→5mb.
   - **Validated:** reproduces the operator's Tradervue exactly — gross daily P&L matches to the penny across all 8 sample days (gross $327.88 / net $233.19); an integration test vs local Postgres confirms import → dedup (92 dupes skipped on re-upload) → calendar → drill-down. Migration applied + tested on a fresh local DB via `dbmate up`.
   - **NEXT / OPEN:** (a) **the payoff** — join trades to `screener_outcomes` + detections on `(ticker, et_date)` for per-trade screener attribution (the "analyze the whole process" report). (b) Only IBKR `.tlg` STK_TRD parsed (options/futures records ignored). (c) One overnight trade's *count* differs from Tradervue by 1 (they also tally it on the open day); P&L unaffected. (d) Deploy: commit → CI runs `dbmate up`; no new env vars.
   - Aside: **charts investigation** (can the TV embed show 1s/10s off the Databento feed?) — **no** (closed iframe fetches its own 15-min-delayed data; free embed floors at 1-min). Path = Lightweight Charts aggregating our 1s feed, but needs bar capture+SSE+persistence. Written up in web-dashboard.md "TradingView free embed widget". Deferred.

000000. **Live tick-feed early-ignition detector 🛰️ — BUILT, ACTIVATED, VALIDATED, + Option B shipped (2026-06-17→18).** Databento EQUS.MINI per-second feed catches an ignition START 30–90s before Finviz. Subscribed Standard/US-Equities ($199/mo flat, live EQUS.MINI included, $0 metered), `TICKFEED_ENABLED=true` on the droplet, stream/CRAM-auth works, healthy at scale (2.6k symbols, ~300k bars/day, no errors). **First prod win: MNTS caught 20 min before the momentum screen.** Additive edge — big wins on relvol-gated slow-burns, ties/trails on fast-starters Finviz's change gate catches.
   - **Option B (`3903b9e`, live): tick catches go to the DASHBOARD, not Telegram.** A pinned **🛰️ LIVE TICKS** section atop the Ignition sidebar (`payload.tick_catches`, blue palette, `TickItem`); `onTickCandidate` records to a `tickCatches` Map (no push), pruned when a screen catches the name up or after a 15-min TTL. **Telegram rebalanced**: 🚀 fresh-burst + 🆕 new-ignition pushes SILENCED (dormant, easy re-enable — those names already show in the sidebar); Telegram now high-conviction only (≥65 ignition, momentum strong/major catalyst, dual-signal, swing).
   - ⚠️ **Git incident (2026-06-18):** a working-tree revert of Option B briefly made the code *look* alert-only — but `3903b9e` was committed/pushed/deployed. **Check origin/commits, not just the working tree.** Tree restored + clean.
   - **STILL OPEN (next session):** (a) no forward-outcome tracking for tick catches — instrument into `screener_outcomes`-style grading to prove the edge over time; (b) HAO-style re-surge suppression — watch whether catches on already-long-visible names feel noisy; (c) deploys reset detector baselines (even web-only) — add restart-seeding like ignition/VWAP; (d) tick catches are display-only (no float/catalyst/shelf enrichment, no DB persistence). Detail in [[tick_feed_scoping]] memory + the original build entry below.

000000b. **Tick feed — original build entry (behind a flag, pre-activation).** Databento EQUS.MINI per-second feed → catch ignition START 30–90s before Finviz. Offline-validated ($0 free credit): rel-volume (not $) separates real ignitions (9.8–100× baseline) from blips (0.3–0.7×); DSY/GLXG/BYAH caught 15–90s early at far lower chg; gappers (INHD/RGNT) uncatchable; 3–5% false-fire on fizzlers. Pieces: `tick-detect.ts` (pure causal detector, verified by `scripts/verify-tick-detect.ts`), `sidecar/tickfeed.py` (official `databento` Live client — no Node client exists; fields verified vs 0.80), `tickfeed.ts` (spawns sidecar, feeds detector), `poller.onTickCandidate` (🛰️ alert, mutually exclusive w/ other alert paths), universe prior-close extension, Dockerfile (runtime → Debian slim + python3 + databento; **image built+verified locally, 767MB**). **ALL behind `TICKFEED_ENABLED` (default off).** ✅ **Go-live DONE** (subscription + flag + smoke-test all complete — see entry 000000 above). Ceiling: recovers Finviz's lag on *ramping* runners, can't catch *gappers* (the biggest movers). Full detail in web-dashboard.md + [[tick_feed_scoping]] memory.

00000. **Ignition restart-seeding + 🆕 new-ignition alert + 2 removals (2026-06-16).**
   (1) `seedIgnitionState()` on boot rebuilds `ignitionFirstSeen` + alert-dedup
   sets from today's `ignition_results` — fixes deploys flashing the whole list
   as "new" and re-blasting alerts (same restart-safe pattern as
   firstSeen/VWAP). (2) New 🆕 alert for a recently-appeared ignition (≤15 min
   old) building into the 40–64 band (chg 10–100, non-bearish, dedup/day,
   skips already-🚀/≥65) — fills the gap between fresh-burst (≤5M) and the ≥65
   alert that fires hours late. ~6–8/day; dial `NEW_IGNITION.alert_score`.
   (3) Removed Universe News tab + `/feed?universe=true`, and the Quote-Details
   Ignition sub-tab + `/ignition-history` endpoint.

0000. **Ignition float cap 15→25M (2026-06-15).** CAST (16.5M → +364%) was
   excluded from ignition entirely. 10-day study: 15–25M band runs as hard as
   2–5M, harder than 10–15M (34% vs 14% reach +40%); 25–50M falls off → 25M
   ceiling. Paired change: `IGNITION.float_max_m 15→25` + runner-score ladder
   `<25M→6` (cap + score must move together or raised names never reach the 65
   line). ~4.7 new ignition-eligible names/day. fresh-burst stays ≤5M
   (nano-float validation doesn't transfer). **Watch:** grade the 15–25M band
   vs `screener_outcomes` once mature; the 82-row study was a momentum proxy.

000. **Swing score v2 — "early volatile breakout" (2026-06-13).** Operator
   review confirmed by outcomes: old score was INVERTED (alert set ≥65 had the
   LOWEST upside, peak_5d +2.8 vs +8.4 for sub-50; mature-trend/at-high/
   tight-base rewards all backwards; ATR unscored). v2: Volatility(25, ATR%) +
   Room(15, below-52w-high) + Trigger(30, day-1/2 FRESH 15-bar-high cross +
   15-bar base + close) + Volume(15) + Trend(10 nudge, reversals allowed) +
   Catalyst(10) + Extension(−15..0) + Shelf. Alert ≥60 + fresh cross.
   Reconstruction-validated: ≥60 → peak5 +12.1, 17%≥+20, 7%≥+40, ~3.5/day.
   ⚠️ breakdown keys + flag semantics changed 2026-06-13 (broke_out = day-1
   fresh cross); old/new swing scores not comparable across the date. chg_5d
   negative everywhere — score targets peak capture, not passive holds.
   **Watch:** let new-score outcomes mature ≥5d before judging; expect ~2-4
   alerts/day.

00. **Fresh-burst alert 🚀 (2026-06-12, after the RVol study).** Catches the
   "new ticker rallying from the very beginning" case (DSY: +10→+47% before the
   screens even returned it; ignition alert structurally too slow — vol
   component needs the 5-min read, PM penalty −8 kept DSY at 64<65). New
   `pushFreshBurstAlerts` over the enriched union, first 3 min after first
   sight: float ≤5M, chg 10–80, `max(rv1m,rv5m) ≥ 8000` (or day-RVol ≥30 in
   REG — day-RVol is *useless in PM*, measured), PM+REG only, once/ticker/day.
   Plus 1-min RVol cold start (~20s, second cycle). Sim: ~12.7/day, med +13pts
   in 30min after alert, 47% ≥+15pts; catches DSY/CUPR/ASBP (+77/+76/+39).
   Knobs in `FRESH_BURST` (`poller.ts`). **Watch live alert volume the first
   PM/REG sessions — if spammy, raise `rvol_fast_min` 8000→10000 (15000 loses
   DSY).**

0. **RVol study + fixes (2026-06-12, committed after the ignition recalibration).**
   Reviewed Momentum's Heat + 5-min-RVol pipeline against an 8-day offline
   replay of prod per-cycle series (965k rows, simulation validated 0.995 vs
   stored). Found + fixed: **(a)** the "5-min" RVol anchor drifted to the 600s
   history cap for any name tracked >5 min — a ~10-min window, median **2.04×
   inflated** (⚠️ **scale break: rows before 2026-06-12 carry the old scale**;
   ignition volume tiers halved to 1500/500/250/100 to compensate); **(b)** new
   **`rel_vol_1min`** end-to-end (column, persisted both tables, alerts meta) —
   at matched alert rates it flags 43% of imminent surges vs 28% for the old
   metric, equal precision, and 1m+5m both-hot is the strongest live tell
   (59.5% vs 30.7% base); **(c)** Heat's RVol ladder was saturated (80% of rows
   cleared tier 1) — re-anchored to measured percentiles + a +6 both-windows
   burst bonus. Details in web-dashboard.md "Recent additions". **Watch:** Heat
   distribution shifts (RVol tiers now actually differentiate) and ignition
   scores for *established* names sit slightly lower on the corrected metric —
   don't re-judge the recalibration off the first day or two; the 1m/5m
   "drying-up" ratio (t1/t5 < 0.5 → cooling) is a measured candidate for a
   future exit-assist.

1. **Finviz rate-limit fix (the big one, 2026-06-11).** Swing tab was empty.
   Root cause: **Finviz Elite ceiling is ~1 req/s** (measured: a 2nd call 300ms
   after the 1st 429s), and we blew past it — daily-bars drained 60 calls/min +
   the poller's concurrent per-cycle burst. Swing (last screen each cycle) lost
   the race → 429 → empty. Fixes: daily-bars drain `1s→4s` (`daily-bars.ts`);
   **global `rateLimitGate()` in `finviz.ts` spacing ALL Finviz HTTP ≥1.1s
   apart**; typed `FinvizRateLimitError` (429 no longer silently "no rows");
   bounded swing empty-retry (2 min) in `poller.ts`. Verified: 429s ~30/min→0,
   swing repopulated. See `docs/web-dashboard.md` incident report.
   - Debug-log cleanup done 2026-06-13: the per-refresh `swing fetch —` log is
     removed; the `swing scan empty —` warn was **kept deliberately** — it
     fires only on the failure case (and now carries the fetch error).
2. **Continuation demoted → "Faders" (2026-06-11).** Outcome data: the
   continuation pattern is a NEGATIVE long signal (−2.4%/28% win over 5d vs
   +3.2%/39% for fresh names). Moved tab to last, relabeled "Faders", banner
   "already ran — fade/short, not a long entry". Logic unchanged.
3. **Momentum Heat sort + ↑VWAP-reclaim badge + Appeared column (2026-06-10).**
   Default-sorts by composite `heat` (freshness+accel+VWAP-reclaim+5m-RVol+
   news) so fresh/rising names beat stale big-Chg% leaders. `first_seen_at`
   DB-seeded on boot. New `EnrichedRow` fields: `heat`, `vwap_reclaim`,
   `first_seen_at`.
4. **hype_score (2026-06-05)**, **burned-ticker ⛔ warnings (2026-06-04)**,
   **Outcomes/backtest tab (2026-06-02)**, **forward outcome tracking
   (2026-06-02)**, watchlist v2, multi-day news — see web-dashboard.md.

---

## RESOLVED — Ignition recalibration (2026-06-12, code-complete, awaiting commit/deploy)

The operator chose **(d) dig deeper → then recalibrate runner_score**. Done.

**Where the edge concentrates** (22-day `screener_outcomes`, ignition):
- **The golden cohort**: fresh, *regular-hours* ignition up **25–100% intraday,
  no pre-market run** → **+14.9%/1d and HOLDS +14%/5d** (the only ignition slice
  that doesn't give back). The old score put it at avg ~45 (below the 58 line) —
  only 29% alerted, and the *non-alerting* ones outperformed the alerting ones.
  The score was inverted against its own best cohort.
- **PM-exhaustion**: the *same* 25–100% move that traded in PM did 0.0%/1d.
- **Catalyst TYPE, not impact**: FDA/clinical +14.6%/1d (holds 5d); dilution
  −8.3, partnership −5.0, M&A −3.4 — yet M&A/partnership were scored *bullish*
  and got positive points. High impact_score / urgency trended negative.
- **Day rel_volume** (25×+ → +4.4%/1d) predicts cleanly; the 35-pt Volume
  component keyed off `rel_vol_5min`, which is null/0 ~40% of the time.
- **Shelf penalty was inverted**: effective/active shelf names out-performed at
  1d (it's a multi-day kill-switch, not a same-session signal).

**Shipped (code-complete; typecheck + web build pass; NOT yet committed — operator
pushes via VPN):** rewrote `runner-score.ts` — Float(30) + Volume(30, max of
5-min & day-RVol ladders) + type-aware Catalyst(−15..+15) + Maturity(−25..+12,
rewards the 25–100% band) + Pre-market(−8..0) + Shelf(−5..0, active only).
Breakdown keys `earliness`/`halt` → `maturity`/`premarket`. Poller: new
`seenInPremarketToday` set (midnight-cleared), `scoreRunner` call passes
`catalyst_type` + `seen_in_premarket`, `alert_score` 58→**65**,
`alert_entry_chg_max` 40→**100**, alert bypass retied to premium catalyst
(`b.catalyst ≥ 8` = FDA/news-halt) instead of any bullish-strong/major. Web:
`RunnerScoreBreakdown` + two tooltips updated. Spec §3 rewritten.

**Validation (reconstructed new score on history):** alert set `≥65 ∨ premium
catalyst, cap 100` → **+13.9%/1d, +5.2%/5d, ~5/day** vs old `≥58, cap 40` →
+4.7%/1d, −0.4%/5d, ~8/day. Monotonic (58→+8.9, 65→+17.5, 70→+24.6). Win rate
stays ~45% — it's an **asymmetric positive-skew lottery** (median ~flat); the
recalibration concentrates the right-tail runners into the alert set and kills
the 5-day give-back. Matches the operator's "ride winners, cut losers" thesis.

**Watch after deploy:** new `screener_outcomes` rows for `screen='ignition'`
will accrue under the new score — let ≥5d mature before judging live, don't
retune off the first few days. The reconstruction used `first_change_pct` for
maturity (live uses current `change_pct` via the day's max-score cycle) — a
small in-sample/live gap to keep in mind. Queries used are in this session's
history (temp tables `ir_entry` / `scored`, joined `ignition_results` →
`screener_cycles` → `screener_outcomes`).

---

## Other deferred / known

- ✅ Swing debug-log cleanup (2026-06-13; empty-scan warn kept — failure-path
  diagnostic) · ✅ Finviz ~1 req/s recorded in CLAUDE.md · ✅ GitHub Actions
  Node 24 (checkout@v5 + `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`, opted in
  ahead of the 2026-06-16 forced default).
- **Deeper Finviz relief:** share the after-hours v=152 quote overlay across
  screens (cuts AH calls ~9→~5/cycle). Non-urgent now that the gate exists.
- **Retune from outcomes generally:** swing alert ≥65, ignition weights,
  dual-signal threshold — all first-pass guesses, now have data to tune.
- Git state at handover: `main` @ `99f3eee`, in sync, clean tree.
