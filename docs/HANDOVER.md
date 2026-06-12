# Session Handover — 2026-06-12

A running handover so a fresh session can continue without re-deriving context.
**Read `docs/web-dashboard.md` first** (the canonical status doc); this file is
the "where we are right now + what's open" layer on top of it. Memory files
under `…/memory/` also carry the durable facts.

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

## What shipped this session (newest first, all on prod)

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
   - ⚠️ **Two temporary debug logs still in `poller.ts` to remove**:
     `[poller] swing fetch —` (~line 605) and `[poller] swing scan empty —`
     (~line 1058).
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

- **Remove the 2 swing debug logs** (above) — small cleanup.
- **Record the ~1 req/s Finviz limit** in CLAUDE.md (currently only in this
  handover + the incident report).
- **Deeper Finviz relief:** share the after-hours v=152 quote overlay across
  screens (cuts AH calls ~9→~5/cycle). Non-urgent now that the gate exists.
- **Retune from outcomes generally:** swing alert ≥65, ignition weights,
  dual-signal threshold — all first-pass guesses, now have data to tune.
- Git state at handover: `main` @ `99f3eee`, in sync, clean tree.
