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

## OPEN — the active question: review Ignition (data in hand, decision pending)

The operator asked "is Ignition really helpful / doing its job?" I pulled
`screener_outcomes`. **Verdict: real but narrow edge — NOT broken like
Continuation, but mis-framed if treated as a hold.** Data (2026-06-12):

- **runner_score predicts the 1-day move, monotonically** (its native horizon):
  `<40 → +0.4%`, `40-58 → +1.5%`, `58-75 (alert) → +2.9%`, `75-100 → +10.1%`.
  peak_5d also climbs hard with score (29%→64%). The score works.
- **Edge is 1-day only** — alert bucket: 1d +2.9% → 3d +2.7% → **5d −0.9%**.
  Spike then give-back. Correct for a scalp, wrong to hold.
- **Momentum beats Ignition** on raw return (Mom +4.5%/1d vs Ign +1.0%; same
  window). Fresh Momentum names are the better signal.
- **~42% win rate even at the alert threshold** — asymmetric (small losses,
  occasional big peak); only works with disciplined exit-into-strength.

**Decision NOT yet made.** Options presented to the operator:
- (a) Keep, reframe as scalp + lean on Heat/VWAP exit cues (+ note 5d-hold is negative).
- (b) Retune runner_score weights against 1d outcomes (have ~2000 rows).
- (c) Raise alert threshold ~58 → ~70 (75-100 bucket was +10%/1d, far better).
- (d) Dig deeper first: slice by catalyst-present, PM vs regular, float tier —
  find WHERE the edge concentrates, then target it.
- My lean: (a) + (d) — it has a genuine edge, just needs honest framing and we
  should locate where it's strongest before retuning. **Operator to choose.**

Re-run the analysis with the queries used (they're in this session's history;
the shape is `select bucket, avg(chg_1d/3d/5d), peak_5d, drawdown_5d, win
from screener_outcomes where screen='ignition' and bars_forward>=N group by`).

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
